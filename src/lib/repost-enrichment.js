import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DATA_DIR = path.join(process.cwd(), "data");
const WEB_REPOST_CACHE_PATH = path.join(DATA_DIR, "web-repost-history.json");
const SERPAPI_API_KEY = String(process.env.SERPAPI_API_KEY || "").trim();
const WEB_REPOST_MAX_CHECKS = Math.max(0, Number(process.env.WEB_REPOST_MAX_CHECKS || 6));
const WEB_REPOST_CONCURRENCY = Math.max(1, Number(process.env.WEB_REPOST_CONCURRENCY || 3));
const WEB_REPOST_CACHE_TTL_MS = Math.max(60 * 60 * 1000, Number(process.env.WEB_REPOST_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000));
const WEB_REPOST_REQUEST_TIMEOUT_MS = Math.max(500, Number(process.env.WEB_REPOST_REQUEST_TIMEOUT_MS || 2500));
const WEB_REPOST_TOTAL_BUDGET_MS = Math.max(1000, Number(process.env.WEB_REPOST_TOTAL_BUDGET_MS || 4000));
const EARLIER_SIGHTING_MIN_GAP_MS = 36 * 60 * 60 * 1000;

let webRepostCache = null;

export function isWebRepostLookupConfigured() {
  return Boolean(SERPAPI_API_KEY);
}

export async function enrichJobsWithWebRepostSignals(jobs = []) {
  if (!isWebRepostLookupConfigured() || !Array.isArray(jobs) || jobs.length === 0 || WEB_REPOST_MAX_CHECKS === 0) {
    return jobs;
  }

  loadWebRepostCache();
  const startedAt = Date.now();

  const lookupTargets = [];
  const seenLookupKeys = new Set();
  for (const job of jobs) {
    if (Date.now() - startedAt >= WEB_REPOST_TOTAL_BUDGET_MS) {
      break;
    }
    if (lookupTargets.length >= WEB_REPOST_MAX_CHECKS) {
      break;
    }

    const lookupKey = buildLookupKey(job);
    if (!lookupKey || seenLookupKeys.has(lookupKey)) {
      continue;
    }

    seenLookupKeys.add(lookupKey);
    lookupTargets.push({ job, lookupKey });
  }

  let cursor = 0;
  let cacheUpdated = false;

  async function worker() {
    while (cursor < lookupTargets.length) {
      if (Date.now() - startedAt >= WEB_REPOST_TOTAL_BUDGET_MS) {
        return;
      }
      const index = cursor;
      cursor += 1;
      const target = lookupTargets[index];
      const enrichment = await getWebRepostSignal(target.job, target.lookupKey);
      if (!enrichment) {
        continue;
      }

      cacheUpdated = true;
      for (const job of jobs) {
        if (buildLookupKey(job) !== target.lookupKey) {
          continue;
        }
        mergeWebRepostSignal(job, enrichment);
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(WEB_REPOST_CONCURRENCY, lookupTargets.length)) },
    () => worker()
  );
  await Promise.all(workers);

  if (cacheUpdated) {
    saveWebRepostCache();
  }

  return jobs;
}

async function getWebRepostSignal(job, lookupKey) {
  const cached = readCachedLookup(lookupKey);
  if (cached) {
    return cached;
  }

  try {
    const query = buildSearchQuery(job);
    if (!query) {
      return null;
    }

    const payload = await fetchSerpApiGoogleResults(query);
    const enrichment = buildWebRepostSignal(job, payload);
    writeCachedLookup(lookupKey, enrichment);
    return enrichment;
  } catch {
    return null;
  }
}

async function fetchSerpApiGoogleResults(query) {
  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("engine", "google");
  url.searchParams.set("google_domain", "google.com");
  url.searchParams.set("gl", "us");
  url.searchParams.set("hl", "en");
  url.searchParams.set("num", "10");
  url.searchParams.set("api_key", SERPAPI_API_KEY);
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(WEB_REPOST_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`SerpApi request failed with ${response.status}`);
  }

  return response.json();
}

function buildWebRepostSignal(job, payload) {
  const organicResults = Array.isArray(payload?.organic_results) ? payload.organic_results : [];
  const jobIdCandidates = extractJobIdCandidates(job);
  const targetTitle = normalizeComparableText(job.title);
  const currentPostedAt = parseComparableTime(job.postedAt || job.updatedAt);
  const observations = [];

  for (const result of organicResults) {
    if (!isRelevantWebResult(result, jobIdCandidates, targetTitle)) {
      continue;
    }

    const dateIso = extractObservedDateIso(result);
    if (!dateIso) {
      continue;
    }

    observations.push({
      dateIso,
      link: String(result.link || "").trim(),
      title: String(result.title || "").trim(),
      displayedLink: String(result.displayed_link || "").trim(),
    });
  }

  const uniqueDates = [...new Set(observations.map((item) => item.dateIso))].sort();
  const earlierDates = currentPostedAt > 0
    ? uniqueDates.filter((value) => parseComparableTime(value) > 0 && parseComparableTime(value) + EARLIER_SIGHTING_MIN_GAP_MS < currentPostedAt)
    : uniqueDates;
  const isPossibleRepost = earlierDates.length > 0;

  return {
    isPossibleRepost,
    query: buildSearchQuery(job),
    observedDates: uniqueDates,
    earlierObservedDates: earlierDates,
    matchedResults: observations.slice(0, 5),
    details: isPossibleRepost
      ? [`Google results show earlier sightings on ${formatObservedDates(earlierDates)}`]
      : [],
  };
}

