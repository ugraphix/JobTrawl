import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { fetchJobsForSource, PROVIDER_LABELS } from "../src/lib/adapters/index.js";
import { runWithLiveFetchAuditContext } from "../src/lib/adapters/shared.js";
import { loadSourceConfig } from "../src/lib/config.js";
import { analyzeSourceFilterFunnel } from "../src/lib/search.js";

const DATA_DIR = path.join(process.cwd(), "data");
const NDJSON_PATH = path.join(DATA_DIR, "stale-empty-source-audit.ndjson");
const SUMMARY_PATH = path.join(DATA_DIR, "stale-empty-source-audit-summary.json");
const CONCURRENCY = Number(process.env.JOBTRAWL_STALE_AUDIT_CONCURRENCY || 12);
const TIMEOUT_MS = Number(process.env.JOBTRAWL_STALE_AUDIT_TIMEOUT_MS || 90000);
const TARGET_PROVIDERS = new Set(["greenhouse", "lever", "ashby", "applicantpro", "applytojob"]);
const AUDIT_FILTERS = {
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
  await mkdir(DATA_DIR, { recursive: true });
  const allSources = await loadSourceConfig();
  const sources = allSources
    .filter((source) => TARGET_PROVIDERS.has(String(source?.provider || "").trim().toLowerCase()))
    .sort((left, right) => (
      String(left?.provider || "").localeCompare(String(right?.provider || ""))
      || String(left?.company || "").localeCompare(String(right?.company || ""))
      || String(left?.key || "").localeCompare(String(right?.key || ""))
    ));

  const stream = createWriteStream(NDJSON_PATH, { flags: "w", encoding: "utf8" });
  const summary = {
    generatedAt: new Date().toISOString(),
    filters: AUDIT_FILTERS,
    totalConfigured: sources.length,
    byFamily: {},
  };

  let currentIndex = 0;
  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    while (true) {
      const index = currentIndex;
      currentIndex += 1;
      if (index >= sources.length) {
        return;
      }

      const record = await auditSource(sources[index], index + 1, sources.length);
      stream.write(`${JSON.stringify(record)}\n`);
      updateSummary(summary, record);

      const completed = index + 1;
      if (completed % 100 === 0 || completed === sources.length) {
        process.stdout.write(`[stale-audit] ${completed}/${sources.length} complete\n`);
      }
    }
  });

  try {
    await Promise.all(workers);
  } finally {
    await new Promise((resolve) => stream.end(resolve));
  }

  await writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`[stale-audit] summary written to ${SUMMARY_PATH}\n`);
}

async function auditSource(source, index, total) {
  const provider = String(source?.provider || "").trim().toLowerCase();
  const context = {
    sourceKey: source?.key || null,
    requests: [],
    summary: {},
  };

  let jobs = [];
  let adapterError = null;
  try {
    jobs = await withTimeout(
      runWithLiveFetchAuditContext(context, async () => fetchJobsForSource(source, {})),
      TIMEOUT_MS
    );
  } catch (error) {
    adapterError = {
      message: String(error?.message || error),
      code: error?.code || null,
      status: Number(error?.status) || null,
    };
  }

  const providerInspection = await inspectProviderSource(source, provider, context, adapterError);
  const funnel = analyzeSourceFilterFunnel(jobs, AUDIT_FILTERS);
  const classification = classifySource({
    source,
    provider,
    jobs,
    adapterError,
    context,
    providerInspection,
  });

  return {
    source: {
      index,
      total,
      key: source?.key || null,
      company: source?.company || null,
      provider,
      providerLabel: PROVIDER_LABELS[provider] || provider,
      inventorySource: source?.inventorySource || "curated",
      careersUrl: source?.careersUrl || null,
    },
    classification,
    endpointOrUrlUsed: providerInspection.endpointOrUrlUsed || context.requests?.[0]?.url || source?.careersUrl || null,
    httpStatus: providerInspection.httpStatus ?? summarizeStatuses(context.requests, adapterError),
    parsedJobCount: Array.isArray(jobs) ? jobs.length : 0,
    rawJobCount: Number.isFinite(context.summary?.rawJobCount) ? context.summary.rawJobCount : providerInspection.rawJobCount ?? null,
    rawJobCountBasis: context.summary?.rawJobCountBasis || providerInspection.rawJobCountBasis || null,
    pmMatches: Number(funnel?.stageCounts?.final || 0),
    stageCounts: funnel?.stageCounts || {},
    providerInspection,
    adapterError,
  };
}

