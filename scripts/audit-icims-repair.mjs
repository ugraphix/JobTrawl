import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { fetchJobsForSource } from "../src/lib/adapters/index.js";
import { runWithLiveFetchAuditContext } from "../src/lib/adapters/shared.js";
import { loadSourceConfig } from "../src/lib/config.js";
import { analyzeSourceFilterFunnel } from "../src/lib/search.js";

const DATA_DIR = path.join(process.cwd(), "data");
const OUTPUT_SUFFIX = String(process.env.JOBTRAWL_ICIMS_AUDIT_SUFFIX || "after").trim() || "after";
const NDJSON_PATH = path.join(DATA_DIR, `icims-repair-audit-${OUTPUT_SUFFIX}.ndjson`);
const SUMMARY_PATH = path.join(DATA_DIR, `icims-repair-audit-${OUTPUT_SUFFIX}-summary.json`);
const CONCURRENCY = Number(process.env.JOBTRAWL_ICIMS_AUDIT_CONCURRENCY || 6);
const TIMEOUT_MS = Number(process.env.JOBTRAWL_ICIMS_AUDIT_TIMEOUT_MS || 90000);
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
    .filter((source) => String(source?.provider || "").trim().toLowerCase() === "icims")
    .sort((left, right) => (
      String(left?.company || "").localeCompare(String(right?.company || ""))
      || String(left?.key || "").localeCompare(String(right?.key || ""))
    ));

  const summary = {
    generatedAt: new Date().toISOString(),
    configuredSources: sources.length,
    validPages: 0,
    shellOnlyPages: 0,
    parserGaps: 0,
    parsedJobs: 0,
    jobsEnteringDateFilter: 0,
    jobsEnteringKeywordFilter: 0,
    finalProductManagerMatches: 0,
    pageShapeCounts: {},
    outcomeCounts: {},
  };

  const stream = createWriteStream(NDJSON_PATH, { flags: "w", encoding: "utf8" });
  let currentIndex = 0;
  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    while (true) {
      const index = currentIndex;
      currentIndex += 1;
      if (index >= sources.length) {
        return;
      }

      const record = await auditIcimsSource(sources[index], index + 1, sources.length);
      stream.write(`${JSON.stringify(record)}\n`);
      updateSummary(summary, record);

      if (summary.validPages % 100 === 0 || index + 1 === sources.length) {
        process.stdout.write(
          `[icims-audit:${OUTPUT_SUFFIX}] ${index + 1}/${sources.length} checked `
          + `(valid=${summary.validPages}, shell=${summary.shellOnlyPages}, gaps=${summary.parserGaps})\n`
        );
      }
    }
  });

  try {
    await Promise.all(workers);
  } finally {
    await new Promise((resolve) => stream.end(resolve));
  }

  await writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`[icims-audit:${OUTPUT_SUFFIX}] summary written to ${SUMMARY_PATH}\n`);
}

async function auditIcimsSource(source, index, total) {
  const searchUrl = resolveIcimsAuditSearchUrl(source?.careersUrl);
  const inspected = await inspectIcimsPages(searchUrl);
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
    };
  }

  const funnel = analyzeSourceFilterFunnel(jobs, AUDIT_FILTERS);
  const pageShape = classifyPrimaryPageShape(inspected);
  const parserGap = isIcimsParserGap(inspected, jobs.length);

  return {
    source: {
      index,
      total,
      key: source?.key || null,
      company: source?.company || null,
      careersUrl: source?.careersUrl || null,
      inventorySource: source?.inventorySource || null,
    },
    searchUrl,
    inspected,
    pageShape,
    validPage: inspected.validPage,
    shellOnlyPage: inspected.shellOnlyPage,
    parserGap,
    adapterError,
    parsedJobCount: Array.isArray(jobs) ? jobs.length : 0,
    stageCounts: funnel.stageCounts,
    stageFlags: funnel.stageFlags,
    keywordAudit: funnel.keywordAudit,
    liveRequestCount: Array.isArray(context.requests) ? context.requests.length : 0,
    liveSummary: context.summary,
  };
}

