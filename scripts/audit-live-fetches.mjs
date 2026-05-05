import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { fetchJobsForSource, PROVIDER_LABELS } from "../src/lib/adapters/index.js";
import { runWithLiveFetchAuditContext } from "../src/lib/adapters/shared.js";
import { loadSourceConfig } from "../src/lib/config.js";
import { analyzeSourceFilterFunnel } from "../src/lib/search.js";
import { evaluateRecency, resolveJobRecencyFields } from "../src/lib/filters.js";

const DATA_DIR = path.join(process.cwd(), "data");
const NDJSON_PATH = path.join(DATA_DIR, "live-fetch-source-audit.ndjson");
const SUMMARY_PATH = path.join(DATA_DIR, "live-fetch-source-audit-summary.json");
const DEFAULT_CONCURRENCY = Number(process.env.JOBTRAWL_LIVE_AUDIT_CONCURRENCY || 8);
const SOURCE_TIMEOUT_MS = Number(process.env.JOBTRAWL_LIVE_AUDIT_TIMEOUT_MS || 90000);
const PROVIDER_FILTER = String(process.env.JOBTRAWL_LIVE_AUDIT_PROVIDER || "").trim().toLowerCase();
const LIMIT = Number(process.env.JOBTRAWL_LIVE_AUDIT_LIMIT || 0);
const AUDIT_FILTERS = {
  keyword: String(process.env.JOBTRAWL_LIVE_AUDIT_KEYWORD || "product manager").trim(),
  keywordScope: String(process.env.JOBTRAWL_LIVE_AUDIT_KEYWORD_SCOPE || "title_and_description").trim() || "title_and_description",
  keywordMode: String(process.env.JOBTRAWL_LIVE_AUDIT_KEYWORD_MODE || "strict").trim() || "strict",
  recency: String(process.env.JOBTRAWL_LIVE_AUDIT_RECENCY || "24h").trim() || "24h",
  usOnly: String(process.env.JOBTRAWL_LIVE_AUDIT_US_ONLY || "false").trim().toLowerCase() === "true",
  arrangements: [],
  includedCompanies: [],
  excludedCompanies: [],
  locationGroups: [],
  locationMode: "",
  distanceMiles: null,
  userCoordinates: null,
};

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const allSources = await loadSourceConfig();
  const filteredSources = allSources.filter((source) => {
    if (!PROVIDER_FILTER) {
      return true;
    }
    return String(source?.provider || "").trim().toLowerCase() === PROVIDER_FILTER;
  });
  const limitedSources = LIMIT > 0 ? filteredSources.slice(0, LIMIT) : filteredSources;
  const sources = [...limitedSources].sort((left, right) => (
    String(left?.provider || "").localeCompare(String(right?.provider || ""))
    || String(left?.company || "").localeCompare(String(right?.company || ""))
    || String(left?.key || "").localeCompare(String(right?.key || ""))
  ));

  const stream = createWriteStream(NDJSON_PATH, { flags: "w", encoding: "utf8" });
  const startedAt = new Date().toISOString();
  const summary = {
    startedAt,
    finishedAt: null,
    totalSources: sources.length,
    completedSources: 0,
    succeededSources: 0,
    failedSources: 0,
    providerCounts: {},
    statusCounts: {},
    rawJobCountAvailableSources: 0,
    parsedJobCountTotal: 0,
    rawJobCountTotal: 0,
    sourcesWithoutRequests: 0,
    auditFilters: AUDIT_FILTERS,
  };

  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, DEFAULT_CONCURRENCY) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= sources.length) {
        return;
      }

      const source = sources[currentIndex];
      const result = await auditSource(source, currentIndex + 1, sources.length);
      stream.write(`${JSON.stringify(result)}\n`);
      updateSummary(summary, result);

      if (summary.completedSources % 100 === 0 || summary.completedSources === sources.length) {
        process.stdout.write(
          `[live-audit] ${summary.completedSources}/${sources.length} complete `
          + `(ok=${summary.succeededSources}, failed=${summary.failedSources})\n`
        );
      }
    }
  });

  try {
    await Promise.all(workers);
  } finally {
    await new Promise((resolve) => stream.end(resolve));
  }

  summary.finishedAt = new Date().toISOString();
  await writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  process.stdout.write(
    `[live-audit] complete: ${summary.completedSources}/${summary.totalSources}, `
    + `ok=${summary.succeededSources}, failed=${summary.failedSources}\n`
  );
}

async function auditSource(source, index, total) {
  const context = {
    sourceKey: source?.key || null,
    requests: [],
    summary: {},
  };
  const startedAt = new Date().toISOString();

  try {
    const jobs = await withSourceTimeout(
      runWithLiveFetchAuditContext(context, async () => fetchJobsForSource(source, {})),
      SOURCE_TIMEOUT_MS
    );

    return buildResult({
      source,
      index,
      total,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: true,
      jobs,
      context,
      error: null,
    });
  } catch (error) {
    return buildResult({
      source,
      index,
      total,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      jobs: [],
      context,
      error,
    });
  }
}