async function inspectProviderSource(source, provider, context, adapterError) {
  switch (provider) {
    case "greenhouse":
      return await inspectGreenhouseSource(source, context, adapterError);
    case "lever":
      return await inspectLeverSource(source, context, adapterError);
    case "ashby":
      return await inspectAshbySource(source, context, adapterError);
    case "applicantpro":
      return await inspectApplicantProSource(source, context, adapterError);
    case "applytojob":
      return await inspectApplyToJobSource(source, context, adapterError);
    default:
      return {};
  }
}

async function inspectGreenhouseSource(source, context, adapterError) {
  const boardToken = source.boardToken || source.slug;
  const url = `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`;
  if (adapterError) {
    return {
      endpointOrUrlUsed: url,
      httpStatus: summarizeStatuses(context.requests, adapterError),
      rawJobCount: 0,
      rawJobCountBasis: "greenhouse_jobs_array",
      bodyShape: "error",
    };
  }

  const status = summarizeStatuses(context.requests, null);
  const rawJobCount = Number.isFinite(context.summary?.rawJobCount) ? context.summary.rawJobCount : null;
  return {
    endpointOrUrlUsed: url,
    httpStatus: status,
    rawJobCount,
    rawJobCountBasis: "greenhouse_jobs_array",
    bodyShape: rawJobCount === 0 ? "jobs_empty" : "jobs_array",
  };
}

async function inspectLeverSource(source, context, adapterError) {
  const site = source.site || source.slug;
  const url = `https://api.lever.co/v0/postings/${site}?mode=json`;
  if (adapterError) {
    return {
      endpointOrUrlUsed: url,
      httpStatus: summarizeStatuses(context.requests, adapterError),
      rawJobCount: 0,
      rawJobCountBasis: "lever_postings_array",
      bodyShape: "error",
    };
  }

  const rawJobCount = Number.isFinite(context.summary?.rawJobCount) ? context.summary.rawJobCount : null;
  return {
    endpointOrUrlUsed: url,
    httpStatus: summarizeStatuses(context.requests, null),
    rawJobCount,
    rawJobCountBasis: "lever_postings_array",
    bodyShape: rawJobCount === 0 ? "empty_array" : "jobs_array",
  };
}

async function inspectAshbySource(source, context, adapterError) {
  const organization = source.organization || source.slug;
  const url = `https://api.ashbyhq.com/posting-api/job-board/${organization}?includeCompensation=true`;
  if (adapterError) {
    return {
      endpointOrUrlUsed: url,
      httpStatus: summarizeStatuses(context.requests, adapterError),
      rawJobCount: 0,
      rawJobCountBasis: "ashby_jobs_array",
      bodyShape: "error",
    };
  }

  const rawJobCount = Number.isFinite(context.summary?.rawJobCount) ? context.summary.rawJobCount : null;
  return {
    endpointOrUrlUsed: url,
    httpStatus: summarizeStatuses(context.requests, null),
    rawJobCount,
    rawJobCountBasis: "ashby_jobs_array",
    bodyShape: rawJobCount === 0 ? "jobs_empty_object" : "jobs_array",
  };
}

