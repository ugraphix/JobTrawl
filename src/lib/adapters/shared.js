import { AsyncLocalStorage } from "node:async_hooks";
import { inferWorkArrangement, normalizeCompany, resolveJobRecencyFields, toIsoDate } from "../filters.js";

const DEFAULT_FETCH_TIMEOUT_MS = 45000;
const liveFetchAuditStorage = new AsyncLocalStorage();

export function setLiveFetchAuditContext(context) {
  liveFetchAuditStorage.enterWith(context || null);
}

export function clearLiveFetchAuditContext() {
  liveFetchAuditStorage.enterWith(null);
}

export async function runWithLiveFetchAuditContext(context, callback) {
  return liveFetchAuditStorage.run(context || null, callback);
}

export function recordLiveFetchAuditSummary(summary = {}) {
  const context = liveFetchAuditStorage.getStore();
  if (!context || typeof context !== "object") {
    return;
  }

  context.summary = {
    ...(context.summary || {}),
    ...summary,
  };
}

export function recordLiveFetchAuditRequest(entry = {}) {
  const context = liveFetchAuditStorage.getStore();
  if (!context || typeof context !== "object") {
    return;
  }

  if (!Array.isArray(context.requests)) {
    context.requests = [];
  }

  context.requests.push(entry);
}

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

  const responseBuffer = await response.arrayBuffer();
  const responseSize = Number(responseBuffer.byteLength || 0);
  const responseText = new TextDecoder("utf-8").decode(responseBuffer);

  recordLiveFetchAuditRequest({
    url: String(url),
    method: String(options.method || "GET").toUpperCase(),
    status: response.status,
    responseSize,
    contentType: response.headers.get("content-type") || null,
  });

  if (!response.ok) {
    const error = new Error(`Request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const payload = JSON.parse(responseText);
  const inferredRawJobCount = inferRawJobCountFromJsonPayload(payload);
  if (Number.isFinite(inferredRawJobCount)) {
    recordLiveFetchAuditSummary({
      rawJobCount: inferredRawJobCount,
      rawJobCountBasis: "json_payload",
    });
  }

  return payload;
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

  const text = await response.text();
  const responseSize = Buffer.byteLength(text, "utf8");

  recordLiveFetchAuditRequest({
    url: String(url),
    method: String(options.method || "GET").toUpperCase(),
    status: response.status,
    responseSize,
    contentType: response.headers.get("content-type") || null,
  });

  if (!response.ok) {
    const error = new Error(`Request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return text;
}

export async function fetchDescriptionFallback(url, options = {}) {
  if (!url) {
    return buildEmptyFallbackResult();
  }

  try {
    const normalizedUrl = normalizeDescriptionFetchUrl(url);
    const workdayDescription = await fetchWorkdayDescriptionFallback(normalizedUrl, options);
    const shouldSupplementWorkdayHtml = isWorkdayJobUrl(normalizedUrl) && (
      !workdayDescription.descriptionSnippet
      || !workdayDescription.searchText
      || !workdayDescription.postedAt
      || !workdayDescription.applicationDeadlineAt
      || !workdayDescription.jobId
      || !workdayDescription.compensation
      || !workdayDescription.workArrangement
    );
    if ((workdayDescription.descriptionSnippet
      || workdayDescription.searchText
      || workdayDescription.postedAt
      || workdayDescription.applicationDeadlineAt
      || workdayDescription.jobId
      || workdayDescription.compensation
      || workdayDescription.workArrangement
      || workdayDescription.invalidApplyPage)
      && !shouldSupplementWorkdayHtml) {
      return workdayDescription;
    }

    const raw = await fetchText(normalizedUrl, options);
    const visibleText = extractVisibleTextFromHtml(raw);
    const postedAt = workdayDescription.postedAt || extractPostedDateFromHtml(raw) || extractWorkdayPostedAtFromHtml(raw);
    const applicationDeadlineAt = workdayDescription.applicationDeadlineAt || extractApplicationDeadlineFromHtml(raw);
    const jobId = workdayDescription.jobId || extractJobIdFromHtml(raw, normalizedUrl);
    const compensation = workdayDescription.compensation || extractCompensationFromHtml(raw);
    const workArrangement = workdayDescription.workArrangement || extractExplicitWorkArrangementFromHtml(raw, visibleText);
    const invalidApplyPage = workdayDescription.invalidApplyPage || isInvalidApplyPage(raw, visibleText, normalizedUrl);
    const description = pickBestDescriptionCandidate([
      workdayDescription.searchText,
      workdayDescription.descriptionSnippet,
      extractJobPostingDescriptionFromHtml(raw),
      extractDescriptionMetaFromHtml(raw),
      extractDescriptionFromStructuredPayload(raw),
      extractJobDescriptionFromHtml(raw),
    ]);
    if (!description) {
      if (!visibleText) {
        return {
          ...buildEmptyFallbackResult(),
          postedAt,
          applicationDeadlineAt,
          jobId,
          compensation,
          workArrangement,
          invalidApplyPage,
        };
      }

      return {
        descriptionSnippet: workdayDescription.descriptionSnippet || safeText(visibleText, 1400),
        searchText: workdayDescription.searchText || safeText(visibleText, 12000),
        postedAt,
        applicationDeadlineAt,
        jobId,
        compensation,
        workArrangement,
        invalidApplyPage,
      };
    }

    return {
      descriptionSnippet: workdayDescription.descriptionSnippet || safeText(formatDescriptionForDisplay(description), 1400),
      searchText: workdayDescription.searchText || safeText([description, visibleText].filter(Boolean).join(" \n "), 12000),
      postedAt,
      applicationDeadlineAt,
      jobId,
      compensation,
      workArrangement,
      invalidApplyPage,
    };
  } catch {
    return buildEmptyFallbackResult();
  }
}

function isWorkdayJobUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return /myworkdayjobs\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export async function fetchWorkdayDescriptionFallback(url, options = {}) {
  const detailApiUrl = buildWorkdayDetailApiUrl(url);
  if (!detailApiUrl) {
    return buildEmptyFallbackResult();
  }

  try {
    const payload = await fetchJson(detailApiUrl, options);
    const description = extractWorkdayDescription(payload);
    const postedAt = extractWorkdayPostedAt(payload);
    const applicationDeadlineAt = extractApplicationDeadlineFromPayload(payload);
    const jobId = extractJobIdFromText(JSON.stringify(payload)) || extractJobIdFromUrl(url);
    const compensation = extractCompensationFromPayload(payload);
    const workArrangement = extractWorkArrangementFromPayload(payload);
    if (!description) {
      return {
        ...buildEmptyFallbackResult(),
        postedAt,
        applicationDeadlineAt,
        jobId,
        compensation,
        workArrangement,
      };
    }

    return {
      descriptionSnippet: safeText(formatDescriptionForDisplay(description), 2200),
      searchText: cleanText(description),
      postedAt,
      applicationDeadlineAt,
      jobId,
      compensation,
      workArrangement,
      invalidApplyPage: false,
    };
  } catch {
    return buildEmptyFallbackResult();
  }
}

function buildEmptyFallbackResult() {
  return {
    descriptionSnippet: null,
    searchText: null,
    postedAt: null,
    applicationDeadlineAt: null,
    jobId: null,
    compensation: null,
    workArrangement: null,
    invalidApplyPage: false,
  };
}

function inferRawJobCountFromJsonPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidates = [
    payload.jobs,
    payload.jobPostings,
    payload.results,
    payload.searchResults,
    payload.postings,
    payload.offers,
    payload.openings,
    payload.data?.jobs,
    payload.data?.postings,
    payload.data?.results,
    payload.data?.offers,
    payload.result?.jobs,
    payload.result?.postings,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.length;
    }
  }

  return null;
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
  const recency = resolveJobRecencyFields(job);
  const postedAt = recency.postedDate;
  const updatedAt = recency.updatedDate;
  const applicationDeadlineAt = toIsoDate(job.applicationDeadlineAt);
  const applyUrl = normalizeDescriptionFetchUrl(job.applyUrl);
  const searchText = job.searchText || job.descriptionSnippet || null;
  const externalId = deriveExternalJobId(job);
  const derivedLocation = deriveLocationMetadata(job);
  const providedCountry = normalizeCanonicalCountry(job.country);
  const providedLocationLabel = cleanText(job.locationLabel || "");
  const locationLabel = isGenericLocationLabel(providedLocationLabel)
    ? (derivedLocation.locationLabel || providedLocationLabel || "Unspecified")
    : (job.locationLabel || derivedLocation.locationLabel || "Unspecified");
  const arrangementHint = cleanText([
    job.workArrangement,
    locationLabel,
    job.rawLocationText,
    decodeLocationSlug(applyUrl),
    searchText,
    job.descriptionSnippet,
  ].filter(Boolean).join(" \n "));
  const workArrangement = job.workArrangement && job.workArrangement !== "unknown"
    ? job.workArrangement
    : inferWorkArrangement(arrangementHint);

  return {
    id: `${source.provider}:${source.key}:${job.id}`,
    externalId,
    sourceKey: source.key,
    sourceName: source.name || source.company,
    provider: source.provider,
    company: deriveEmployerCompany(job, source),
    title: job.title || "Untitled role",
    team: job.team || null,
    department: job.department || null,
    locationLabel,
    city: job.city || derivedLocation.city || null,
    region: job.region || derivedLocation.region || null,
    country: providedCountry || derivedLocation.country || null,
    workArrangement,
    postedAt,
    updatedAt,
    postedDate: recency.postedDate,
    updatedDate: recency.updatedDate,
    firstSeenDate: recency.firstSeenDate,
    parsedRecencyDate: recency.parsedRecencyDate,
    dateStatus: recency.dateStatus || "unknown",
    applyUrl,
    descriptionSnippet: job.descriptionSnippet || null,
    searchText,
    employmentType: job.employmentType || null,
    compensation: job.compensation || null,
    applicationDeadlineAt,
    rawLocationText: job.rawLocationText || derivedLocation.rawLocationText || locationLabel || null,
    coordinates: job.coordinates || null,
  };
}