async function inspectIcimsPages(searchUrl) {
  const wrapper = await fetchPage(searchUrl);
  const iframeUrl = extractIcimsIframeUrl(wrapper.text, searchUrl);
  const iframe = iframeUrl && iframeUrl !== searchUrl ? await fetchPage(iframeUrl) : null;
  const effectiveInitial = iframe?.text ? iframe : wrapper;
  const redirectUrl = extractRedirectTarget(effectiveInitial?.text, effectiveInitial?.url || searchUrl);
  const redirect = redirectUrl ? await fetchPage(redirectUrl) : null;
  const effective = redirect?.text ? redirect : effectiveInitial;

  const wrapperShape = inspectIcimsHtmlShape(wrapper.text, wrapper.url);
  const iframeShape = iframe?.text ? inspectIcimsHtmlShape(iframe.text, iframe.url) : null;
  const redirectShape = redirect?.text ? inspectIcimsHtmlShape(redirect.text, redirect.url) : null;
  const effectiveShape = redirectShape || iframeShape || wrapperShape;
  const validPage = [wrapper, iframe, redirect]
    .filter(Boolean)
    .some((page) => Number(page?.status) === 200 && Number(page?.size) > 0);

  return {
    validPage,
    shellOnlyPage: Boolean(effectiveShape?.isShellOnly),
    wrapper: {
      url: wrapper.url,
      status: wrapper.status,
      size: wrapper.size,
      shape: wrapperShape,
    },
    iframe: iframe
      ? {
        url: iframe.url,
        status: iframe.status,
        size: iframe.size,
        shape: iframeShape,
      }
      : null,
    redirect: redirect
      ? {
        url: redirect.url,
        status: redirect.status,
        size: redirect.size,
        shape: redirectShape,
      }
      : null,
    effectiveUrl: effective?.url || searchUrl,
    effectiveStatus: effective?.status ?? null,
    effectiveSize: effective?.size ?? null,
    effectiveShape,
  };
}

async function fetchPage(url) {
  if (!url) {
    return {
      url: null,
      status: null,
      size: 0,
      text: "",
    };
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 JobTrawl iCIMS audit",
    },
  });
  const text = await response.text();
  return {
    url,
    status: response.status,
    size: text.length,
    text,
  };
}

function resolveIcimsAuditSearchUrl(careersUrl) {
  if (!careersUrl) {
    return "";
  }

  try {
    const parsed = new URL(careersUrl);
    if (/icims\.com$/i.test(parsed.hostname) || /\.icims\.com$/i.test(parsed.hostname)) {
      if (!parsed.pathname.includes("/jobs/search")) {
        parsed.pathname = "/jobs/search";
      }
      if (!parsed.searchParams.has("ss")) {
        parsed.searchParams.set("ss", "1");
      }
    }
    return parsed.toString();
  } catch {
    return careersUrl;
  }
}

function extractIcimsIframeUrl(pageHtml, baseUrl) {
  const source = String(pageHtml || "");
  const patterns = [
    /icimsFrame\.src\s*=\s*'([^']+)'/i,
    /icimsFrame\.src\s*=\s*"([^"]+)"/i,
    /<iframe[^>]*id=["']icims_content_iframe["'][^>]*src=["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const raw = String(match?.[1] || "").trim();
    if (raw) {
      return absoluteFromAuditBase(raw, baseUrl);
    }
  }

  if (!baseUrl) {
    return "";
  }

  try {
    const parsed = new URL(baseUrl);
    if (!parsed.searchParams.has("in_iframe")) {
      parsed.searchParams.set("in_iframe", "1");
    }
    return parsed.toString();
  } catch {
    return baseUrl;
  }
}

