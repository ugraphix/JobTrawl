import {
  buildNormalizedJob,
  cleanText,
  fetchJson,
  fetchWorkdayDescriptionFallback,
  mapWithConcurrency,
  recordLiveFetchAuditSummary,
  safeText,
} from "./shared.js";

const WORKDAY_DETAIL_CONCURRENCY = 3;
const WORKDAY_DETAIL_MAX_JOBS = 120;
const ZILLOW_DETAIL_MAX_JOBS = 60;
const WORKDAY_LIST_LIMIT = 20;
const WORKDAY_LIST_PAGE_DELAY_MS = 150;
const WORKDAY_LIST_RETRY_DELAY_MS = 800;
const WORKDAY_LIST_MAX_RETRIES = 1;
const WORKDAY_DETAIL_LOCATION_TIMEOUT_MS = 60000;
const WORKDAY_VAGUE_LOCATION_PATTERN = /^(?:\d+\s+locations?|multiple\s+locations?)$/i;
const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI", "IA", "ID", "IL",
  "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE",
  "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT",
  "VA", "VT", "WA", "WI", "WV", "WY",
]);

export async function fetchWorkdayJobs(source, filters = {}) {
  const resolvedSource = resolveWorkdaySourceConfig(source);
  const tenant = resolvedSource.tenant;
  const site = resolvedSource.site;
  const endpoint = resolvedSource.endpoint;

  if (!tenant || !site || !endpoint) {
    recordLiveFetchAuditSummary({
      workdaySourceStatus: "invalid_config",
      workdayTenant: tenant || null,
      workdaySite: site || null,
      workdayEndpoint: endpoint || null,
    });
    return [];
  }

  let offset = 0;
  let total = null;
  const jobs = [];

  while (true) {
    if (offset > 0) {
      await sleep(WORKDAY_LIST_PAGE_DELAY_MS);
    }

    let payload;
    try {
      payload = await fetchWorkdayListPage(endpoint, filters, offset);
    } catch (error) {
      if (isHardInvalidWorkdayError(error)) {
        recordLiveFetchAuditSummary({
          workdaySourceStatus: "invalid_endpoint",
          workdayTenant: tenant,
          workdaySite: site,
          workdayEndpoint: endpoint,
        });
        if (jobs.length === 0) {
          return [];
        }
        break;
      }

      if (isTemporaryWorkdayError(error)) {
        recordLiveFetchAuditSummary({
          workdaySourceStatus: "blocked_or_temporary",
          workdayTenant: tenant,
          workdaySite: site,
          workdayEndpoint: endpoint,
        });
        if (jobs.length === 0) {
          return [];
        }
        break;
      }

      throw error;
    }

    const postings = Array.isArray(payload.jobPostings) ? payload.jobPostings : [];
    if (total === null) {
      total = Number(payload.total || 0);
      if (Number.isFinite(total) && total >= 0) {
        recordLiveFetchAuditSummary({
          rawJobCount: total,
          rawJobCountBasis: "workday_payload_total",
        });
      }
    }
    jobs.push(...postings.map((job, index) => normalizeWorkdayJob(source, job, offset + index)));

    if (postings.length === 0) {
      recordLiveFetchAuditSummary({
        workdaySourceStatus: jobs.length > 0 ? "parsed" : "empty",
        workdayTenant: tenant,
        workdaySite: site,
        workdayEndpoint: endpoint,
      });
      break;
    }

    offset += postings.length;

    if (postings.length < WORKDAY_LIST_LIMIT) {
      break;
    }

    if (total !== null && total > 0 && offset >= total) {
      break;
    }
  }

  if (!Number.isFinite(total) || total < jobs.length) {
    recordLiveFetchAuditSummary({
      rawJobCount: jobs.length,
      rawJobCountBasis: "workday_accumulated_jobpostings",
    });
  }
  if (jobs.length > 0) {
    recordLiveFetchAuditSummary({
      workdaySourceStatus: "parsed",
      workdayTenant: tenant,
      workdaySite: site,
      workdayEndpoint: endpoint,
    });
  }

  const keyword = String(filters.keyword || "").trim();
  const isZillowSource = String(source?.key || "").toLowerCase() === "zillow-careerpage";
  const shouldFetchDetails = source.fetchWorkdayDetails !== false
    && jobs.length > 0
    && (
      Boolean(keyword)
      || jobs.length <= WORKDAY_DETAIL_MAX_JOBS
      || isZillowSource
    );

  if (shouldFetchDetails) {
    const detailJobs = isZillowSource
      ? prioritizeWorkdayDetailJobs(jobs, ZILLOW_DETAIL_MAX_JOBS, keyword)
      : prioritizeWorkdayDetailJobs(jobs, WORKDAY_DETAIL_MAX_JOBS, keyword);
    await enrichWorkdayDescriptions(detailJobs);
  }

  return jobs;
}