export function deriveEmployerCompany(job = {}, source = {}) {
  const explicit = normalizeCompany(String(job.company || "").trim(), "");
  const derivedFromUrl = extractCompanyFromApplyUrl(job.applyUrl);

  if (derivedFromUrl) {
    return derivedFromUrl;
  }

  return normalizeCompany(explicit || source.company || "", "Unknown company");
}

function deriveExternalJobId(job = {}) {
  const explicit = extractJobIdFromValue(job.id)
    || extractJobIdFromValue(job.externalId)
    || extractJobIdFromValue(job.jobId);
  if (explicit) {
    return explicit;
  }

  const fromUrl = extractJobIdFromUrl(normalizeDescriptionFetchUrl(job.applyUrl));
  if (fromUrl) {
    return fromUrl;
  }

  const fromText = extractJobIdFromText([
    job.searchText,
    job.descriptionSnippet,
    job.title,
  ].filter(Boolean).join(" \n "));
  if (fromText) {
    return fromText;
  }

  return String(job.id || job.applyUrl || "").trim();
}

function extractCompanyFromApplyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

    let slug = "";
    if (/^(?:boards|job-boards)\.greenhouse\.io$/i.test(host)) {
      slug = segments[0] || "";
    } else if (/^jobs\.ashbyhq\.com$/i.test(host)) {
      slug = segments[0] || "";
    } else if (/^jobs\.lever\.co$/i.test(host)) {
      slug = segments[0] || "";
    } else if (/^www\.careers-page\.com$/i.test(url.hostname.toLowerCase()) || /^careers-page\.com$/i.test(host)) {
      slug = segments[0] || "";
    } else if (/\.icims\.com$/i.test(host)) {
      const subdomain = host.split(".")[0] || "";
      slug = subdomain
        .replace(/^careers-/i, "")
        .replace(/^canada-/i, "")
        .replace(/^jobs-/i, "")
        .trim();
    }

    return humanizeCompanySlug(slug);
  } catch {
    return "";
  }
}