async function inspectApplicantProSource(source, context, adapterError) {
  const careersUrl = String(source?.careersUrl || "").trim();
  const listingUrl = new URL("/jobs/view.php", careersUrl);
  listingUrl.searchParams.set("n", "jobListings");
  listingUrl.searchParams.set("f", "getListings");
  listingUrl.searchParams.set("keywords", "");
  const endpoint = listingUrl.toString();

  if (adapterError) {
    return {
      endpointOrUrlUsed: endpoint,
      httpStatus: summarizeStatuses(context.requests, adapterError),
      rawJobCount: 0,
      rawJobCountBasis: "applicantpro_listing_html",
      bodyShape: "error",
      explicitNoOpenings: false,
      hasJobMarkers: false,
    };
  }

  const html = await fetch(endpoint, {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      Referer: careersUrl,
      "user-agent": "Mozilla/5.0 JobTrawl stale audit",
    },
  }).then(async (response) => ({
    status: response.status,
    text: await response.text(),
  })).catch(() => ({ status: summarizeStatuses(context.requests, null), text: "" }));

  const hasJobMarkers = /\blist-group-item\b/i.test(html.text) && /<h4[^>]*>/i.test(html.text);
  const explicitNoOpenings = /no current job openings|sorry,\s*we have no current job openings|there are currently no openings/i.test(html.text);
  return {
    endpointOrUrlUsed: endpoint,
    httpStatus: html.status || summarizeStatuses(context.requests, null),
    rawJobCount: Number.isFinite(context.summary?.rawJobCount) ? context.summary.rawJobCount : null,
    rawJobCountBasis: "applicantpro_listing_html",
    bodyShape: explicitNoOpenings ? "explicit_empty" : hasJobMarkers ? "listing_html" : "unknown_html",
    explicitNoOpenings,
    hasJobMarkers,
  };
}

async function inspectApplyToJobSource(source, context, adapterError) {
  const endpoint = String(source?.careersUrl || "").trim();
  if (adapterError) {
    return {
      endpointOrUrlUsed: endpoint,
      httpStatus: summarizeStatuses(context.requests, adapterError),
      rawJobCount: 0,
      rawJobCountBasis: "applytojob_hosted_board_html",
      bodyShape: "error",
      hasJobListMarkers: false,
      hasJsonLd: false,
      hasAnyJobMarkers: false,
      explicitNoOpenings: false,
    };
  }

  const html = await fetch(endpoint, {
    headers: {
      "user-agent": "Mozilla/5.0 JobTrawl stale audit",
    },
  }).then(async (response) => ({
    status: response.status,
    text: await response.text(),
  })).catch(() => ({ status: summarizeStatuses(context.requests, null), text: "" }));

  const hasJobListMarkers = /\bjobs-list\b|\bcurrent openings\b|\bopen positions\b/i.test(html.text);
  const hasJsonLd = /application\/ld\+json/i.test(html.text) && /JobPosting/i.test(html.text);
  const hasAnchorApplyMarkers = /\/apply\//i.test(html.text);
  const hasAnyJobMarkers = hasJobListMarkers || hasJsonLd || hasAnchorApplyMarkers;
  const explicitNoOpenings = /no current job openings|there are no current openings|no open positions|no openings at this time/i.test(html.text);

  return {
    endpointOrUrlUsed: endpoint,
    httpStatus: html.status || summarizeStatuses(context.requests, null),
    rawJobCount: Number.isFinite(context.summary?.rawJobCount) ? context.summary.rawJobCount : null,
    rawJobCountBasis: "applytojob_hosted_board_html",
    bodyShape: explicitNoOpenings ? "explicit_empty" : hasAnyJobMarkers ? "job_markers_present" : "no_job_markers",
    hasJobListMarkers,
    hasJsonLd,
    hasAnyJobMarkers,
    explicitNoOpenings,
  };
}