async function fetchWorkdayListPage(endpoint, filters, offset) {
  let attempt = 0;
  while (true) {
    try {
      return await fetchJson(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildRequestBody(filters, WORKDAY_LIST_LIMIT, offset)),
      });
    } catch (error) {
      attempt += 1;
      if (!isTemporaryWorkdayError(error) || attempt > WORKDAY_LIST_MAX_RETRIES) {
        throw error;
      }
      await sleep(WORKDAY_LIST_RETRY_DELAY_MS * attempt);
    }
  }
}

function buildRequestBody(filters, limit, offset) {
  const body = { limit, offset };
  const keyword = String(filters.keyword || "").trim();

  if (keyword) {
    body.searchText = keyword;
  }

  return body;
}

function normalizeWorkdayJob(source, job, index) {
  const applyUrl = absoluteWorkdayJobUrl(source, job.externalPath);
  const postingDate = extractPostingDate(job);
  const location = extractWorkdayLocationMetadata(job, applyUrl);

  const normalized = buildNormalizedJob(source, {
    id: job.bulletFields?.[0] || job.externalPath || `${source.key}-${index}`,
    company: source.company,
    title: job.title,
    locationLabel: location.locationLabel || job.locationsText || "Unspecified",
    city: location.city || null,
    region: location.region || null,
    country: location.country || null,
    postedAt: postingDate,
    applyUrl,
    descriptionSnippet: null,
    searchText: null,
    rawLocationText: location.rawLocationText || job.locationsText || null,
  });

  normalized.workdayOriginalLocationLabel = job.locationsText || null;
  return normalized;
}

function resolveWorkdaySourceConfig(source = {}) {
  const derived = deriveWorkdayPartsFromCareersUrl(source.careersUrl);
  const host = derived.host || source.host || "wd5.myworkdaysite.com";
  const tenant = derived.tenant || source.tenant || "";
  const site = derived.site || source.site || "";
  const endpoint = host && tenant && site ? `https://${host}/wday/cxs/${tenant}/${site}/jobs` : null;
  return {
    ...source,
    host,
    tenant,
    site,
    endpoint,
  };
}

function deriveWorkdayPartsFromCareersUrl(careersUrl) {
  try {
    const parsed = new URL(String(careersUrl || "").trim());
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) {
      return {
        host: parsed.hostname,
        tenant: parsed.hostname.split(".")[0] || "",
        site: "",
      };
    }

    if (segments[0].toLowerCase() === "recruiting" && segments.length >= 3) {
      return {
        host: parsed.hostname,
        tenant: segments[1],
        site: segments[2],
      };
    }

    return {
      host: parsed.hostname,
      tenant: parsed.hostname.split(".")[0] || "",
      site: segments[0],
    };
  } catch {
    return {
      host: "",
      tenant: "",
      site: "",
    };
  }
}

function isTemporaryWorkdayError(error) {
  const status = Number(error?.status);
  return status === 403 || status === 429 || status === 502 || status === 503 || status === 504;
}

