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

export async function fetchDescriptionFallback(url, options = {}) {
  if (!url) {
    return { descriptionSnippet: null, searchText: null };
  }

  try {
    const normalizedUrl = normalizeDescriptionFetchUrl(url);
    const workdayDescription = await fetchWorkdayDescriptionFallback(normalizedUrl, options);
    if (workdayDescription.descriptionSnippet || workdayDescription.searchText) {
      return workdayDescription;
    }

    const raw = await fetchText(normalizedUrl, options);
    const description = pickBestDescriptionCandidate([
      extractJobPostingDescriptionFromHtml(raw),
      extractDescriptionMetaFromHtml(raw),
      extractDescriptionFromStructuredPayload(raw),
      extractJobDescriptionFromHtml(raw),
    ]);
    if (!description) {
      return { descriptionSnippet: null, searchText: null };
    }

    return {
      descriptionSnippet: safeText(formatDescriptionForDisplay(description), 1400),
      searchText: cleanText(description),
    };
  } catch {
    return { descriptionSnippet: null, searchText: null };
  }
}

export async function fetchWorkdayDescriptionFallback(url, options = {}) {
  const detailApiUrl = buildWorkdayDetailApiUrl(url);
  if (!detailApiUrl) {
    return { descriptionSnippet: null, searchText: null };
  }

  try {
    const payload = await fetchJson(detailApiUrl, options);
    const description = extractWorkdayDescription(payload);
    if (!description) {
      return { descriptionSnippet: null, searchText: null };
    }

    return {
      descriptionSnippet: safeText(formatDescriptionForDisplay(description), 2200),
      searchText: cleanText(description),
    };
  } catch {
    return { descriptionSnippet: null, searchText: null };
  }
}