function extractRedirectTarget(pageHtml, baseUrl) {
  const source = String(pageHtml || "");
  const match = source.match(/window\.top\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
  const raw = String(match?.[1] || "").trim();
  if (!raw) {
    return null;
  }
  return absoluteFromAuditBase(raw.replace(/\\\//g, "/"), baseUrl);
}

function inspectIcimsHtmlShape(html, pageUrl) {
  const source = String(html || "");
  const jsonLdJobPostings = extractJsonLdJobPostingCount(source);
  const embeddedApiUrls = extractApiHints(source);
  const redirectTarget = extractRedirectTarget(source, pageUrl);
  const hasJobCards = /iCIMS_JobCardItem/i.test(source);
  const hasPagination = /rel=["']next["']/i.test(source) || /pagination/i.test(source);
  const hasEmbeddedJsonState = /__NEXT_DATA__|window\.__INITIAL_STATE__|window\.__APOLLO_STATE__|window\._jibe|<script[^>]+type=["']application\/json["']/i.test(source);
  const hasJsonLd = /application\/ld\+json/i.test(source);
  const hasJobCardAnchors = /href=["'][^"']*\/jobs\/(?!intro|login)[^"']+["']/i.test(source);
  const isJsShell = /<base href="\/careers-home|window\._jibe|app\.jibecdn\.com\/prod\/search|id="ng-app"|<app-root|<div[^>]+id=["']root["']/i.test(source);
  const isGeoGated = /permission to access your location has been denied|location information has yet to be received/i.test(source);
  const explicitEmpty = /no current job openings|there are no job openings|sorry, we have no current job openings/i.test(source);

  let pageType = "unknown_html";
  if (hasJobCards) {
    pageType = "static_html";
  } else if (jsonLdJobPostings > 0) {
    pageType = "json_ld";
  } else if (hasEmbeddedJsonState) {
    pageType = "embedded_json";
  } else if (isJsShell || redirectTarget) {
    pageType = "js_shell";
  } else if (isGeoGated) {
    pageType = "geo_gated";
  } else if (explicitEmpty) {
    pageType = "empty_board";
  }

  return {
    pageType,
    hasJobCards,
    hasJsonLd,
    jsonLdJobCount: jsonLdJobPostings,
    hasEmbeddedJsonState,
    embeddedJobCount: 0,
    apiUrls: embeddedApiUrls.slice(0, 20),
    hasPagination,
    redirectTarget,
    isGeoGated,
    explicitEmpty,
    isShellOnly: Boolean((isJsShell || redirectTarget) && !hasJobCards && jsonLdJobPostings === 0),
    sample: source.slice(0, 1200).replace(/\s+/g, " ").trim(),
    jobCardAnchorCount: hasJobCardAnchors ? (source.match(/href=["'][^"']*\/jobs\/(?!intro|login)[^"']+["']/gi) || []).length : 0,
  };
}

function extractJsonLdJobPostingCount(html) {
  const source = String(html || "");
  const blocks = [...source.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let count = 0;
  for (const block of blocks) {
    const raw = String(block?.[1] || "").trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length > 0) {
        const value = stack.pop();
        if (!value || typeof value !== "object") {
          continue;
        }
        const type = String(value["@type"] || "").toLowerCase();
        if (type === "jobposting") {
          count += 1;
        }
        for (const nested of Object.values(value)) {
          if (Array.isArray(nested)) {
            stack.push(...nested);
          } else if (nested && typeof nested === "object") {
            stack.push(nested);
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return count;
}

function extractApiHints(html) {
  const source = String(html || "");
  const matches = source.match(/https?:\/\/[^"'\\s>]+|\/api\/[A-Za-z0-9_./?=&-]+/g) || [];
  return [...new Set(matches.filter((value) => /api|job|search|career/i.test(value)))];
}

function absoluteFromAuditBase(value, baseUrl) {
  const normalized = String(value || "").trim().replace(/&amp;/g, "&");
  if (!normalized) {
    return "";
  }

  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  if (normalized.startsWith("//")) {
    try {
      const parsedBase = new URL(baseUrl);
      return `${parsedBase.protocol}${normalized}`;
    } catch {
      return `https:${normalized}`;
    }
  }

  try {
    return new URL(normalized, baseUrl).toString();
  } catch {
    return normalized;
  }
}

function classifyPrimaryPageShape(inspected) {
  return inspected?.effectiveShape?.pageType || "unknown_html";
}

function isIcimsParserGap(inspected, parsedJobCount) {
  const effective = inspected?.effectiveShape;
  if (!effective) {
    return parsedJobCount === 0;
  }
  if (parsedJobCount > 0) {
    return false;
  }
  return Boolean(
    effective.pageType === "js_shell"
    || effective.pageType === "geo_gated"
    || effective.isGeoGated
    || (effective.pageType === "embedded_json" && effective.embeddedJobCount === 0)
  );
}

function updateSummary(summary, record) {
  if (record.validPage) {
    summary.validPages += 1;
  }
  if (record.shellOnlyPage) {
    summary.shellOnlyPages += 1;
  }
  if (record.parserGap) {
    summary.parserGaps += 1;
  }
  summary.parsedJobs += Number(record?.parsedJobCount || 0);
  summary.jobsEnteringDateFilter += Number(record?.stageCounts?.normalized || 0);
  summary.jobsEnteringKeywordFilter += Number(record?.stageCounts?.dateFiltered || 0);
  summary.finalProductManagerMatches += Number(record?.stageCounts?.final || 0);

  const pageShape = String(record?.pageShape || "unknown_html");
  summary.pageShapeCounts[pageShape] = (summary.pageShapeCounts[pageShape] || 0) + 1;

  const outcomeKey = record.adapterError
    ? `adapter_error:${record.adapterError.code || "unknown"}`
    : record.parsedJobCount > 0
      ? "parsed_jobs"
      : record.parserGap
        ? "parser_gap"
        : "empty_or_unparsed";
  summary.outcomeCounts[outcomeKey] = (summary.outcomeCounts[outcomeKey] || 0) + 1;
}

async function withTimeout(promise, timeoutMs) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`iCIMS audit timed out after ${timeoutMs}ms`);
        error.code = "ICIMS_AUDIT_TIMEOUT";
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