function isHardInvalidWorkdayError(error) {
  const status = Number(error?.status);
  return status === 404 || status === 410 || status === 422;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function enrichWorkdayDescriptions(jobs) {
  await mapWithConcurrency(jobs, WORKDAY_DETAIL_CONCURRENCY, async (job) => {
    if (!job?.applyUrl) {
      return job;
    }

    if (workdayNeedsDetailLocation(job)) {
      const detailLocation = await fetchWorkdayDetailLocationMetadata(job.applyUrl);
      applyWorkdayLocationMetadata(job, detailLocation);
    }

    const fallback = await fetchWorkdayDescriptionFallback(job.applyUrl);
    if (fallback.descriptionSnippet || fallback.searchText) {
      job.descriptionSnippet = fallback.descriptionSnippet || safeText(cleanText(fallback.searchText), 2200) || null;
      job.searchText = fallback.searchText || fallback.descriptionSnippet || null;
    }
    if (!job.postedAt && fallback.postedAt) {
      job.postedAt = fallback.postedAt;
    }
    if (!job.applicationDeadlineAt && fallback.applicationDeadlineAt) {
      job.applicationDeadlineAt = fallback.applicationDeadlineAt;
    }
    if (!job.compensation && fallback.compensation) {
      job.compensation = fallback.compensation;
    }
    if ((!job.externalId || /^https?:/i.test(String(job.externalId || "").trim())) && fallback.jobId) {
      job.externalId = fallback.jobId;
    }
    if ((!job.workArrangement || job.workArrangement === "unknown") && fallback.workArrangement) {
      job.workArrangement = fallback.workArrangement;
    }

    return job;
  });
}

function prioritizeWorkdayDetailJobs(jobs, limit, keyword = "") {
  const keywordTerms = String(keyword || "").toLowerCase().split(/\s+/).filter(Boolean);
  return [...jobs]
    .sort((left, right) => {
      const leftMissingMetadata = workdayNeedsDetailMetadata(left) ? 1 : 0;
      const rightMissingMetadata = workdayNeedsDetailMetadata(right) ? 1 : 0;
      if (leftMissingMetadata !== rightMissingMetadata) {
        return rightMissingMetadata - leftMissingMetadata;
      }
      const leftKeywordMatch = workdayTitleMatchesKeyword(left, keywordTerms) ? 1 : 0;
      const rightKeywordMatch = workdayTitleMatchesKeyword(right, keywordTerms) ? 1 : 0;
      if (leftKeywordMatch !== rightKeywordMatch) {
        return rightKeywordMatch - leftKeywordMatch;
      }
      return String(left?.title || "").localeCompare(String(right?.title || ""));
    })
    .slice(0, limit);
}

function workdayTitleMatchesKeyword(job, keywordTerms) {
  if (!keywordTerms.length) {
    return false;
  }
  const title = String(job?.title || "").toLowerCase();
  return keywordTerms.every((term) => title.includes(term));
}

function workdayNeedsDetailMetadata(job) {
  if (!job) {
    return false;
  }
  return (
    !job.postedAt
    || !job.country
    || !job.city
    || String(job.locationLabel || "").trim().toLowerCase() === "unspecified"
    || /^\d+\s+locations?$/i.test(String(job.locationLabel || "").trim())
  );
}

function workdayNeedsDetailLocation(job) {
  if (!job) {
    return false;
  }

  return (
    !job.country
    || !job.city
    || isVagueWorkdayLocationLabel(job.locationLabel)
    || isVagueWorkdayLocationLabel(job.rawLocationText)
    || isVagueWorkdayLocationLabel(job.workdayOriginalLocationLabel)
  );
}

async function fetchWorkdayDetailLocationMetadata(applyUrl) {
  const detailUrl = buildWorkdayDetailApiUrl(applyUrl);
  if (!detailUrl) {
    return null;
  }

  try {
    const detail = await fetchJson(detailUrl, {
      headers: {
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(WORKDAY_DETAIL_LOCATION_TIMEOUT_MS),
    });
    return extractWorkdayLocationMetadata(detail?.jobPostingInfo || detail, applyUrl);
  } catch {
    // Detail pages are an enrichment path; preserve the list result if they fail.
    return null;
  }
}

function buildWorkdayDetailApiUrl(jobUrl) {
  try {
    const parsed = new URL(String(jobUrl || ""));
    const segments = parsed.pathname.split("/").filter(Boolean);
    const jobIndex = segments.findIndex((segment) => segment.toLowerCase() === "job");
    if (jobIndex <= 0 || jobIndex >= segments.length - 1) {
      return null;
    }

    const site = segments[jobIndex - 1];
    const tenant = parsed.hostname.split(".")[0];
    const detailSegments = segments.slice(jobIndex);
    return `${parsed.origin}/wday/cxs/${tenant}/${site}/${detailSegments.join("/")}`;
  } catch {
    return null;
  }
}

function applyWorkdayLocationMetadata(job, metadata) {
  if (!job || !metadata) {
    return;
  }

  if (metadata.locationLabel && (!job.locationLabel || isVagueWorkdayLocationLabel(job.locationLabel))) {
    job.locationLabel = metadata.locationLabel;
  }
  if (metadata.city && !job.city) {
    job.city = metadata.city;
  }
  if (metadata.region && !job.region) {
    job.region = metadata.region;
  }
  if (metadata.country && !job.country) {
    job.country = metadata.country;
  }
  if (metadata.rawLocationText && (!job.rawLocationText || isVagueWorkdayLocationLabel(job.rawLocationText))) {
    job.rawLocationText = metadata.rawLocationText;
  }
}

function extractWorkdayLocationMetadata(job = {}, applyUrl = null) {
  const listLocation = extractLocationFromWorkdayPayload(job);
  const urlLocation = extractUsLocationFromWorkdayUrl(applyUrl);
  const allLocations = [
    ...(listLocation.locations || []),
    ...(urlLocation ? [urlLocation] : []),
  ];
  const usLocation = allLocations.find((location) => location.country === "US");
  const primaryLocation = listLocation.primary || urlLocation || null;
  const primaryIsVague = isVagueWorkdayLocationLabel(job.locationsText || job.location);

  if (usLocation) {
    const label = primaryIsVague || allLocations.length > 1
      ? `Multiple locations, including ${usLocation.label}`
      : usLocation.label;
    return {
      locationLabel: label,
      city: usLocation.city,
      region: usLocation.region,
      country: "US",
      rawLocationText: buildRawWorkdayLocationText(allLocations, job.locationsText || job.location),
    };
  }

  if (primaryLocation) {
    return {
      locationLabel: primaryLocation.label,
      city: primaryLocation.city || null,
      region: primaryLocation.region || null,
      country: primaryLocation.country || null,
      rawLocationText: buildRawWorkdayLocationText(allLocations, job.locationsText || job.location),
    };
  }

  return {
    locationLabel: null,
    city: null,
    region: null,
    country: null,
    rawLocationText: null,
  };
}

function extractLocationFromWorkdayPayload(job = {}) {
  const rawLocations = [];
  addWorkdayLocationCandidate(rawLocations, job.location, job.country);
  addWorkdayLocationCandidate(rawLocations, job.locationsText, job.country);
  addWorkdayLocationCandidate(rawLocations, job.jobRequisitionLocation, job.country);
  addWorkdayLocationCandidate(rawLocations, job.primaryLocation, job.country);

  if (Array.isArray(job.additionalLocations)) {
    for (const location of job.additionalLocations) {
      addWorkdayLocationCandidate(rawLocations, location, job.country);
    }
  }
  if (Array.isArray(job.locations)) {
    for (const location of job.locations) {
      addWorkdayLocationCandidate(rawLocations, location, job.country);
    }
  }

  const locations = dedupeWorkdayLocations(rawLocations.filter(Boolean));
  return {
    primary: locations[0] || null,
    locations,
  };
}

function addWorkdayLocationCandidate(output, value, countryHint = null) {
  const parsedCountry = normalizeWorkdayCountry(countryHint);

  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addWorkdayLocationCandidate(output, item, countryHint);
    }
    return;
  }

  if (typeof value === "object") {
    const objectCountry = normalizeWorkdayCountry(value.country) || parsedCountry;
    addWorkdayLocationCandidate(output, value.descriptor || value.displayName || value.location || value.name, objectCountry);
    return;
  }

  const location = parseWorkdayLocationText(String(value), parsedCountry);
  if (location) {
    output.push(location);
  }
}