function mergeWebRepostSignal(job, enrichment) {
  if (!enrichment?.isPossibleRepost) {
    return;
  }

  const existingInfo = job.repostInfo && typeof job.repostInfo === "object" ? job.repostInfo : {};
  const details = new Set(Array.isArray(existingInfo.details) ? existingInfo.details : []);
  for (const detail of enrichment.details || []) {
    details.add(detail);
  }

  job.repostInfo = {
    ...existingInfo,
    isPossibleRepost: true,
    label: existingInfo.label || "POSSIBLE REPOST",
    details: [...details],
    webHistory: {
      query: enrichment.query || "",
      observedDates: enrichment.observedDates || [],
      earlierObservedDates: enrichment.earlierObservedDates || [],
      matchedResults: enrichment.matchedResults || [],
    },
  };
  job.isPossibleRepost = true;
}

function buildSearchQuery(job) {
  const company = String(job.company || "").trim();
  const title = String(job.title || "").trim();
  const jobId = extractJobIdCandidates(job)[0] || "";

  if (jobId) {
    const baseTitle = title ? ` "${title}"` : "";
    return `"${jobId}" "${company}"${baseTitle}`;
  }

  if (company && title) {
    return `"${company}" "${title}"`;
  }

  return title || company || "";
}

function buildLookupKey(job) {
  const jobId = extractJobIdCandidates(job)[0] || "";
  if (jobId) {
    return `job-id|${jobId}`;
  }

  const company = normalizeComparableText(job.company);
  const title = normalizeComparableText(job.title);
  if (!company && !title) {
    return "";
  }

  return `title|${company}|${title}`;
}

function extractJobIdCandidates(job) {
  const texts = [
    job.externalId,
    job.applyUrl,
    job.title,
    job.descriptionSnippet,
  ]
    .map((value) => String(value || ""))
    .filter(Boolean);
  const candidates = new Set();
  const genericIdPattern = /\b[A-Z]{1,6}-\d{3,}(?:-\d+)?\b/g;

  for (const text of texts) {
    const matches = text.toUpperCase().match(genericIdPattern) || [];
    for (const match of matches) {
      candidates.add(match);
      const familyMatch = match.match(/^([A-Z]{1,6}-\d{3,})-\d+$/);
      if (familyMatch?.[1]) {
        candidates.add(familyMatch[1]);
      }
    }
  }

  return [...candidates];
}

function isRelevantWebResult(result, jobIdCandidates, targetTitle) {
  const haystack = normalizeComparableText([
    result?.title,
    result?.snippet,
    result?.link,
    result?.displayed_link,
  ].filter(Boolean).join(" "));

  if (!haystack) {
    return false;
  }

  if (jobIdCandidates.some((candidate) => haystack.includes(candidate.toLowerCase()))) {
    return true;
  }

  if (!targetTitle) {
    return false;
  }

  return haystack.includes(targetTitle);
}

function extractObservedDateIso(result) {
  const directCandidates = [
    result?.date,
    result?.snippet,
    result?.rich_snippet?.top?.detected_extensions?.date,
  ];

  for (const value of directCandidates) {
    const iso = parseDateCandidate(value);
    if (iso) {
      return iso;
    }
  }

  return "";
}

function parseDateCandidate(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const explicitMatch = raw.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i);
  const candidate = explicitMatch?.[0] || raw;
  const time = Date.parse(candidate);
  if (Number.isNaN(time)) {
    return "";
  }

  return new Date(time).toISOString();
}

function formatObservedDates(dateValues) {
  return dateValues
    .slice(0, 3)
    .map((value) => new Date(value).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }))
    .join(", ");
}

function normalizeComparableText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseComparableTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isNaN(time) ? 0 : time;
}

function loadWebRepostCache() {
  if (webRepostCache) {
    return webRepostCache;
  }

  try {
    if (existsSync(WEB_REPOST_CACHE_PATH)) {
      const parsed = JSON.parse(readFileSync(WEB_REPOST_CACHE_PATH, "utf8"));
      webRepostCache = parsed && typeof parsed === "object" ? parsed : {};
      return webRepostCache;
    }
  } catch {
    // Ignore malformed cache and rebuild from empty.
  }

  webRepostCache = {};
  return webRepostCache;
}

function saveWebRepostCache() {
  if (!webRepostCache) {
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(WEB_REPOST_CACHE_PATH, JSON.stringify(webRepostCache, null, 2), "utf8");
}

function readCachedLookup(lookupKey) {
  const cache = loadWebRepostCache();
  const entry = cache?.[lookupKey];
  if (!entry || Number(entry.savedAt || 0) + WEB_REPOST_CACHE_TTL_MS < Date.now()) {
    return null;
  }

  return entry.result || null;
}

function writeCachedLookup(lookupKey, result) {
  const cache = loadWebRepostCache();
  cache[lookupKey] = {
    savedAt: Date.now(),
    result,
  };
}
