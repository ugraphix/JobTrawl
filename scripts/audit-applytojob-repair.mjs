import { writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchHostedBoardJobs } from "../src/lib/adapters/hosted-board.js";
import { fetchApplyToJobJobs } from "../src/lib/adapters/applytojob.js";
import { runWithLiveFetchAuditContext } from "../src/lib/adapters/shared.js";
import { loadSourceConfig } from "../src/lib/config.js";
import { analyzeSourceFilterFunnel } from "../src/lib/search.js";

const DATA_DIR = path.join(process.cwd(), "data");
const OUTPUT_PATH = path.join(DATA_DIR, "applytojob-repair-before-after.json");
const CONCURRENCY = Number(process.env.JOBTRAWL_APPLYTOJOB_AUDIT_CONCURRENCY || 12);
const TIMEOUT_MS = Number(process.env.JOBTRAWL_APPLYTOJOB_AUDIT_TIMEOUT_MS || 90000);
const FILTERS = {
  keyword: "product manager",
  keywordScope: "title_and_description",
  keywordMode: "strict",
  recency: "24h",
  usOnly: false,
  arrangements: [],
  includedCompanies: [],
  excludedCompanies: [],
  locationGroups: [],
  locationMode: "",
  distanceMiles: null,
  userCoordinates: null,
};

async function main() {
  const allSources = await loadSourceConfig();
  const sources = allSources.filter((source) => String(source?.provider || "").trim().toLowerCase() === "applytojob");

  const before = await auditApplyToJobBefore(sources);
  const after = await loadAfterAudit();

  const report = {
    generatedAt: new Date().toISOString(),
    filters: FILTERS,
    topRecurringPageShapesBefore: [...before.pageShapeCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([shape, count]) => ({ shape, count })),
    before,
    after,
    delta: buildDelta(before, after),
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function auditApplyToJobBefore(sources) {
  const aggregate = {
    configuredSources: sources.length,
    active_with_jobs: 0,
    valid_empty: 0,
    invalid_endpoint: 0,
    parser_gap: 0,
    blocked: 0,
    stale_candidate: 0,
    parsedJobs: 0,
    jobsEnteringDateFilter: 0,
    jobsEnteringKeywordFilter: 0,
    finalPmMatches: 0,
    pageShapeCounts: new Map(),
  };

  let index = 0;
  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= sources.length) {
        return;
      }

      const source = sources[current];
      const row = await auditBeforeSource(source);
      aggregate[row.classification] += 1;
      aggregate.parsedJobs += row.parsedJobs;
      aggregate.jobsEnteringDateFilter += row.jobsEnteringDateFilter;
      aggregate.jobsEnteringKeywordFilter += row.jobsEnteringKeywordFilter;
      aggregate.finalPmMatches += row.finalPmMatches;
      if (row.pageShape) {
        aggregate.pageShapeCounts.set(row.pageShape, (aggregate.pageShapeCounts.get(row.pageShape) || 0) + 1);
      }

      const completed = current + 1;
      if (completed % 200 === 0 || completed === sources.length) {
        process.stdout.write(`[applytojob-before] ${completed}/${sources.length} complete\n`);
      }
    }
  });

  await Promise.all(workers);
  return aggregate;
}

async function auditBeforeSource(source) {
  const context = { sourceKey: source?.key || null, requests: [], summary: {} };
  let jobs = [];
  let adapterError = null;
  try {
    jobs = await withTimeout(
      runWithLiveFetchAuditContext(context, async () => fetchHostedBoardJobs(source, {})),
      TIMEOUT_MS
    );
  } catch (error) {
    adapterError = {
      message: String(error?.message || error),
      code: error?.code || null,
      status: Number(error?.status) || null,
    };
  }

  const inspection = await inspectApplyToJobSource(source, context, adapterError);
  const funnel = analyzeSourceFilterFunnel(jobs, FILTERS);
  return {
    classification: classifyBefore(source, jobs, adapterError, context, inspection),
    parsedJobs: Array.isArray(jobs) ? jobs.length : 0,
    jobsEnteringDateFilter: Number(funnel?.stageCounts?.normalized || 0),
    jobsEnteringKeywordFilter: Number(funnel?.stageCounts?.dateFiltered || 0),
    finalPmMatches: Number(funnel?.stageCounts?.final || 0),
    pageShape: classifyPageShape(inspection),
  };
}