function classifySource({ source, provider, jobs, adapterError, context, providerInspection }) {
  const parsedJobCount = Array.isArray(jobs) ? jobs.length : 0;
  const status = normalizeStatusCode(providerInspection.httpStatus ?? summarizeStatuses(context.requests, adapterError));
  const rawJobCount = Number.isFinite(context.summary?.rawJobCount) ? context.summary.rawJobCount : providerInspection.rawJobCount ?? 0;

  if (status === 403 || status === 429 || status === 406 || status === 451) {
    return {
      state: "blocked",
      reason: `HTTP ${status} indicates the source blocked or rate-limited the request`,
    };
  }

  if (provider === "greenhouse" && status === 404) {
    return {
      state: "invalid_endpoint",
      reason: "Greenhouse 404 means the board token is invalid or no longer exists",
    };
  }

  if ([400, 404, 410, 422].includes(status)) {
    return {
      state: "invalid_endpoint",
      reason: `HTTP ${status} indicates the configured endpoint is invalid`,
    };
  }

  if (parsedJobCount > 0) {
    return {
      state: "active_with_jobs",
      reason: `Source returned ${parsedJobCount} parsed jobs`,
    };
  }

  if (adapterError) {
    return {
      state: "parser_gap",
      reason: adapterError.message || "Source fetch/parsing failed before jobs could be normalized",
    };
  }

  if (provider === "lever" && status === 200 && rawJobCount === 0) {
    return {
      state: "valid_empty",
      reason: "Lever returned HTTP 200 with an empty postings array",
    };
  }

  if (provider === "ashby" && status === 200 && rawJobCount === 0) {
    return {
      state: "valid_empty",
      reason: "Ashby returned HTTP 200 with jobs: []",
    };
  }

  if (provider === "applicantpro") {
    if (providerInspection.explicitNoOpenings) {
      return {
        state: "valid_empty",
        reason: "ApplicantPro explicitly states there are no current job openings",
      };
    }
    if (providerInspection.hasJobMarkers) {
      return {
        state: "parser_gap",
        reason: "ApplicantPro page still exposes listing markers but parsed 0 jobs",
      };
    }
    return {
      state: isGeneratedInventory(source) ? "stale_candidate" : "valid_empty",
      reason: isGeneratedInventory(source)
        ? "ApplicantPro page has no explicit openings and no listing markers, so this generated board is a stale candidate"
        : "ApplicantPro page has no explicit openings and no listing markers",
    };
  }

  if (provider === "applytojob") {
    if (providerInspection.explicitNoOpenings) {
      return {
        state: "valid_empty",
        reason: "ApplyToJob page explicitly says there are no current openings",
      };
    }
    if (providerInspection.hasJobListMarkers || providerInspection.hasJsonLd) {
      return {
        state: "parser_gap",
        reason: "ApplyToJob page shows job-list or JSON-LD markers but parsed 0 jobs",
      };
    }
    return {
      state: isGeneratedInventory(source) ? "stale_candidate" : "valid_empty",
      reason: isGeneratedInventory(source)
        ? "ApplyToJob page has no job markers and appears to be a stale generated board"
        : "ApplyToJob page has no job markers",
    };
  }

  if (status === 200 && rawJobCount === 0) {
    return {
      state: "valid_empty",
      reason: "Source returned HTTP 200 with no jobs and no parser indicators",
    };
  }

  return {
    state: "parser_gap",
    reason: "Source did not parse jobs even though the endpoint responded",
  };
}

function isGeneratedInventory(source) {
  const inventorySource = String(source?.inventorySource || "").trim().toLowerCase();
  return inventorySource.includes("generated")
    || inventorySource.includes("openlistings")
    || inventorySource.includes("bsearch");
}

function updateSummary(summary, record) {
  const provider = String(record?.source?.provider || "unknown");
  if (!summary.byFamily[provider]) {
    summary.byFamily[provider] = {
      providerLabel: PROVIDER_LABELS[provider] || provider,
      totalConfigured: 0,
      active_with_jobs: 0,
      valid_empty: 0,
      invalid_endpoint: 0,
      parser_gap: 0,
      blocked: 0,
      stale_candidate: 0,
      pmMatches: 0,
    };
  }

  const family = summary.byFamily[provider];
  family.totalConfigured += 1;
  const state = String(record?.classification?.state || "parser_gap");
  if (Object.prototype.hasOwnProperty.call(family, state)) {
    family[state] += 1;
  }
  family.pmMatches += Number(record?.pmMatches || 0);
}

function summarizeStatuses(requests, adapterError) {
  const values = Array.isArray(requests)
    ? requests.map((entry) => Number(entry?.status)).filter((value) => Number.isFinite(value))
    : [];
  if (values.length === 0) {
    return Number(adapterError?.status) || null;
  }
  if (values.length === 1) {
    return values[0];
  }
  return values[values.length - 1];
}

function normalizeStatusCode(value) {
  if (Array.isArray(value)) {
    return normalizeStatusCode(value[value.length - 1]);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

async function withTimeout(promise, timeoutMs) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`stale source audit timed out after ${timeoutMs}ms`);
        error.code = "STALE_AUDIT_TIMEOUT";
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