export function hasUsableDescriptionText(job = {}) {
  const candidate = cleanText(job.searchText || job.descriptionSnippet || "");
  if (!candidate) {
    return false;
  }

  const normalizedCandidate = candidate.toLowerCase();
  const normalizedTitle = cleanText(job.title || "")?.toLowerCase() || "";
  if (normalizedTitle && normalizedCandidate === normalizedTitle) {
    return false;
  }

  if (looksLikeStructuredGarbageText(candidate)) {
    return false;
  }

  const words = candidate.split(/\s+/).filter(Boolean);
  if (words.length >= 12 && candidate.length >= 80) {
    return true;
  }

  if (/^(job id|req(uisition)? id|requisition|posting id|position id)\b/i.test(candidate)) {
    return false;
  }

  if (/^[A-Z]?\d[\dA-Z-]{3,}$/i.test(candidate.replace(/\s+/g, ""))) {
    return false;
  }

  if (candidate.length < 40 || words.length < 6) {
    return false;
  }

  return /[a-z]{3,}/i.test(candidate);
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

export function safeText(value, maxLength = 700) {
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

  const collapsed = stripTags(decodeHtmlEntities(String(value)))
    .replace(/[•·●▪◦]/g, " ")
    .replace(/â€¢/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || null;
}

function normalizeDescriptionLine(value) {
  const raw = decodeHtmlEntities(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) {
    return null;
  }

  const bulletPrefix = /^[-•*]\s*/.test(raw) ? "- " : "";
  const cleaned = cleanText(raw.replace(/^[-•*]\s*/, ""));
  return cleaned ? `${bulletPrefix}${cleaned}` : null;
}

export function formatDescriptionForDisplay(value) {
  const normalized = String(value || "")
    .split(/\n+/)
    .map((line) => normalizeDescriptionLine(line))
    .filter(Boolean);

  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length === 1) {
    return normalized[0];
  }

  return [normalized[0], ...normalized.slice(1)].join(" • ");
}

function pickBestDescriptionCandidate(candidates) {
  const usable = candidates
    .map((value) => cleanLeadingDescriptionPunctuation(value))
    .filter((value) => value && !looksLikeStructuredGarbageText(value) && value.split(/\s+/).length >= 10);

  if (usable.length === 0) {
    return null;
  }

  usable.sort((left, right) => scoreDescriptionCandidate(right) - scoreDescriptionCandidate(left));
  return usable[0] || null;
}

export function extractVisibleTextFromHtml(html) {
  const source = String(html || "");
  const stripped = source
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(stripped)
    .replace(/â€¢/g, "- ")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join("\n");
}

export function extractJobDescriptionFromHtml(html) {
  const text = extractVisibleTextFromHtml(html);
  if (!text) {
    return null;
  }

  const preferredHeadings = [
    "about the role:",
    "about the role",
    "overview:",
    "overview",
    "in this role:",
    "in this role",
    "about this role",
    "role responsibilities:",
    "role responsibilities",
    "role overview",
    "position overview",
    "job summary",
    "position summary",
    "job description",
    "position description",
    "the role",
    "the opportunity",
    "what you'll do",
    "what you will do",
    "what you'll be doing",
    "what you'll work on",
    "day to day",
    "responsibilities",
    "key responsibilities",
    "about the team",
  ];
  const stopHeadings = [
    "about the company",
    "about us",
    "who we are",
    "what we do",
    "our mission",
    "benefits",
    "compensation",
    "pay range",
    "salary range",
    "equal opportunity",
    "privacy",
    "accommodation",
    "how to apply",
    "share this position",
  ];

  const lowerText = text.toLowerCase();
  let startIndex = -1;
  let selectedHeading = "";
  for (const heading of preferredHeadings) {
    const index = lowerText.indexOf(heading);
    if (index !== -1 && (startIndex === -1 || index < startIndex)) {
      startIndex = index;
      selectedHeading = heading;
    }
  }

  let candidate = text;
  if (startIndex !== -1) {
    candidate = text.slice(startIndex + selectedHeading.length).replace(/^[:\s.-]+/, "").trim();
  } else {
    const roleSentenceMatch = text.match(/(?:about the role|overview|in this role|role responsibilities|we are looking for|we're looking for|you will|you'll|as a .*?, you will|this role will)[\s\S]{60,6000}/i);
    if (roleSentenceMatch?.[0]) {
      candidate = roleSentenceMatch[0].trim();
    }
  }

  if (looksLikeCompensationOnlyLead(candidate)) {
    const redirectedCandidate = extractCandidateFromLaterHeading(text, preferredHeadings, selectedHeading);
    if (redirectedCandidate) {
      candidate = redirectedCandidate;
    }
  }

  if (startIndex !== -1 && candidate.length < 260) {
    const extendedCandidate = extractExtendedHeadingCandidate(text, startIndex, selectedHeading, stopHeadings);
    if (extendedCandidate && extendedCandidate.length > candidate.length + 120) {
      candidate = extendedCandidate;
    }
  }

  const lowerCandidate = candidate.toLowerCase();
  let stopIndex = -1;
  for (const heading of stopHeadings) {
    const index = lowerCandidate.indexOf(heading);
    if (index > 120 && (stopIndex === -1 || index < stopIndex)) {
      stopIndex = index;
    }
  }

  if (stopIndex !== -1) {
    candidate = candidate.slice(0, stopIndex).trim();
  }

  if (looksLikeStructuredGarbageText(candidate)) {
    return null;
  }

  return cleanLeadingDescriptionPunctuation(cleanText(candidate))?.slice(0, 6000) || null;
}

function extractJobPostingDescriptionFromHtml(html) {
  const postings = extractJsonLdJobPostings(String(html || ""));
  const candidates = postings
    .map((posting) => posting?.description)
    .map((value) => cleanLeadingDescriptionPunctuation(cleanText(value)))
    .filter((value) => value && !looksLikeStructuredGarbageText(value));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => scoreDescriptionCandidate(right) - scoreDescriptionCandidate(left));
  return candidates[0] || null;
}

function extractDescriptionMetaFromHtml(html) {
  const source = String(html || "");
  const candidates = [
    source.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1],
    source.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1],
  ]
    .map((value) => cleanLeadingDescriptionPunctuation(cleanText(value)))
    .filter((value) => value && !looksLikeStructuredGarbageText(value));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => scoreDescriptionCandidate(right) - scoreDescriptionCandidate(left));
  return candidates[0] || null;
}

export function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => {
      const numeric = Number(code);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const numeric = Number.parseInt(code, 16);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _;
    });
}