async function inspectApplyToJobSource(source, context, adapterError) {
  const endpoint = String(source?.careersUrl || "").trim();
  if (adapterError) {
    return {
      endpointOrUrlUsed: endpoint,
      httpStatus: summarizeStatuses(context.requests, adapterError),
      explicitNoOpenings: false,
      hasJobListMarkers: false,
      hasJsonLd: false,
      hasApplyLinks: false,
      hasListCardItems: false,
      hasAnyJobMarkers: false,
    };
  }

  const response = await fetch(endpoint, {
    headers: { "user-agent": "Mozilla/5.0 JobTrawl ApplyToJob audit" },
  }).then(async (res) => ({
    status: res.status,
    text: await res.text(),
  })).catch(() => ({
    status: summarizeStatuses(context.requests, null),
    text: "",
  }));

  const html = response.text;
  const hasListCardItems = /<li class=["']list-group-item["'][^>]*>\s*<h3[^>]*class=["'][^"']*list-group-item-heading/i.test(html);
  const hasJobListMarkers = /\bjobs-list\b|\bcurrent openings\b|\bopen positions\b/i.test(html);
  const hasJsonLd = /application\/ld\+json/i.test(html) && /JobPosting/i.test(html);
  const hasApplyLinks = /href=["'][^"']*\/apply\/[^"']+["']/i.test(html);
  const explicitNoOpenings = /there are no open positions at this time|no current job openings|there are no current openings|no openings at this time|no open positions/i.test(html);

  return {
    endpointOrUrlUsed: endpoint,
    httpStatus: response.status || summarizeStatuses(context.requests, null),
    explicitNoOpenings,
    hasJobListMarkers,
    hasJsonLd,
    hasApplyLinks,
    hasListCardItems,
    hasAnyJobMarkers: hasJobListMarkers || hasJsonLd || hasApplyLinks,
  };
}

function classifyBefore(source, jobs, adapterError, context, inspection) {
  const parsedJobCount = Array.isArray(jobs) ? jobs.length : 0;
  const status = normalizeStatusCode(inspection.httpStatus ?? summarizeStatuses(context.requests, adapterError));

  if (status === 403 || status === 429 || status === 406 || status === 451) {
    return "blocked";
  }

  if ([400, 404, 410, 422].includes(status)) {
    return "invalid_endpoint";
  }

  if (parsedJobCount > 0) {
    return "active_with_jobs";
  }

  if (adapterError) {
    return "parser_gap";
  }

  if (inspection.hasJobListMarkers || inspection.hasJsonLd) {
    return "parser_gap";
  }

  if (inspection.explicitNoOpenings) {
    return "valid_empty";
  }

  return isGeneratedInventory(source) ? "stale_candidate" : "valid_empty";
}

function classifyPageShape(inspection) {
  if (inspection.explicitNoOpenings) {
    return "explicit_empty_jobs_list";
  }
  if (inspection.hasListCardItems) {
    return "list_group_item_cards";
  }
  if (inspection.hasApplyLinks || inspection.hasJsonLd) {
    return "structured_apply_links";
  }
  return "no_job_markers";
}

async function loadAfterAudit() {
  const fs = await import("node:fs/promises");
  const summaryPath = path.join(DATA_DIR, "stale-empty-source-audit-summary.json");
  const ndjsonPath = path.join(DATA_DIR, "stale-empty-source-audit.ndjson");
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  const lines = (await fs.readFile(ndjsonPath, "utf8")).split(/\r?\n/).filter(Boolean);
  const rows = lines.map((line) => JSON.parse(line)).filter((row) => row?.source?.provider === "applytojob");
  const family = summary?.byFamily?.applytojob || {};

  return {
    configuredSources: Number(family.totalConfigured || 0),
    active_with_jobs: Number(family.active_with_jobs || 0),
    valid_empty: Number(family.valid_empty || 0),
    invalid_endpoint: Number(family.invalid_endpoint || 0),
    parser_gap: Number(family.parser_gap || 0),
    blocked: Number(family.blocked || 0),
    stale_candidate: Number(family.stale_candidate || 0),
    parsedJobs: rows.reduce((sum, row) => sum + Number(row?.parsedJobCount || 0), 0),
    jobsEnteringDateFilter: rows.reduce((sum, row) => sum + Number(row?.stageCounts?.normalized || 0), 0),
    jobsEnteringKeywordFilter: rows.reduce((sum, row) => sum + Number(row?.stageCounts?.dateFiltered || 0), 0),
    finalPmMatches: rows.reduce((sum, row) => sum + Number(row?.pmMatches || 0), 0),
  };
}

function buildDelta(before, after) {
  const fields = [
    "configuredSources",
    "active_with_jobs",
    "valid_empty",
    "invalid_endpoint",
    "parser_gap",
    "blocked",
    "stale_candidate",
    "parsedJobs",
    "jobsEnteringDateFilter",
    "jobsEnteringKeywordFilter",
    "finalPmMatches",
  ];

  return Object.fromEntries(fields.map((field) => [field, Number(after[field] || 0) - Number(before[field] || 0)]));
}

function summarizeStatuses(requests, adapterError) {
  const statuses = Array.isArray(requests)
    ? requests.map((entry) => Number(entry?.status)).filter((value) => Number.isFinite(value))
    : [];
  if (statuses.length === 0) {
    return Number(adapterError?.status) || null;
  }
  return statuses[statuses.length - 1];
}

function normalizeStatusCode(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isGeneratedInventory(source) {
  const inventorySource = String(source?.inventorySource || "").trim().toLowerCase();
  return inventorySource.includes("generated")
    || inventorySource.includes("openlistings")
    || inventorySource.includes("bsearch");
}

async function withTimeout(promise, timeoutMs) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`applytojob legacy audit timed out after ${timeoutMs}ms`);
        error.code = "APPLYTOJOB_AUDIT_TIMEOUT";
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
