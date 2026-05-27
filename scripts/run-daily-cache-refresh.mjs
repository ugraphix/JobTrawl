import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const REPORT_PATH = path.join(process.cwd(), "data", "daily-cache-refresh-report.json");
const DEFAULT_PROFILE = "daily";
const DEFAULT_KEYWORD = "product manager";
const DEFAULT_TIMEOUT_RATE = 0.15;
const DEFAULT_FAILURE_RATE = 0.10;
const SEARCH_TIMEOUT_MS = 90_000;

const TARGETED_SOURCE_KEY_FILES = [
  "data/verified-us-pm-next-target-source-keys.txt",
  "data/workday-verified-us-pm-target-source-keys.txt",
];

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const batches = buildBatches(options);
  const plannedBatches = batches.map((batch) => describeBatch(batch));
  const report = {
    timestamp: new Date().toISOString(),
    profile: options.profile,
    mode: options.run ? "run" : "plan",
    keyword: options.keyword,
    thresholds: {
      maxTimeoutRate: options.maxTimeoutRate,
      maxFailureRate: options.maxFailureRate,
      stopOnHighFailure: options.stopOnHighFailure,
    },
    batchesPlanned: plannedBatches,
    batchesRun: [],
    batchResults: [],
    validationResults: null,
    stoppedEarly: false,
    stopReason: null,
  };

  printPlan(options, plannedBatches);

  if (!options.run) {
    await writeReport(report);
    console.log(`\nPlan only. Re-run with --run to execute. Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
    return;
  }

  for (const batch of batches) {
    if (batch.skipReason) {
      console.log(`\nSkipping ${batch.label}: ${batch.skipReason}`);
      continue;
    }

    console.log(`\nRunning ${batch.label}`);
    console.log(`Command: ${formatCommand(buildWarmCommandArgs(batch))}`);
    const startedAt = Date.now();
    const warmResult = await runWarmBatch(batch);
    const batchResult = {
      ...describeBatch(batch),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      exitCode: warmResult.exitCode,
      error: warmResult.error,
      summary: warmResult.summary,
      parsedSummary: summarizeWarmOutput(warmResult.summary),
    };
    report.batchesRun.push(batchResult.label);
    report.batchResults.push(batchResult);

    printBatchResult(batchResult);

    if (warmResult.exitCode !== 0) {
      report.stoppedEarly = true;
      report.stopReason = `${batch.label} exited with code ${warmResult.exitCode}`;
      break;
    }

    const safetyStop = evaluateSafetyStop(batchResult.parsedSummary, options);
    if (safetyStop) {
      report.stoppedEarly = true;
      report.stopReason = safetyStop;
      console.log(`Stopping before next batch: ${safetyStop}`);
      break;
    }
  }

  if (!report.stoppedEarly) {
    report.validationResults = await runPostRefreshValidation(options.keyword);
    printValidation(report.validationResults);
  }

  await writeReport(report);
  console.log(`\nRefresh report written to ${path.relative(process.cwd(), REPORT_PATH)}`);
}

function parseArgs(argv) {
  const options = {
    run: false,
    plan: false,
    profile: DEFAULT_PROFILE,
    keyword: DEFAULT_KEYWORD,
    stopOnHighFailure: true,
    maxTimeoutRate: DEFAULT_TIMEOUT_RATE,
    maxFailureRate: DEFAULT_FAILURE_RATE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    if (arg === "--run") {
      options.run = true;
    } else if (arg === "--plan") {
      options.plan = true;
    } else if (arg === "--profile") {
      options.profile = normalizeProfile(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--profile=")) {
      options.profile = normalizeProfile(arg.split("=").slice(1).join("="));
    } else if (arg === "--keyword") {
      options.keyword = String(argv[index + 1] || "").trim() || DEFAULT_KEYWORD;
      index += 1;
    } else if (arg.startsWith("--keyword=")) {
      options.keyword = String(arg.split("=").slice(1).join("=") || "").trim() || DEFAULT_KEYWORD;
    } else if (arg === "--stop-on-high-failure") {
      options.stopOnHighFailure = true;
    } else if (arg === "--max-timeout-rate") {
      options.maxTimeoutRate = normalizeRate(argv[index + 1], DEFAULT_TIMEOUT_RATE);
      index += 1;
    } else if (arg.startsWith("--max-timeout-rate=")) {
      options.maxTimeoutRate = normalizeRate(arg.split("=").slice(1).join("="), DEFAULT_TIMEOUT_RATE);
    } else if (arg === "--max-failure-rate") {
      options.maxFailureRate = normalizeRate(argv[index + 1], DEFAULT_FAILURE_RATE);
      index += 1;
    } else if (arg.startsWith("--max-failure-rate=")) {
      options.maxFailureRate = normalizeRate(arg.split("=").slice(1).join("="), DEFAULT_FAILURE_RATE);
    }
  }

  return options;
}

function normalizeProfile(value) {
  const profile = String(value || "").trim().toLowerCase();
  if (["daily", "weekly", "targeted"].includes(profile)) {
    return profile;
  }
  return DEFAULT_PROFILE;
}

function normalizeRate(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return number > 1 ? number / 100 : number;
}

function buildBatches(options) {
  if (options.profile === "targeted") {
    return buildTargetedBatches();
  }

  const daily = [
    providerBatch("greenhouse", { limit: 40 }),
    providerBatch("getro", { limit: 60, strategy: "keyword-priority", keyword: options.keyword }),
    providerBatch("careerpuck", { limit: 50, strategy: "keyword-priority", keyword: options.keyword }),
    providerBatch("lever", { limit: 150, strategy: "keyword-priority", keyword: options.keyword }),
  ];

  if (options.profile === "weekly") {
    return [
      ...daily,
      providerBatch("ashby", { limit: 150, strategy: "keyword-priority", keyword: options.keyword }),
      providerBatch("bamboohr", { limit: 500, strategy: "keyword-priority", keyword: options.keyword }),
    ];
  }

  return daily;
}

function buildTargetedBatches() {
  return TARGETED_SOURCE_KEY_FILES.map((filePath) => {
    const exists = existsSync(path.resolve(process.cwd(), filePath));
    return {
      type: "source-key-file",
      label: `source-key-file:${filePath}`,
      sourceKeyFile: filePath,
      timeoutMs: 60_000,
      force: true,
      skipReason: exists ? "" : `source-key file not found: ${filePath}`,
    };
  });
}

function providerBatch(provider, { limit, strategy = "", keyword = "" }) {
  return {
    type: "provider",
    label: `provider:${provider}`,
    provider,
    limit,
    strategy,
    keyword,
    force: true,
  };
}

function describeBatch(batch) {
  return {
    label: batch.label,
    type: batch.type,
    provider: batch.provider || null,
    limit: batch.limit || null,
    strategy: batch.strategy || null,
    keyword: batch.keyword || null,
    sourceKeyFile: batch.sourceKeyFile || null,
    timeoutMs: batch.timeoutMs || null,
    force: Boolean(batch.force),
    skipReason: batch.skipReason || null,
    command: formatCommand(buildWarmCommandArgs(batch)),
  };
}

function buildWarmCommandArgs(batch) {
  const args = ["scripts/warm-ats-source-cache.mjs"];
  if (batch.type === "provider") {
    args.push("--provider", batch.provider, "--limit", String(batch.limit));
    if (batch.strategy) {
      args.push("--strategy", batch.strategy);
    }
    if (batch.keyword) {
      args.push("--keyword", batch.keyword);
    }
  } else if (batch.type === "source-key-file") {
    args.push("--source-key-file", batch.sourceKeyFile, "--timeout-ms", String(batch.timeoutMs));
  }
  if (batch.force) {
    args.push("--force");
  }
  return args;
}

function formatCommand(args) {
  return ["node", ...args.map((arg) => quoteArg(arg))].join(" ");
}

function quoteArg(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

async function runWarmBatch(batch) {
  const args = buildWarmCommandArgs(batch);
  const output = await runNodeCommand(args, { timeoutMs: 0 });
  return {
    ...output,
    summary: parseJsonFromStdout(output.stdout),
  };
}

function runNodeCommand(args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (!settled) {
            child.kill();
          }
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, error: exitCode === 0 ? null : stderr.trim() || stdout.trim() });
    });
    child.on("error", (error) => {
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr, error: error.message });
    });
  });
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout || "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
  }
  return null;
}

function summarizeWarmOutput(summary) {
  const live = summary?.liveSummary || {};
  const classifications = live.classifications || {};
  return {
    selectedSources: Number(live.selectedSources || summary?.totals?.selectedSources || 0),
    completedSources: Number(live.completedSources || 0),
    sourcesWarmed: Number(live.sourcesWarmed || 0),
    activeWithJobs: Number(classifications.active_with_jobs || 0),
    validEmpty: Number(classifications.valid_empty || 0),
    invalidEndpoint: Number(classifications.invalid_endpoint || 0),
    parserGap: Number(classifications.parser_gap || 0),
    blocked: Number(classifications.blocked || 0),
    rateLimited: Number(classifications.rate_limited || 0),
    timeout: Number(classifications.timeout || 0),
    failed: Number(classifications.failed || 0),
    parsedJobsAdded: Number(live.parsedJobsAdded || 0),
  };
}

function evaluateSafetyStop(summary, options) {
  if (!options.stopOnHighFailure || !summary) {
    return "";
  }
  const completed = Math.max(1, Number(summary.completedSources || 0));
  const timeoutRate = Number(summary.timeout || 0) / completed;
  const failureRate = (
    Number(summary.failed || 0)
    + Number(summary.invalidEndpoint || 0)
    + Number(summary.parserGap || 0)
    + Number(summary.blocked || 0)
    + Number(summary.rateLimited || 0)
  ) / completed;

  if (timeoutRate > options.maxTimeoutRate) {
    return `timeout rate ${(timeoutRate * 100).toFixed(1)}% exceeded threshold ${(options.maxTimeoutRate * 100).toFixed(1)}%`;
  }
  if (failureRate > options.maxFailureRate) {
    return `failure rate ${(failureRate * 100).toFixed(1)}% exceeded threshold ${(options.maxFailureRate * 100).toFixed(1)}%`;
  }
  return "";
}

async function runPostRefreshValidation(keyword) {
  const scenarios = [
    ["A", "loose default settings", { keywordMode: "loose", recency: "7d", usOnly: false }],
    ["B", "loose 7d U.S.-only", { keywordMode: "loose", recency: "7d", usOnly: true }],
    ["C", "loose 24h U.S.-only", { keywordMode: "loose", recency: "24h", usOnly: true }],
    ["D", "strict 7d U.S.-only", { keywordMode: "strict", recency: "7d", usOnly: true }],
  ];
  const results = [];

  for (const [label, name, options] of scenarios) {
    results.push(await runSearchValidationScenario(label, name, keyword, options));
  }

  return {
    endpoint: "http://localhost:3001/api/search",
    scenarios: results,
    note: results.some((result) => result.error)
      ? "One or more API validation calls failed. Start the app with `node src/server.js` and rerun validation manually."
      : null,
  };
}

async function runSearchValidationScenario(label, name, keyword, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch("http://localhost:3001/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildSearchBody(keyword, options)),
      signal: controller.signal,
    });
    const payload = await response.json();
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    const confirmedUsJobs = Array.isArray(payload.confirmedUsJobs)
      ? payload.confirmedUsJobs
      : options.usOnly ? jobs : [];
    const breakdownJobs = options.usOnly ? confirmedUsJobs : jobs;
    return {
      label,
      name,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      headlineCount: payload.headlineCount,
      verifiedUsCount: options.usOnly ? payload.confirmedUsCount : null,
      unknownLocationCount: payload.unknownLocationCount,
      nonUsDroppedCount: payload.nonUsDroppedCount,
      providerBreakdown: providerBreakdown(breakdownJobs),
      suspiciousNonUsLeakage: findSuspiciousNonUsRows(confirmedUsJobs),
    };
  } catch (error) {
    return {
      label,
      name,
      elapsedMs: Date.now() - startedAt,
      error: error?.name || "Error",
      message: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildSearchBody(keyword, options) {
  return {
    keyword,
    keywordMode: options.keywordMode,
    recency: options.recency,
    usOnly: Boolean(options.usOnly),
    arrangements: [],
    locationMode: "",
    locationGroups: [],
    distanceMiles: "",
    userCoordinates: null,
    excludedCompanies: [],
    sourceSelectionMode: "all",
    sourceCustomizationMode: "ats",
    selectedAtsProviderKeys: [],
    includedCompanies: [],
  };
}

function providerBreakdown(jobs = []) {
  const counts = new Map();
  for (const job of jobs) {
    const provider = job?.provider || "unknown";
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function findSuspiciousNonUsRows(jobs = []) {
  const suspiciousPattern = /\b(india|australia|poland|canada|ireland|uk|united kingdom|israel|bulgaria|gurgaon|gurugram|bengaluru|hyderabad|toronto|vancouver|london|tel aviv)\b/i;
  return jobs
    .filter((job) => suspiciousPattern.test([
      job?.title,
      job?.company,
      job?.locationLabel,
      job?.rawLocationText,
      job?.applyUrl,
    ].filter(Boolean).join(" ")))
    .map((job) => ({
      title: job.title,
      company: job.company,
      provider: job.provider,
      sourceKey: job.sourceKey || job.source,
      locationLabel: job.locationLabel,
      rawLocationText: job.rawLocationText,
      country: job.country,
    }));
}

function printPlan(options, plannedBatches) {
  console.log(`Profile: ${options.profile}`);
  console.log(`Mode: ${options.run ? "run" : "plan/report-only"}`);
  console.log(`Keyword: ${options.keyword}`);
  console.log(`Timeout threshold: ${(options.maxTimeoutRate * 100).toFixed(1)}%`);
  console.log(`Failure threshold: ${(options.maxFailureRate * 100).toFixed(1)}%`);
  console.log("\nPlanned batches:");
  for (const [index, batch] of plannedBatches.entries()) {
    const skipped = batch.skipReason ? ` [skip: ${batch.skipReason}]` : "";
    console.log(`${index + 1}. ${batch.label}${skipped}`);
    console.log(`   ${batch.command}`);
  }
}

function printBatchResult(batchResult) {
  const summary = batchResult.parsedSummary;
  console.log(JSON.stringify({
    label: batchResult.label,
    elapsedMs: batchResult.elapsedMs,
    exitCode: batchResult.exitCode,
    ...summary,
  }, null, 2));
}

function printValidation(validation) {
  console.log("\nPost-refresh validation:");
  console.log(JSON.stringify(validation, null, 2));
}

async function writeReport(report) {
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