export function looksLikeStructuredGarbageText(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }

  const lower = text.toLowerCase();
  if (
    lower.includes('"jobad"')
    || lower.includes('"jobadid"')
    || lower.includes('"fieldid"')
    || lower.includes('"valuelabel"')
    || lower.includes('"questionid"')
    || lower.includes("skip to main content")
  ) {
    return true;
  }

  const braceCount = (text.match(/[{}[\]]/g) || []).length;
  const quoteColonCount = (text.match(/":/g) || []).length;
  const arrowCount = (text.match(/->/g) || []).length;
  if (braceCount >= 6 || quoteColonCount >= 4 || arrowCount >= 3) {
    return true;
  }

  return false;
}

export function extractDescriptionFromStructuredPayload(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return null;
  }

  const candidates = [];
  const direct = tryParseStructuredDescription(raw);
  if (direct) {
    candidates.push(direct);
  }

  const jsonMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch?.[1]) {
    const nested = tryParseStructuredDescription(jsonMatch[1]);
    if (nested) {
      candidates.push(nested);
    }
  }

  for (const block of extractEmbeddedJsonBlocks(raw)) {
    const parsedBlock = tryParseStructuredDescription(block);
    if (parsedBlock) {
      candidates.push(parsedBlock);
    }
  }

  return candidates.find(Boolean) || null;
}

function tryParseStructuredDescription(raw) {
  try {
    const parsed = JSON.parse(raw);
    const collected = [];
    collectStructuredDescriptionStrings(parsed, "", collected);
    const usable = collected
      .map((item) => cleanText(item))
      .filter((item) => item && !looksLikeStructuredGarbageText(item) && item.split(/\s+/).length >= 10);
    usable.sort((left, right) => scoreDescriptionCandidate(right) - scoreDescriptionCandidate(left));
    return usable[0] || null;
  } catch {
    return null;
  }
}

function collectStructuredDescriptionStrings(node, keyPath, collected) {
  if (!node) {
    return;
  }

  if (typeof node === "string") {
    if (/(description|summary|overview|responsibil|about|role|content|text|body|jobad|section)/i.test(keyPath)) {
      collected.push(node);
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectStructuredDescriptionStrings(item, keyPath, collected);
    }
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    collectStructuredDescriptionStrings(value, `${keyPath}.${key}`, collected);
  }
}

function extractEmbeddedJsonBlocks(raw) {
  const blocks = [];
  const scriptMatches = raw.matchAll(/<script[^>]*>\s*([\[{][\s\S]*?[\]}])\s*<\/script>/gi);
  for (const match of scriptMatches) {
    if (match?.[1]) {
      blocks.push(match[1]);
    }
  }

  const assignedJsonMatches = raw.matchAll(/(?:__NEXT_DATA__|__INITIAL_STATE__|__PRELOADED_STATE__)\s*=\s*([\[{][\s\S]*?[\]}]);/gi);
  for (const match of assignedJsonMatches) {
    if (match?.[1]) {
      blocks.push(match[1]);
    }
  }

  return blocks;
}

function scoreDescriptionCandidate(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return 0;
  }

  let score = text.length;
  if (text.split(/\s+/).length < 10) {
    score -= 5000;
  }
  if (/(about the role|overview|in this role|role responsibilities)/i.test(text)) {
    score += 5000;
  }
  if (/(what you'll do|what you will do|responsibilities|key responsibilities)/i.test(text)) {
    score += 2000;
  }
  if (/(about the team|about the program|about you|qualifications|minimum qualifications|preferred qualifications)/i.test(text)) {
    score += 1000;
  }
  if (/skip to main content|share this position|cookie|privacy/.test(text)) {
    score -= 6000;
  }
  if (/(total cash range|salary range|pay range|base pay)/.test(text) && !/(about the role|overview|in this role|role responsibilities)/.test(text)) {
    score -= 2500;
  }
  if (/^[a-z]?\d[\da-z-]{4,}$/i.test(text.replace(/\s+/g, ""))) {
    score -= 10000;
  }

  return score;
}

function looksLikeCompensationOnlyLead(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return false;
  }

  return /^(the\s+)?(total\s+cash\s+range|cash\s+range|salary\s+range|pay\s+range|base\s+pay)/.test(text);
}

