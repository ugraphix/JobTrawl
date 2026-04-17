import { inferWorkArrangement, normalizeCompany, toIsoDate } from "../filters.js";

const DEFAULT_FETCH_TIMEOUT_MS = 45000;

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    ...options,
  });

  if (!response.ok) {
    const error = new Error(`Request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

export async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: options.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    ...options,
  });

  if (!response.ok) {
    const error = new Error(`Request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.text();
}

export function buildNormalizedJob(source, job) {
  const postedAt = toIsoDate(job.postedAt);
  const updatedAt = toIsoDate(job.updatedAt);

  return {
    id: `${source.provider}:${source.key}:${job.id}`,
    externalId: String(job.id),
    sourceKey: source.key,
    sourceName: source.name || source.company,
    provider: source.provider,
    company: normalizeCompany(job.company || source.company),
    title: job.title || "Untitled role",
    team: job.team || null,
    department: job.department || null,
    locationLabel: job.locationLabel || "Unspecified",
    city: job.city || null,
    region: job.region || null,
    country: job.country || null,
    workArrangement: job.workArrangement || inferWorkArrangement(job.locationLabel),
    postedAt,
    updatedAt,
    dateStatus: job.dateStatus || inferDateStatus(postedAt, updatedAt),
    applyUrl: job.applyUrl,
    descriptionSnippet: job.descriptionSnippet || null,
    searchText: job.searchText || job.descriptionSnippet || null,
    employmentType: job.employmentType || null,
    compensation: job.compensation || null,
    rawLocationText: job.rawLocationText || job.locationLabel || null,
    coordinates: job.coordinates || null,
  };
}

function inferDateStatus(postedAt, updatedAt) {
  if (postedAt) {
    return "posted";
  }

  if (updatedAt) {
    return "updated";
  }

  return "unknown";
}

export function safeText(value, maxLength = 220) {
  const collapsed = cleanText(value);
  if (!collapsed) {
    return null;
  }
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 3)}...` : collapsed;
}

export function cleanText(value) {
  if (!value) {
    return null;
  }

  const collapsed = stripTags(decodeHtmlEntities(String(value))).replace(/\s+/g, " ").trim();
  return collapsed || null;
}

export function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/g, " ");
}

export function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

export function absoluteUrl(url, baseUrl) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

export function extractJsonLdJobPostings(html) {
  const matches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const jobs = [];

  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }

    try {
      collectJobPostings(JSON.parse(raw), jobs);
    } catch {
      continue;
    }
  }

  return jobs;
}

export function extractPreloadStateJobs(html) {
  const payload = extractAssignedJsonObject(html, "window.__PRELOAD_STATE__");
  if (!payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload);
    const jobs = parsed?.jobSearch?.jobs;
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

export function extractPhenomDdoJobs(html) {
  const payload = extractAssignedJsonObject(html, "phApp.ddo");
  if (!payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload);
    const jobs = findJobArray(parsed);
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

export function extractPostedDateFromHtml(html) {
  const jsonLdJobs = extractJsonLdJobPostings(html);
  for (const job of jsonLdJobs) {
    if (job.datePosted) {
      return job.datePosted;
    }
  }

  const metaPatterns = [
    /"datePosted"\s*:\s*"([^"]+)"/i,
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']publish-date["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ];

  for (const pattern of metaPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

function collectJobPostings(node, jobs) {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectJobPostings(item, jobs);
    }
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  const type = node["@type"];
  if ((Array.isArray(type) && type.includes("JobPosting")) || type === "JobPosting") {
    jobs.push(node);
  }

  for (const value of Object.values(node)) {
    collectJobPostings(value, jobs);
  }
}

function findJobArray(node) {
  if (!node) {
    return null;
  }

  if (Array.isArray(node)) {
    if (node.length > 0 && node.every((item) => item && typeof item === "object" && ("title" in item || "applyUrl" in item))) {
      return node;
    }

    for (const item of node) {
      const found = findJobArray(item);
      if (found) {
        return found;
      }
    }

    return null;
  }

  if (typeof node !== "object") {
    return null;
  }

  for (const value of Object.values(node)) {
    const found = findJobArray(value);
    if (found) {
      return found;
    }
  }

  return null;
}

export function deriveTitleFromUrl(value) {
  const slug = String(value || "")
    .split("/")
    .filter(Boolean)
    .pop();

  if (!slug) {
    return null;
  }

  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\bjob\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractAssignedJsonObject(html, marker) {
  const value = String(html || "");
  const markerIndex = value.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const assignmentIndex = value.indexOf("=", markerIndex);
  if (assignmentIndex === -1) {
    return null;
  }

  const objectStart = value.indexOf("{", assignmentIndex);
  if (objectStart === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = objectStart; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(objectStart, index + 1);
      }
    }
  }

  return null;
}