function parseWorkdayLocationText(value, countryHint = null) {
  const text = cleanText(value || "");
  if (!text || isVagueWorkdayLocationLabel(text)) {
    return null;
  }

  const explicitCountry = normalizeWorkdayCountry(countryHint);
  const textCountry = inferWorkdayCountryFromText(text);
  const country = textCountry || explicitCountry;
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  let city = null;
  let region = null;

  if (country === "US" && parts.length >= 2) {
    city = cleanWorkdayCity(parts[0]);
    region = normalizeUsState(parts[1]);
  } else if (country === "US") {
    const match = text.match(/\b([A-Za-z .'-]{2,80}),\s*([A-Z]{2})\b/);
    city = cleanWorkdayCity(match?.[1] || "");
    region = normalizeUsState(match?.[2] || "");
  } else if (parts.length >= 2 && /^[A-Z]{2,3}$/.test(parts.at(-1))) {
    city = cleanWorkdayCity(parts[0]);
    region = parts[1] || null;
  } else {
    city = cleanWorkdayCity(parts[0] || text);
  }

  if (country === "US" && (!city || (!region && !explicitCountry))) {
    return null;
  }

  const label = country === "US" && city && region ? `${city}, ${region}` : text;
  return {
    label,
    city: city || null,
    region: region || null,
    country,
  };
}

function extractUsLocationFromWorkdayUrl(applyUrl) {
  try {
    const parsed = new URL(String(applyUrl || ""));
    const segments = parsed.pathname.split("/").filter(Boolean);
    const jobIndex = segments.findIndex((segment) => segment.toLowerCase() === "job");
    if (jobIndex < 0 || jobIndex >= segments.length - 1) {
      return null;
    }

    const slug = decodeURIComponent(segments[jobIndex + 1] || "");
    const match = slug.match(/^(.+)-([A-Z]{2})$/);
    const region = normalizeUsState(match?.[2] || "");
    if (!match?.[1] || !region) {
      return null;
    }

    const city = titleCaseWorkdaySlug(match[1]);
    if (!city) {
      return null;
    }

    return {
      label: `${city}, ${region}`,
      city,
      region,
      country: "US",
    };
  } catch {
    return null;
  }
}

function buildRawWorkdayLocationText(locations, fallback) {
  const labels = dedupeWorkdayLocations(locations || []).map((location) => location.label).filter(Boolean);
  if (labels.length) {
    return labels.join("; ");
  }
  return cleanText(fallback || "") || null;
}

function dedupeWorkdayLocations(locations) {
  const seen = new Set();
  const output = [];
  for (const location of locations) {
    const key = `${location.label || ""}|${location.country || ""}`.toLowerCase();
    if (!location.label || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(location);
  }
  return output;
}

function normalizeWorkdayCountry(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return normalizeWorkdayCountry(value.alpha2Code || value.descriptor || value.name || value.displayName);
  }

  const text = cleanText(String(value));
  if (/^(?:us|usa|united states|united states of america)$/i.test(text)) {
    return "US";
  }
  if (/^(?:ca|can|canada)$/i.test(text)) {
    return "CA";
  }
  if (/^(?:gb|uk|united kingdom|england|scotland|wales)$/i.test(text)) {
    return "GB";
  }
  if (/^(?:ie|irl|ireland)$/i.test(text)) {
    return "IE";
  }
  return /^[A-Z]{2}$/.test(text) ? text.toUpperCase() : null;
}

function inferWorkdayCountryFromText(value) {
  const text = cleanText(value || "");
  if (/\b(?:USA|United States|United States of America)\b/i.test(text)) {
    return "US";
  }
  if (/\b[A-Za-z .'-]+,\s*[A-Z]{2}\b/.test(text)) {
    const state = text.match(/\b[A-Za-z .'-]+,\s*([A-Z]{2})\b/)?.[1];
    if (normalizeUsState(state)) {
      return "US";
    }
  }
  if (/\b(?:CAN|Canada)\b/i.test(text)) {
    return "CA";
  }
  if (/\b(?:IRL|Ireland)\b/i.test(text)) {
    return "IE";
  }
  return null;
}

function normalizeUsState(value) {
  const state = String(value || "").trim().toUpperCase();
  return US_STATE_CODES.has(state) ? state : null;
}

function cleanWorkdayCity(value) {
  const text = cleanText(String(value || "").replace(/\s+/g, " "));
  return text ? normalizeWorkdayCityCase(text.replace(/\s+-\s+.*$/, "")) : null;
}

function titleCaseWorkdaySlug(value) {
  const normalized = String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.length <= 2 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ")
    .trim();
  return normalizeWorkdayCityCase(normalized);
}

function normalizeWorkdayCityCase(value) {
  const aliases = new Map([
    ["Mclean", "McLean"],
  ]);
  return aliases.get(value) || value;
}

function isVagueWorkdayLocationLabel(value) {
  const text = cleanText(value || "");
  return !text || /^(?:unspecified|unknown|n\/a)$/i.test(text) || WORKDAY_VAGUE_LOCATION_PATTERN.test(text);
}

function absoluteWorkdayJobUrl(source, externalPath) {
  if (!externalPath) {
    return source.careersUrl || null;
  }

  const rawPath = String(externalPath || "").trim();
  if (!rawPath) {
    return source.careersUrl || null;
  }

  if (/invalid-url/i.test(rawPath)) {
    return source.careersUrl || null;
  }

  if (/^https?:\/\//i.test(rawPath)) {
    return rawPath;
  }

  if (source.careersUrl) {
    const baseUrl = String(source.careersUrl).replace(/\/+$/, "");
    const joinedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    return `${baseUrl}${joinedPath}`;
  }

  const host = source.host || "wd5.myworkdaysite.com";
  const siteBase = host.includes("myworkdayjobs.com")
    ? `https://${host}/${source.site}`
    : `https://${host}/recruiting/${source.tenant}/${source.site}`;
  const joinedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return `${siteBase}${joinedPath}`;
}

function extractPostingDate(job) {
  const bulletFields = Array.isArray(job.bulletFields) ? job.bulletFields : [];
  const explicitField = bulletFields.find((field) => /posting date:/i.test(field));
  if (explicitField) {
    const match = explicitField.match(/posting date:\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i);
    if (match?.[1]) {
      const [month, day, year] = match[1].split("/");
      return `${year}-${month}-${day}`;
    }
  }

  if (typeof job.postedOn === "string") {
    const postedOnText = job.postedOn.trim();
    if (/posted today/i.test(postedOnText)) {
      return new Date().toISOString().slice(0, 10);
    }

    if (/posted yesterday/i.test(postedOnText)) {
      const date = new Date();
      date.setDate(date.getDate() - 1);
      return date.toISOString().slice(0, 10);
    }

    const daysMatch = postedOnText.match(/posted\s+(\d+)(?:\+)?\s+days?\s+ago/i);
    if (daysMatch?.[1]) {
      const date = new Date();
      date.setDate(date.getDate() - Number(daysMatch[1]));
      return date.toISOString().slice(0, 10);
    }
  }

  return null;
}