function extractCandidateFromLaterHeading(text, preferredHeadings, alreadySelectedHeading = "") {
  const lowerText = String(text || "").toLowerCase();
  let bestIndex = -1;
  let bestHeading = "";

  for (const heading of preferredHeadings) {
    if (heading === alreadySelectedHeading) {
      continue;
    }
    const index = lowerText.indexOf(heading);
    if (index > 0 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
      bestHeading = heading;
    }
  }

  if (bestIndex === -1) {
    return null;
  }

  return text.slice(bestIndex + bestHeading.length).replace(/^[:\s.-]+/, "").trim();
}

function cleanLeadingDescriptionPunctuation(value) {
  const text = cleanText(value);
  if (!text) {
    return null;
  }

  return text.replace(/^[,\s;:.!/-]+/, "").trim() || null;
}

function extractExtendedHeadingCandidate(text, startIndex, selectedHeading, stopHeadings) {
  const start = startIndex + String(selectedHeading || "").length;
  const remainder = String(text || "").slice(start).replace(/^[:\s.-]+/, "").trim();
  if (!remainder) {
    return null;
  }

  const lowerRemainder = remainder.toLowerCase();
  let stopIndex = -1;
  for (const heading of stopHeadings) {
    const index = lowerRemainder.indexOf(heading);
    if (index > 380 && (stopIndex === -1 || index < stopIndex)) {
      stopIndex = index;
    }
  }

  const candidate = stopIndex === -1
    ? remainder
    : remainder.slice(0, stopIndex).trim();

  return cleanLeadingDescriptionPunctuation(cleanText(candidate)) || null;
}

function buildWorkdayDetailApiUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/myworkdayjobs\.com$/i.test(parsed.hostname)) {
      return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    const jobIndex = segments.findIndex((segment) => segment.toLowerCase() === "job");
    if (jobIndex <= 0) {
      return null;
    }

    const site = segments[jobIndex - 1];
    if (!site) {
      return null;
    }

    const tenant = parsed.hostname.split(".")[0];
    const detailSegments = segments
      .slice(jobIndex)
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)));
    if (detailSegments.length === 0) {
      return null;
    }

    return `${parsed.origin}/wday/cxs/${tenant}/${site}/${detailSegments.join("/")}`;
  } catch {
    return null;
  }
}

function extractWorkdayDescription(payload) {
  const candidates = [
    payload?.jobPostingInfo?.jobDescription,
    payload?.jobPostingInfo?.jobOverview,
    payload?.jobPostingInfo?.description,
    payload?.jobPostingInfo?.externalDescription,
    payload?.jobPostingInfo?.summary,
    payload?.jobDescription,
    payload?.overview,
    payload?.description,
    payload?.summary,
  ];

  const direct = candidates
    .map((value) => cleanLeadingDescriptionPunctuation(cleanText(value)))
    .find((value) => value && hasUsableDescriptionShape(value));
  if (direct) {
    return direct;
  }

  const structured = extractDescriptionFromStructuredPayload(JSON.stringify(payload));
  if (structured && hasUsableDescriptionShape(structured)) {
    return structured;
  }

  return null;
}

function hasUsableDescriptionShape(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }

  if (/^[A-Z]?\d[\dA-Z-]{4,}$/i.test(text.replace(/\s+/g, ""))) {
    return false;
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 12 || text.length < 80) {
    return false;
  }

  return true;
}

export function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

export function absoluteUrl(url, baseUrl) {
  if (!url) {
    return null;
  }

  try {
    return normalizeDescriptionFetchUrl(new URL(url, baseUrl).toString());
  } catch {
    return normalizeDescriptionFetchUrl(url);
  }
}

function normalizeDescriptionFetchUrl(url) {
  const value = String(url || "").trim();
  if (!value) {
    return value;
  }

  try {
    const parsed = new URL(value);
    if (/^jobs\.careers\.microsoft\.com$/i.test(parsed.hostname)) {
      const positionId = parsed.pathname.match(/\/job\/(\d{8,})\/?$/i)?.[1];
      if (positionId) {
        const normalized = new URL("https://apply.careers.microsoft.com/careers");
        normalized.searchParams.set("pid", positionId);
        normalized.searchParams.set("start", "0");
        normalized.searchParams.set("sort_by", "timestamp");
        return normalized.toString();
      }
    }
  } catch {
    return value;
  }

  return value;
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