function humanizeCompanySlug(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const cleaned = raw
    .replace(/^@+/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }

  const compact = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const specialCases = new Map([
    ["openai", "OpenAI"],
    ["xai", "xAI"],
    ["ibm", "IBM"],
    ["f5", "F5"],
    ["taxbit", "Taxbit"],
    ["constantcontact", "Constant Contact"],
    ["aetherglobal", "AetherGlobal"],
    ["bned", "BNED"],
    ["appliedsystems", "Applied Systems"],
    ["constructconnect", "ConstructConnect"],
    ["cotiviti", "Cotiviti"],
    ["framatome", "Framatome"],
  ]);
  if (specialCases.has(compact)) {
    return specialCases.get(compact);
  }

  if (!/[a-z]/i.test(cleaned)) {
    return "";
  }

  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function deriveLocationMetadata(job = {}) {
  const existingLocation = cleanText(job.locationLabel || "");
  const existingRawLocation = cleanText(job.rawLocationText || "");
  const combinedText = cleanText([
    job.title,
    job.locationLabel,
    job.rawLocationText,
    job.searchText,
    job.descriptionSnippet,
  ].filter(Boolean).join(" \n "));

  const hasUsableLocation = existingLocation
    && !["unspecified", "n/a"].includes(existingLocation.toLowerCase());
  const hasGenericLocation = isGenericLocationLabel(existingLocation);

  let fragment = hasUsableLocation ? existingLocation : null;
  if (!fragment && existingRawLocation && !["unspecified", "n/a"].includes(existingRawLocation.toLowerCase())) {
    fragment = existingRawLocation;
  }
  if (!fragment) {
    fragment = extractLocationFragment(job.title) || extractLocationFragment(combinedText);
  }

  const specificFragment = extractLocationFragment(job.title) || extractLocationFragment(combinedText);
  if (hasGenericLocation && specificFragment) {
    fragment = specificFragment;
  }

  const parsed = parseLocationFragment(fragment);
  const parsedLocationLabel = parsed.locationLabel || buildLocationLabelFromParts(parsed);
  return {
    locationLabel: hasGenericLocation
      ? (parsedLocationLabel || existingLocation || null)
      : hasUsableLocation
        ? existingLocation
        : (parsedLocationLabel || null),
    city: parsed.city || null,
    region: parsed.region || null,
    country: parsed.country || (existingLocation && /^united states|us|usa$/i.test(existingLocation) ? "US" : null),
    rawLocationText: parsedLocationLabel || fragment || existingRawLocation || null,
  };
}

function extractLocationFragment(value) {
  const text = cleanText(value);
  if (!text) {
    return null;
  }

  const patterns = [
    /\bLocation\s*:\s*([^|]{2,160})/i,
    /\bJob\s+Locations?\s*[:\-]?\s*(US-[A-Z]{2}-[A-Za-z .'-]+?)(?=\s+(?:ID|Title)\b|$)/i,
    /\bBased in\s+([^|,.]{2,80}(?:,\s*[^|,.]{2,80})?)/i,
    /\bRemote\s*,\s*(United States|US|USA|Philippines|India|Canada)\b/i,
    /\bLocation\s+(US-[A-Z]{2}-[A-Za-z .'-]+?)(?=\s+(?:ID|Title)\b|$)/i,
    /\b(?:hybrid|onsite)[^.!?\n]{0,80}\bat our ([A-Za-z .'-]+) office\b/i,
    /\(([A-Za-z .'-]+,\s*[A-Z]{2})\)\s*$/i,
    /\(([A-Za-z .'-]+,\s*(?:Texas|California|Washington|Florida|New York|Philippines|India|Canada))\)\s*$/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = cleanLocationFragment(match?.[1] || match?.[0] || "");
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function cleanLocationFragment(value) {
  const text = cleanText(value);
  if (!text) {
    return null;
  }

  return text
    .replace(/\bID\b\s+[A-Z0-9-]+.*$/i, "")
    .replace(/\bTitle\b[\s\S]*$/i, "")
    .replace(/\b(About The Client|About the Client|Employment Type|Job Description|Key Responsibilities|Apply for Position|Or refer someone)\b[\s\S]*$/i, "")
    .replace(/\b(Post Information|Requisition ID|Position Type)\b[\s\S]*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    || null;
}

function decodeLocationSlug(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    const decodedPath = decodeURIComponent(parsed.pathname)
      .replace(/[-_]{2,}/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleanText(decodedPath);
  } catch {
    return cleanText(raw);
  }
}

function parseLocationFragment(fragment) {
  const value = cleanLocationFragment(fragment);
  if (!value) {
    return { locationLabel: null, city: null, region: null, country: null };
  }

  const strippedPrefix = stripLocationPrefix(value);
  if (strippedPrefix && strippedPrefix !== value) {
    const parsedStrippedPrefix = parseLocationFragment(strippedPrefix);
    if (parsedStrippedPrefix?.country || parsedStrippedPrefix?.region || parsedStrippedPrefix?.city) {
      return parsedStrippedPrefix;
    }
  }

  const usRemoteSuffixMatch = value.match(/^(.+?),\s*([A-Z]{2})\s*-\s*(Remote|Hybrid|Onsite|On-site)$/i);
  if (usRemoteSuffixMatch) {
    const city = cleanText(usRemoteSuffixMatch[1]);
    const region = normalizeUsRegion(usRemoteSuffixMatch[2]);
    if (city && region) {
      return {
        locationLabel: value,
        city,
        region,
        country: "US",
      };
    }
  }

  const icimsUsMatch = value.match(/^US-([A-Z]{2})-([A-Za-z .'-]+)$/i);
  if (icimsUsMatch) {
    const region = icimsUsMatch[1].toUpperCase();
    const city = cleanText(icimsUsMatch[2]);
    return {
      locationLabel: [city, region].filter(Boolean).join(", "),
      city: city || null,
      region,
      country: "US",
    };
  }

  const dotDelimitedMatch = value.match(/^([A-Z]{2,3})\.([A-Z]{2})\.([A-Za-z .'-]+)$/);
  if (dotDelimitedMatch) {
    const countryCode = normalizeCountryCode(dotDelimitedMatch[1]);
    const region = normalizeUsRegion(dotDelimitedMatch[2]) || cleanText(dotDelimitedMatch[2]);
    const city = cleanText(dotDelimitedMatch[3]);
    return {
      locationLabel: [city, region].filter(Boolean).join(", "),
      city: city || null,
      region: region || null,
      country: countryCode === "US" ? "US" : normalizeCountryValue(countryCode) || countryCode,
    };
  }

  const dotDelimitedCountryCityMatch = value.match(/^([A-Z]{2,3})\.([A-Za-z .'-]+)$/);
  if (dotDelimitedCountryCityMatch) {
    const countryCode = normalizeCountryCode(dotDelimitedCountryCityMatch[1]);
    const city = cleanText(dotDelimitedCountryCityMatch[2]);
    return {
      locationLabel: city || value,
      city: city || null,
      region: null,
      country: countryCode === "US" ? "US" : normalizeCountryValue(countryCode) || countryCode,
    };
  }

  const dashedCountryCityMatch = value.match(/^([A-Z]{2,3})-([A-Za-z .'-]+)$/);
  if (dashedCountryCityMatch) {
    const countryCode = normalizeCountryCode(dashedCountryCityMatch[1]);
    const city = cleanText(dashedCountryCityMatch[2]);
    const officeAlias = normalizeOfficeAlias(city);
    if (officeAlias && countryCode && officeAlias.country && officeAlias.country !== "US") {
      return officeAlias;
    }
    return {
      locationLabel: city || value,
      city: city || null,
      region: null,
      country: normalizeCanonicalCountry(countryCode),
    };
  }

  if (/^(United States|US|USA)$/i.test(value)) {
    return { locationLabel: "United States", city: null, region: null, country: "US" };
  }

  if (/^(Philippines|India|Canada|Ireland|Israel|United Kingdom|UK|Thailand|Germany|Switzerland|Austria|Spain|China|Luxembourg|Italy|Greece)$/i.test(value)) {
    const country = capitalizeLocationWord(value);
    return { locationLabel: country, city: null, region: null, country };
  }

  if (/^Remote,\s*(United States|US|USA|Philippines|India|Canada|Ireland|Israel|United Kingdom|UK|Thailand|Germany|Switzerland|Austria|Spain|China|Luxembourg|Italy|Greece)$/i.test(value)) {
    const countryMatch = value.match(/^Remote,\s*(.+)$/i)?.[1] || "";
    const normalizedCountry = normalizeCountryValue(countryMatch);
    return {
      locationLabel: `Remote, ${normalizedCountry || countryMatch.trim()}`,
      city: null,
      region: null,
      country: normalizedCountry === "United States" ? "US" : normalizedCountry,
    };
  }

  if (/^(Remote|Hybrid|Onsite|On-site)\s*-\s*(United States|US|USA)$/i.test(value)
    || /^(United States|US|USA)\s*-\s*(Remote|Hybrid|Onsite|On-site)$/i.test(value)) {
    return {
      locationLabel: value,
      city: null,
      region: null,
      country: "US",
    };
  }

  const knownNonUsCity = normalizeKnownNonUsCityFragment(value);
  if (knownNonUsCity) {
    return knownNonUsCity;
  }

  const parts = value.split(",").map((part) => cleanText(part)).filter(Boolean);
  if (parts.length >= 2) {
    const firstPartCountry = normalizeCountryValue(parts[0]);
    if (firstPartCountry) {
      const remainingParts = parts.slice(1);
      const regionFirst = remainingParts[0] ? normalizeUsRegion(remainingParts[0]) : null;
      const city = remainingParts.length >= 2 && regionFirst ? remainingParts[1] : (remainingParts[0] || null);
      const region = regionFirst || (remainingParts.length >= 2 ? normalizeUsRegion(remainingParts[1]) || remainingParts[1] : null);
      return {
        locationLabel: buildLocationLabelFromParts({
          city,
          region: region || null,
          country: firstPartCountry === "United States" ? "US" : firstPartCountry,
        }) || [city, region || firstPartCountry].filter(Boolean).join(", "),
        city,
        region: region || null,
        country: firstPartCountry === "United States" ? "US" : firstPartCountry,
      };
    }

    const lastPart = parts[parts.length - 1];
    const stateCode = normalizeUsRegion(lastPart);
    const country = normalizeCountryValue(lastPart);
    if (country) {
      const city = parts.length >= 2 ? parts[0] : null;
      const region = parts.length >= 3 ? normalizeUsRegion(parts[parts.length - 2]) : null;
      return {
        locationLabel: parts.join(", "),
        city: city || null,
        region: region || null,
        country: country === "United States" ? "US" : country,
      };
    }
    if (stateCode) {
      return {
        locationLabel: parts.join(", "),
        city: parts[0] || null,
        region: stateCode,
        country: "US",
      };
    }
  }

  const stateOnly = normalizeUsRegion(value);
  if (stateOnly) {
    return {
      locationLabel: stateOnly,
      city: null,
      region: stateOnly,
      country: "US",
    };
  }

  const officeAlias = normalizeOfficeAlias(value);
  if (officeAlias) {
    return officeAlias;
  }

  return {
    locationLabel: value,
    city: null,
    region: null,
    country: null,
  };
}

function buildLocationLabelFromParts(location = {}) {
  const city = cleanText(location.city || "");
  const region = cleanText(location.region || "");
  const country = normalizeCanonicalCountry(location.country);
  if (city && region) {
    return `${city}, ${region}`;
  }
  if (city && country && country !== "US") {
    return `${city}, ${country}`;
  }
  if (city) {
    return city;
  }
  if (region && country && country !== "US") {
    return `${region}, ${country}`;
  }
  if (region) {
    return region;
  }
  return country || null;
}

function normalizeCountryValue(value) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return null;
  }
  if (/^(United States|US|USA)$/i.test(normalized)) {
    return "United States";
  }
  if (/^Philippines$/i.test(normalized)) {
    return "Philippines";
  }
  if (/^India$/i.test(normalized)) {
    return "India";
  }
  if (/^Canada$/i.test(normalized)) {
    return "Canada";
  }
  if (/^(United Kingdom|UK|GB|Great Britain)$/i.test(normalized)) {
    return "United Kingdom";
  }
  if (/^Ireland$/i.test(normalized)) {
    return "Ireland";
  }
  if (/^Israel$/i.test(normalized)) {
    return "Israel";
  }
  if (/^Thailand$/i.test(normalized)) {
    return "Thailand";
  }
  if (/^Germany$/i.test(normalized)) {
    return "Germany";
  }
  if (/^Switzerland$/i.test(normalized)) {
    return "Switzerland";
  }
  if (/^Austria$/i.test(normalized)) {
    return "Austria";
  }
  if (/^Spain$/i.test(normalized)) {
    return "Spain";
  }
  if (/^China$/i.test(normalized)) {
    return "China";
  }
  if (/^Luxembourg$/i.test(normalized)) {
    return "Luxembourg";
  }
  if (/^Italy$/i.test(normalized)) {
    return "Italy";
  }
  if (/^Greece$/i.test(normalized)) {
    return "Greece";
  }
  return null;
}

function normalizeCountryCode(value) {
  const cleaned = cleanText(value || "");
  const normalized = cleaned ? cleaned.toUpperCase() : "";
  if (!normalized) {
    return null;
  }
  if (normalized === "USA" || normalized === "US") {
    return "US";
  }
  if (normalized === "IND") {
    return "India";
  }
  if (normalized === "CAN") {
    return "Canada";
  }
  if (normalized === "GBR" || normalized === "GB" || normalized === "UK") {
    return "United Kingdom";
  }
  if (normalized === "IRL") {
    return "Ireland";
  }
  return null;
}

function normalizeCanonicalCountry(value) {
  const code = normalizeCountryCode(value);
  if (code) {
    return code === "US" ? "US" : code;
  }
  const normalizedCountry = normalizeCountryValue(value);
  if (!normalizedCountry) {
    return null;
  }
  return normalizedCountry === "United States" ? "US" : normalizedCountry;
}

function stripLocationPrefix(value) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return "";
  }

  const separators = [" - ", " | "];
  for (const separator of separators) {
    if (!normalized.includes(separator)) {
      continue;
    }

    const trailing = cleanText(normalized.split(separator).pop() || "");
    if (!trailing || trailing === normalized) {
      continue;
    }

    if (
      trailing.includes(",")
      || /^[A-Z]{2,3}\.[A-Z]{2}(?:\.[A-Za-z .'-]+)?$/.test(trailing)
      || /^US-[A-Z]{2}-/i.test(trailing)
      || normalizeOfficeAlias(trailing)
      || normalizeCountryValue(trailing)
      || normalizeUsRegion(trailing)
      || trailing.split(/\s+/).length <= 4
    ) {
      return trailing;
    }
  }

  return "";
}

function normalizeUsRegion(value) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return null;
  }

  const directCode = normalized.toUpperCase();
  if (US_STATE_CODES.has(directCode)) {
    return directCode;
  }

  return US_STATE_NAMES.get(normalized.toLowerCase()) || null;
}

function normalizeKnownNonUsCityFragment(value) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return null;
  }

  if (/\b(?:gurgaon|gurugram)\b/i.test(normalized)) {
    return {
      locationLabel: "Gurgaon, India",
      city: "Gurgaon",
      region: null,
      country: "India",
    };
  }

  return null;
}

function capitalizeLocationWord(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, char) => char.toUpperCase());
}

export function isGenericLocationLabel(value) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return false;
  }
  if (/^US-[A-Z]{2}-[A-Za-z .'-]+$/i.test(normalized)) {
    return true;
  }
  if (/^[A-Z]{2,3}\.[A-Z]{2}\.[A-Za-z .'-]+$/i.test(normalized)) {
    return true;
  }
  return [
    "unspecified",
    "n/a",
    "unknown",
    "united states",
    "us",
    "usa",
    "remote in united states",
    "remote in the us",
    "us remote",
  ].includes(normalized.toLowerCase());
}

function normalizeOfficeAlias(value) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return null;
  }

  const key = normalized.toLowerCase().replace(/\boffice\b/g, "").trim();
  const mapped = OFFICE_LOCATION_ALIASES.get(key);
  return mapped || null;
}

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI", "IA", "ID", "IL",
  "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE",
  "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT",
  "VA", "VT", "WA", "WI", "WV", "WY",
]);

const US_STATE_NAMES = new Map([
  ["alabama", "AL"], ["alaska", "AK"], ["arizona", "AZ"], ["arkansas", "AR"], ["california", "CA"],
  ["colorado", "CO"], ["connecticut", "CT"], ["delaware", "DE"], ["district of columbia", "DC"],
  ["florida", "FL"], ["georgia", "GA"], ["hawaii", "HI"], ["idaho", "ID"], ["illinois", "IL"],
  ["indiana", "IN"], ["iowa", "IA"], ["kansas", "KS"], ["kentucky", "KY"], ["louisiana", "LA"],
  ["maine", "ME"], ["maryland", "MD"], ["massachusetts", "MA"], ["michigan", "MI"], ["minnesota", "MN"],
  ["mississippi", "MS"], ["missouri", "MO"], ["montana", "MT"], ["nebraska", "NE"], ["nevada", "NV"],
  ["new hampshire", "NH"], ["new jersey", "NJ"], ["new mexico", "NM"], ["new york", "NY"],
  ["north carolina", "NC"], ["north dakota", "ND"], ["ohio", "OH"], ["oklahoma", "OK"], ["oregon", "OR"],
  ["pennsylvania", "PA"], ["rhode island", "RI"], ["south carolina", "SC"], ["south dakota", "SD"],
  ["tennessee", "TN"], ["texas", "TX"], ["utah", "UT"], ["vermont", "VT"], ["virginia", "VA"],
  ["washington", "WA"], ["west virginia", "WV"], ["wisconsin", "WI"], ["wyoming", "WY"],
]);

const OFFICE_LOCATION_ALIASES = new Map([
  ["sf", { locationLabel: "San Francisco, CA", city: "San Francisco", region: "CA", country: "US" }],
  ["san francisco", { locationLabel: "San Francisco, CA", city: "San Francisco", region: "CA", country: "US" }],
  ["berkeley", { locationLabel: "Berkeley, CA", city: "Berkeley", region: "CA", country: "US" }],
  ["lehi", { locationLabel: "Lehi, UT", city: "Lehi", region: "UT", country: "US" }],
  ["nyc", { locationLabel: "New York, NY", city: "New York", region: "NY", country: "US" }],
  ["new york", { locationLabel: "New York, NY", city: "New York", region: "NY", country: "US" }],
  ["washington, d.c.", { locationLabel: "Washington, D.C.", city: "Washington", region: "DC", country: "US" }],
  ["washington dc", { locationLabel: "Washington, D.C.", city: "Washington", region: "DC", country: "US" }],
  ["reston", { locationLabel: "Reston, VA", city: "Reston", region: "VA", country: "US" }],
  ["seattle", { locationLabel: "Seattle, WA", city: "Seattle", region: "WA", country: "US" }],
  ["chicago", { locationLabel: "Chicago, IL", city: "Chicago", region: "IL", country: "US" }],
  ["glasgow", { locationLabel: "Glasgow, United Kingdom", city: "Glasgow", region: null, country: "United Kingdom" }],
  ["dublin", { locationLabel: "Dublin, Ireland", city: "Dublin", region: null, country: "Ireland" }],
  ["chennai", { locationLabel: "Chennai, India", city: "Chennai", region: null, country: "India" }],
  ["toronto", { locationLabel: "Toronto, Canada", city: "Toronto", region: null, country: "Canada" }],
  ["vancouver", { locationLabel: "Vancouver, Canada", city: "Vancouver", region: null, country: "Canada" }],
]);

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

function extractWorkdayPostedAt(payload) {
  const candidates = [
    payload?.jobPostingInfo?.postedOn,
    payload?.jobPostingInfo?.postedDate,
    payload?.jobPostingInfo?.startDate,
    payload?.postedOn,
    payload?.postedDate,
  ];

  for (const value of candidates) {
    const iso = toIsoDate(value);
    if (iso) {
      return iso;
    }
  }

  return null;
}

function extractCompensationFromPayload(payload) {
  const candidates = [
    payload?.jobPostingInfo?.compensation,
    payload?.jobPostingInfo?.compensationText,
    payload?.jobPostingInfo?.salaryRange,
    payload?.jobPostingInfo?.payRange,
    payload?.compensation,
    payload?.salaryRange,
    payload?.payRange,
    JSON.stringify(payload),
  ];

  for (const value of candidates) {
    const extracted = extractCompensationFromText(value);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

function extractWorkArrangementFromPayload(payload) {
  const candidates = [
    payload?.jobPostingInfo?.workplaceType,
    payload?.jobPostingInfo?.workArrangement,
    payload?.jobPostingInfo?.locationType,
    payload?.jobPostingInfo?.remoteType,
    payload?.jobPostingInfo?.jobLocationType,
    payload?.jobPostingInfo?.locationsText,
    payload?.workplaceType,
    payload?.workArrangement,
    payload?.locationType,
    payload?.remoteType,
    payload?.locationsText,
    JSON.stringify(payload),
  ];

  for (const value of candidates) {
    const arrangement = inferWorkArrangement(cleanText(value || ""));
    if (arrangement && arrangement !== "unknown") {
      return arrangement;
    }
  }

  return null;
}

function extractWorkdayPostedAtFromHtml(html) {
  const text = cleanText([
    html.match(/data-automation-id=["']postedOn["'][\s\S]{0,500}?<dd[^>]*>([\s\S]*?)<\/dd>/i)?.[1],
    html.match(/\bposted on<\/dt>[\s\S]{0,300}?<dd[^>]*>([\s\S]*?)<\/dd>/i)?.[1],
    html.match(/\bPosted\s+\d+\+?\s+Days?\s+Ago\b/i)?.[0],
    html.match(/\bPosted\s+(?:Today|Yesterday)\b/i)?.[0],
  ].filter(Boolean).join(" "));
  return toIsoDate(text);
}

function extractApplicationDeadlineFromPayload(payload) {
  const candidates = [
    payload?.jobPostingInfo?.applicationDeadline,
    payload?.jobPostingInfo?.applicationDeadlineDate,
    payload?.jobPostingInfo?.endDate,
    payload?.applicationDeadline,
    payload?.applicationDeadlineDate,
    payload?.endDate,
  ];

  for (const value of candidates) {
    const iso = toIsoDate(value);
    if (iso) {
      return iso;
    }
  }

  return extractApplicationDeadlineFromText(JSON.stringify(payload));
}

function extractApplicationDeadlineFromHtml(html) {
  const text = cleanText(extractVisibleTextFromHtml(html));
  return extractApplicationDeadlineFromText(text);
}

function extractCompensationFromHtml(html) {
  const htmlText = String(html || "");
  const visibleText = cleanText(extractVisibleTextFromHtml(htmlText));
  const htmlLabelPatterns = [
    /(?:posted\s+salary\s+range|salary\s+range|pay\s+range|base\s+salary|base\s+pay|compensation)\s*<\/dt>[\s\S]{0,300}?<dd[^>]*>([\s\S]*?)<\/dd>/i,
    /(?:posted\s+salary\s+range|salary\s+range|pay\s+range|base\s+salary|base\s+pay|compensation)\s*[:\-]?\s*([\s\S]{0,180}?)(?:<\/(?:span|p|dd|li)>|<br|$)/i,
  ];

  for (const pattern of htmlLabelPatterns) {
    const match = htmlText.match(pattern);
    const extracted = extractCompensationFromText(match?.[1] || match?.[0] || "");
    if (extracted) {
      return extracted;
    }
  }

  return extractCompensationFromText(visibleText);
}

function extractCompensationFromText(value) {
  const normalized = cleanText(value || "");
  if (!normalized) {
    return null;
  }

  const patterns = [
    /(?:posted\s+salary\s+range|salary\s+range|pay\s+range|base\s+salary|base\s+pay|compensation)(?:\s+range)?[:\s-]*(?:USD|CAD|EUR|GBP|AUD|NZD|JPY|\$|£|€)?[^.;|]{0,160}?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?(?:[^.;|]{0,80}?(?:-|to)\s*(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)?\s?\d[\d,]*(?:\.\d{2})?)?[^.;|]{0,40}(?:annual|yearly|per year|yr|hourly|per hour|hour|\/yr\.?|\/hr\.?)?/i,
    /(?:base\s+compensation\s+ranges?\s+from|salary\s+ranges?\s+from|pay\s+ranges?\s+from)[^.;|]{0,120}?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?(?:[^.;|]{0,50}?(?:-|to)\s*(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)?\s?\d[\d,]*(?:\.\d{2})?)?[^.;|]{0,40}(?:annual|yearly|per year|yr|hourly|per hour|hour|\/yr\.?|\/hr\.?)?/i,
    /(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?\s*(?:-|to)\s*(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?\s*(?:annual|yearly|per year|yr|hourly|per hour|hour|\/yr\.?|\/hr\.?)?/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = cleanCompensationCandidate(match?.[0] || "");
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function cleanCompensationCandidate(value) {
  const text = cleanText(value || "");
  if (!text) {
    return null;
  }

  let cleaned = text
    .replace(/^(posted\s+salary\s+range|salary\s+range|pay\s+range|base\s+salary|base\s+pay|compensation)(?:\s+range)?[:\s-]*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const stopPatterns = [
    /\bour approach to flexible work\b/i,
    /\babout (?:the role|the team|us)\b/i,
    /\bbenefits\b/i,
    /\brecruiters can share more detail\b/i,
    /\bprimary location\b/i,
    /\badditional [A-Z]{2,3} location\(s\)\b/i,
    /\bminimum qualifications\b/i,
    /\bresponsibilities\b/i,
    /\brequirements\b/i,
  ];

  for (const pattern of stopPatterns) {
    const match = cleaned.match(pattern);
    if (match?.index > 0) {
      cleaned = cleaned.slice(0, match.index).trim();
      break;
    }
  }

  return /[$£€¥]|\b(?:USD|CAD|EUR|GBP|AUD|NZD|JPY)\b/i.test(cleaned) ? cleaned : null;
}

function extractExplicitWorkArrangementFromHtml(html, visibleText = "") {
  const htmlText = String(html || "");
  const labelPatterns = [
    /(?:location\s+type|workplace\s+type|work\s+arrangement|remote\s+type)\s*<\/dt>[\s\S]{0,220}?<dd[^>]*>([\s\S]*?)<\/dd>/i,
    /(?:location\s+type|workplace\s+type|work\s+arrangement|remote\s+type)\s*[:\-]?\s*(remote|hybrid|onsite|on-site|in office|in-office)/i,
  ];

  for (const pattern of labelPatterns) {
    const match = htmlText.match(pattern);
    const arrangement = inferWorkArrangement(cleanText(match?.[1] || match?.[0] || ""));
    if (arrangement && arrangement !== "unknown") {
      return arrangement;
    }
  }

  const arrangement = inferWorkArrangement(cleanText(visibleText || ""));
  return arrangement !== "unknown" ? arrangement : null;
}

function isInvalidApplyPage(html, visibleText, urlValue) {
  const text = cleanText(visibleText || extractVisibleTextFromHtml(html));
  const normalizedUrl = String(urlValue || "").toLowerCase();
  if (!text) {
    return false;
  }

  const brokenPatterns = [
    /\bthis page doesn['’]t exist\b/i,
    /\bpage not found\b/i,
    /\bjob (?:does not exist|not found|is no longer available)\b/i,
    /\bposition is no longer available\b/i,
    /\bno longer accepting applications\b/i,
    /\bthe job you are looking for has expired\b/i,
  ];

  if (brokenPatterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  if (/\bjoin our talent community\b/i.test(text)) {
    return true;
  }

  if (/\bopen roles\b/i.test(text)
    && /\ball departments\b/i.test(text)
    && /\ball locations\b/i.test(text)
    && !/\/jobs\/\d+|\/job\/[^/]+\/[^/]+\/[a-z0-9-]+/i.test(normalizedUrl)) {
    return true;
  }

  return false;
}

export function extractApplicationDeadlineFromText(value) {
  const text = cleanText(value || "");
  if (!text) {
    return null;
  }

  const patterns = [
    /\b(?:deadline|application deadline|applications accepted until|apply by|closing date|closes on|closing on|close date|close on|application window(?:\s+will)?\s+close on)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM))?(?:\s+[A-Z]{2,4})?)/i,
    /\b(?:deadline|application deadline|applications accepted until|apply by|closing date|closes on|closing on|close date|close on|application window(?:\s+will)?\s+close on)\s*[:\-]?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM))?(?:\s+[A-Z]{2,4})?)/i,
    /\b(?:deadline|application deadline|applications accepted until|apply by|closing date|closes on|closing on|close date|close on|application window(?:\s+will)?\s+close on)\s*[:\-]?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = String(match?.[1] || "").replace(/\s+at\s+/i, " ").trim();
    const iso = toIsoDate(candidate);
    if (iso) {
      return iso;
    }
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

export function normalizeDescriptionFetchUrl(url) {
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

    if (/^careers\.expediagroup\.com$/i.test(parsed.hostname) || /^careers\.expediagroup\.com$/i.test(parsed.hostname.replace(/^www\./i, ""))) {
      parsed.protocol = "https:";
      return parsed.toString();
    }

    if (/\.icims\.com$/i.test(parsed.hostname) && /\/jobs\/\d+\/.+\/job\/?$/i.test(parsed.pathname)) {
      if (!parsed.searchParams.has("in_iframe")) {
        parsed.searchParams.set("in_iframe", "1");
      }
      return parsed.toString();
    }
  } catch {
    if (/^http:\/\/careers\.expediagroup\.com\//i.test(value)) {
      return value.replace(/^http:/i, "https:");
    }
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

  const text = cleanText(extractVisibleTextFromHtml(html));
  const labeledPatterns = [
    /\b(?:date of posting|date posted|posted on|posting date)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i,
    /\b(?:date of posting|date posted|posted on|posting date)\s*[:\-]?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i,
    /\bPosted\s+(\d+\+?\s+Days?\s+Ago|Today|Yesterday)\b/i,
  ];

  for (const pattern of labeledPatterns) {
    const match = text.match(pattern);
    const candidate = String(match?.[1] || "").trim();
    const iso = toIsoDate(candidate);
    if (iso) {
      return iso;
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

function extractJobIdFromHtml(html, urlValue = "") {
  const visibleText = cleanText(extractVisibleTextFromHtml(html));
  return extractJobIdFromText(visibleText) || extractJobIdFromUrl(urlValue);
}

function extractJobIdFromText(value) {
  const text = cleanText(value || "");
  if (!text) {
    return "";
  }

  const patterns = [
    /\b(?:job\s*id|id\s*#|req(?:uisition)?\s*id|job\s*requisition\s*id|position\s*id|posting\s*id|id)\s*[:#-]?\s*([A-Za-z]+-\d+(?:-\d+)?|[A-Za-z]\d+(?:-\d+)?|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4,}-\d{4,}|\d{4,})\b/i,
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
    /\b(R-\d+(?:-\d+)?)\b/i,
    /\b([A-Za-z]\d+(?:-\d+)?)\b/,
    /\b(\d{4,}-\d{4,})\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = extractJobIdFromValue(match?.[1] || "");
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function extractJobIdFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    const queryCandidates = [
      url.searchParams.get("gh_jid"),
      url.searchParams.get("jobId"),
      url.searchParams.get("jobid"),
      url.searchParams.get("req"),
      url.searchParams.get("reqId"),
      url.searchParams.get("requisitionId"),
      url.searchParams.get("jid"),
      url.searchParams.get("job"),
    ];

    for (const candidate of queryCandidates) {
      const normalized = extractJobIdFromValue(candidate);
      if (normalized) {
        return normalized;
      }
    }

    const pathMatches = [
      url.pathname.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i),
      url.pathname.match(/\/(R-\d+(?:-\d+)?)\/?$/i),
      url.pathname.match(/\/jobs\/(\d{4,})(?:\/|$)/i),
      url.pathname.match(/\/position\/(\d{4,})(?:\/|$)/i),
      url.pathname.match(/\/job\/([A-Z0-9]{6,12})\/?$/i),
      url.pathname.match(/\/job\/[^/]+\/[^/]+\/([A-Za-z]-?\d+(?:-\d+)?)\/?$/i),
      url.pathname.match(/\/job\/(\d{4,}-\d{4,})\/?$/i),
      url.pathname.match(/_([A-Za-z]\d+(?:-\d+)?)\/?$/i),
    ];

    for (const match of pathMatches) {
      const normalized = extractJobIdFromValue(match?.[1] || "");
      if (normalized) {
        return normalized;
      }
    }
  } catch {}

  const rawPathMatches = [
    raw.match(/\/position\/(\d{4,})(?:\/|$)/i),
    raw.match(/\/jobs\/(\d{4,})(?:\/|$)/i),
    raw.match(/\/job\/([A-Z0-9]{6,12})(?:\/|$)/i),
    raw.match(/_([A-Za-z]\d+(?:-\d+)?)\/?$/i),
  ];

  for (const match of rawPathMatches) {
    const normalized = extractJobIdFromValue(match?.[1] || "");
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function extractJobIdFromValue(value) {
  const raw = String(value || "").trim();
  if (!raw || /^https?:/i.test(raw) || raw === "undefined" || raw === "null") {
    return "";
  }

  if (/^[A-Za-z]+-\d+(?:-\d+)?$/i.test(raw)
    || /^[A-Za-z]\d+(?:-\d+)?$/i.test(raw)
    || /^[A-Z0-9]{6,12}$/i.test(raw)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    || /^\d{4,}-\d{4,}$/.test(raw)
    || /^\d{4,}$/.test(raw)) {
    return raw;
  }

  return "";
}