async function withSourceTimeout(promise, timeoutMs) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error(`Source audit timed out after ${timeoutMs}ms`);
        error.code = "SOURCE_AUDIT_TIMEOUT";
        reject(error);
      }, timeoutMs).unref?.();
    }),
  ]);
}

function buildResult({ source, index, total, startedAt, finishedAt, ok, jobs, context, error }) {
  const requests = Array.isArray(context?.requests) ? context.requests : [];
  const statuses = requests.map((entry) => entry?.status).filter((value) => Number.isFinite(value));
  const firstRequest = requests[0] || null;
  const summary = context?.summary && typeof context.summary === "object" ? context.summary : {};
  const parsedJobCount = Array.isArray(jobs) ? jobs.length : 0;
  const hasExplicitRawCount = Number.isFinite(summary.rawJobCount);
  const rawJobCount = hasExplicitRawCount
    ? summary.rawJobCount
    : requests.length > 0 ? parsedJobCount : null;
  const rawJobCountBasis = hasExplicitRawCount
    ? summary.rawJobCountBasis || null
    : requests.length > 0 ? "parsed_jobs_fallback" : null;
  const funnel = analyzeSourceFilterFunnel(jobs, AUDIT_FILTERS);
  const stageCounts = {
    fetched: rawJobCount,
    ...(funnel?.stageCounts || {}),
  };
  const stageFlags = buildStageDropFlags(stageCounts);
  const recencyCounts = buildRecencyCounts(jobs);
  const dateFilterIssue = classifyDateFilterIssue(recencyCounts);
  const failure = classifySourceFailure({
    ok,
    rawJobCount,
    parsedJobCount,
    requests,
    error,
  });
  const auditStatus = failure ? "FAIL" : "PASS";

  return {
    source: {
      index,
      total,
      key: source?.key || null,
      company: source?.company || null,
      provider: source?.provider || null,
      providerLabel: PROVIDER_LABELS[source?.provider] || source?.provider || null,
      inventorySource: source?.inventorySource || "curated",
      careersUrl: source?.careersUrl || null,
    },
    startedAt,
    finishedAt,
    ok,
    auditStatus,
    endpointOrUrlUsed: firstRequest?.url || source?.careersUrl || null,
    httpStatus: statuses.length === 1 ? statuses[0] : statuses,
    responseSize: firstRequest?.responseSize ?? null,
    rawJobCount,
    rawJobCountBasis,
    parsedJobCount,
    dateDebug: buildDateDebug(jobs),
    recencyCounts,
    stageCounts,
    stageFlags,
    keywordAudit: funnel?.keywordAudit || null,
    dateFilterIssue,
    failure,
    requestCount: requests.length,
    requests,
    error: error
      ? {
        message: String(error?.message || error),
        code: error?.code || null,
        status: error?.status || null,
      }
      : null,
  };
}

function buildStageDropFlags(stageCounts = {}) {
  const order = ["fetched", "parsed", "normalized", "dateFiltered", "keywordFiltered", "deduped", "final"];
  const flags = [];

  for (let index = 1; index < order.length; index += 1) {
    const previousKey = order[index - 1];
    const currentKey = order[index];
    const previousValue = Number(stageCounts?.[previousKey]);
    const currentValue = Number(stageCounts?.[currentKey]);
    if (!Number.isFinite(previousValue) || previousValue <= 0 || !Number.isFinite(currentValue)) {
      continue;
    }

    const dropCount = previousValue - currentValue;
    const dropRatio = dropCount / previousValue;
    if (dropRatio > 0.5) {
      flags.push({
        stage: currentKey,
        previousStage: previousKey,
        previousCount: previousValue,
        currentCount: currentValue,
        dropCount,
        dropRatio,
      });
    }
  }

  return flags;
}

function classifySourceFailure({ ok, rawJobCount, parsedJobCount, requests, error }) {
  const normalizedRequests = Array.isArray(requests) ? requests : [];
  const statuses = normalizedRequests
    .map((entry) => Number(entry?.status))
    .filter((value) => Number.isFinite(value));
  const firstStatus = statuses[0] ?? Number(error?.status);
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();

  if (code === "source_audit_timeout" || message.includes("timed out") || message.includes("timeout")) {
    return {
      category: "timeout",
      detail: `Live fetch exceeded ${SOURCE_TIMEOUT_MS}ms before the source finished responding or parsing`,
    };
  }

  if (statuses.some((status) => status === 401 || status === 407)) {
    return {
      category: "auth required",
      detail: `Live request returned ${statuses.find((status) => status === 401 || status === 407)}, which indicates authentication is required`,
    };
  }

  if (statuses.some((status) => status === 403 || status === 429 || status === 406 || status === 451)) {
    return {
      category: "blocked request",
      detail: `Live request returned ${statuses.find((status) => status === 403 || status === 429 || status === 406 || status === 451)}, which suggests the request was blocked or rate limited`,
    };
  }

  if (statuses.some((status) => status === 400 || status === 404 || status === 410 || status === 422)) {
    return {
      category: "invalid endpoint",
      detail: `Live request returned ${statuses.find((status) => status === 400 || status === 404 || status === 410 || status === 422)}, which indicates the configured endpoint or board URL is invalid`,
    };
  }

  if (!ok) {
    return {
      category: "parser broken",
      detail: error?.message
        ? `Source fetch failed after a live response path was attempted: ${error.message}`
        : "Source fetch failed before jobs could be parsed",
    };
  }

  if (Number(rawJobCount) > 0 && Number(parsedJobCount) === 0) {
    return {
      category: "parser broken",
      detail: `The live source exposed ${rawJobCount} raw jobs, but normalization produced 0 parsed jobs`,
    };
  }

  if (Number(rawJobCount) === 0 || Number(parsedJobCount) === 0) {
    const contentTypes = new Set(normalizedRequests.map((entry) => String(entry?.contentType || "").toLowerCase()).filter(Boolean));
    const hasJson = [...contentTypes].some((value) => value.includes("json"));
    return {
      category: hasJson ? "structure changed" : "structure changed",
      detail: firstStatus
        ? `Live request returned ${firstStatus}, but the response produced 0 jobs; the page or feed structure no longer matches the current extractor`
        : "The live source produced 0 jobs, which suggests the page or feed structure changed or the board is no longer exposing jobs in the expected format",
    };
  }

  return null;
}

function buildRecencyCounts(jobs) {
  const normalizedJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const evaluations24h = normalizedJobs.map((job) => evaluateRecency(job, "24h"));
  const evaluations7d = normalizedJobs.map((job) => evaluateRecency(job, "7d"));
  const within7d = evaluations7d.filter((entry) => entry.matches && entry.reason === "within_window").length;
  const within24h = evaluations24h.filter((entry) => entry.matches && entry.reason === "within_window").length;
  const unknownDate = evaluations24h.filter((entry) => entry.reason === "unknown_date").length;
  const droppedAsOld = evaluations24h.filter((entry) => entry.reason === "old").length;
  const droppedAsInvalidDate = evaluations24h.filter((entry) => entry.reason === "invalid_date" && !entry.matches).length;
  return {
    within7d,
    within24h,
    unknownDate,
    droppedAsOld,
    droppedAsInvalidDate,
  };
}

function classifyDateFilterIssue(recencyCounts = {}) {
  const within7d = Number(recencyCounts.within7d || 0);
  const within24h = Number(recencyCounts.within24h || 0);
  if (within7d < 5) {
    return null;
  }

  const ratio = within7d > 0 ? within24h / within7d : 0;
  if (within24h <= 1 || ratio <= 0.1) {
    return {
      flagged: true,
      detail: `Source has ${within7d} jobs within 7 days but only ${within24h} within 24 hours, so recency/date filtering is likely eliminating most of its results`,
      within7d,
      within24h,
      ratio,
    };
  }

  return null;
}

function buildDateDebug(jobs) {
  const sample = Array.isArray(jobs) ? jobs.slice(0, 5) : [];
  return sample.map((job) => {
    const resolved = resolveJobRecencyFields(job);
    return {
      title: job?.title || null,
      rawPostedDate: resolved.rawPostedDate,
      rawUpdatedDate: resolved.rawUpdatedDate,
      rawFirstSeenDate: resolved.rawFirstSeenDate,
      postedDate: resolved.postedDate,
      updatedDate: resolved.updatedDate,
      firstSeenDate: resolved.firstSeenDate,
      parsedRecencyDate: resolved.parsedRecencyDate,
      dateStatus: resolved.dateStatus,
      invalidDate: resolved.invalidDate,
    };
  });
}

function updateSummary(summary, result) {
  summary.completedSources += 1;
  if (result.auditStatus === "PASS") {
    summary.succeededSources += 1;
  } else {
    summary.failedSources += 1;
  }

  const provider = String(result?.source?.provider || "unknown");
  summary.providerCounts[provider] = (summary.providerCounts[provider] || 0) + 1;
  const auditStatus = String(result?.auditStatus || "UNKNOWN");
  summary.statusCounts[auditStatus] = (summary.statusCounts[auditStatus] || 0) + 1;

  const statuses = Array.isArray(result?.httpStatus)
    ? result.httpStatus
    : Number.isFinite(result?.httpStatus) ? [result.httpStatus] : [];
  for (const status of statuses) {
    const key = `http_${String(status)}`;
    summary.statusCounts[key] = (summary.statusCounts[key] || 0) + 1;
  }

  if (Number.isFinite(result?.rawJobCount)) {
    summary.rawJobCountAvailableSources += 1;
    summary.rawJobCountTotal += Number(result.rawJobCount || 0);
  }

  summary.parsedJobCountTotal += Number(result?.parsedJobCount || 0);

  if (!Number(result?.requestCount || 0)) {
    summary.sourcesWithoutRequests += 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
