import { normalizeWorkArrangement } from "../filters.js";
import {
  absoluteUrl,
  buildNormalizedJob,
  cleanText,
  fetchJson,
  mapWithConcurrency,
  safeText,
} from "./shared.js";

const DEFAULT_BASE_URL = "https://apply.careers.microsoft.com";
const DEFAULT_DOMAIN = "microsoft.com";
const DEFAULT_PAGE_SIZE = 10;

export async function fetchPcsxJobs(source, filters = {}) {
  const config = getPcsxConfig(source, filters);
  config.sessionHeaders = await fetchPcsxSessionHeaders(config);
  const searchResult = await fetchAllPcsxPositions(config);
  const positions = Array.isArray(searchResult.positions) ? searchResult.positions : [];

  if (positions.length === 0) {
    return [];
  }

  const detailMap = config.fetchDetails
    ? await fetchPcsxDetailsMap(config, positions)
    : new Map();

  return positions.map((position, index) => {
    const detail = detailMap.get(String(position.id)) || position;
    return buildNormalizedPcsxJob(source, config, detail, index);
  });
}

function getPcsxConfig(source, filters) {
  const baseUrl = String(source.baseUrl || source.careersUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiBaseUrl = source.apiBaseUrl || baseUrl;
  const domain = source.pcsxDomain || source.domain || DEFAULT_DOMAIN;
  const query = String(filters.keyword || "").trim();

  return {
    baseUrl,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    domain,
    query,
    fetchDetails: Boolean(source.fetchPcsxDetails),
    pageSize: Number(source.pcsxPageSize) || DEFAULT_PAGE_SIZE,
    detailConcurrency: Number(source.pcsxDetailConcurrency) || 4,
  };
}

async function fetchAllPcsxPositions(config) {
  const positions = [];
  let start = 0;
  let totalCount = Infinity;
  let pageSize = config.pageSize;

  while (start < totalCount) {
    const page = await fetchPcsxSearchPage(config, start);
    const pagePositions = Array.isArray(page?.positions) ? page.positions : [];
    const count = Number(page?.count);

    if (Number.isFinite(count)) {
      totalCount = count;
    }

    if (pagePositions.length === 0) {
      break;
    }

    positions.push(...pagePositions);
    pageSize = pagePositions.length || pageSize;
    start += pageSize;

    if (positions.length >= totalCount) {
      break;
    }
  }

  return {
    count: Number.isFinite(totalCount) ? totalCount : positions.length,
    positions,
  };
}

async function fetchPcsxSearchPage(config, start) {
  const url = new URL(`${config.apiBaseUrl}/api/pcsx/search`);
  url.searchParams.set("domain", config.domain);
  url.searchParams.set("query", config.query);
  url.searchParams.set("location", "");
  url.searchParams.set("start", String(start));

  const payload = await fetchJson(url.toString(), {
    headers: buildPcsxHeaders(config.baseUrl, config.sessionHeaders),
  });

  return payload?.data || {};
}

async function fetchPcsxDetailsMap(config, positions) {
  const details = await mapWithConcurrency(positions, config.detailConcurrency, async (position) => {
    try {
      const detail = await fetchPcsxPositionDetails(config, position.id);
      return [String(position.id), detail];
    } catch {
      return [String(position.id), position];
    }
  });

  return new Map(details);
}

async function fetchPcsxPositionDetails(config, positionId) {
  const url = new URL(`${config.apiBaseUrl}/api/pcsx/position_details`);
  url.searchParams.set("position_id", String(positionId));
  url.searchParams.set("domain", config.domain);
  url.searchParams.set("hl", "en");

  const payload = await fetchJson(url.toString(), {
    headers: buildPcsxHeaders(config.baseUrl, config.sessionHeaders),
  });

  return payload?.data || null;
}

function buildPcsxHeaders(baseUrl, sessionHeaders = {}) {
  return {
    Accept: "application/json, text/plain, */*",
    Referer: `${baseUrl}/careers`,
    "X-Requested-With": "XMLHttpRequest",
    ...sessionHeaders,
  };
}

async function fetchPcsxSessionHeaders(config) {
  const response = await fetch(config.baseUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(45000),
  });

  if (!response.ok) {
    const error = new Error(`Request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const html = await response.text();
  const csrfToken = html.match(/name="_csrf" content="([^"]+)"/)?.[1] || "";
  const cookieValues = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [];
  const cookieHeader = cookieValues
    .map((value) => String(value || "").split(";")[0])
    .filter(Boolean)
    .join("; ");

  return {
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
  };
}

function buildNormalizedPcsxJob(source, config, job, index) {
  const locations = Array.isArray(job?.standardizedLocations) && job.standardizedLocations.length > 0
    ? job.standardizedLocations
    : Array.isArray(job?.locations) && job.locations.length > 0
      ? job.locations
      : [];
  const primaryLocation = locations[0] || job?.location || "Unspecified";
  const description = job?.jobDescription || null;
  const applyPath = job?.publicUrl || job?.positionUrl || null;

  return buildNormalizedJob(source, {
    id: job?.id || job?.atsJobId || job?.displayJobId || `${source.key}-${index}`,
    company: source.company,
    title: job?.name || "Untitled role",
    team: job?.efcustomTextTaDisciplineName || null,
    department: job?.department || null,
    locationLabel: primaryLocation,
    country: extractCountryFromLocations(locations),
    postedAt: normalizePcsxTimestamp(job?.postedTs),
    updatedAt: normalizePcsxTimestamp(job?.creationTs),
    applyUrl: absoluteUrl(applyPath, config.baseUrl),
    descriptionSnippet: safeText(description),
    searchText: cleanText(description),
    employmentType: job?.efcustomTextEmploymentType || null,
    workArrangement: normalizeWorkArrangement(job?.workLocationOption || job?.efcustomTextWorkSite),
    rawLocationText: locations.join(" | ") || primaryLocation,
  });
}

function normalizePcsxTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric > 1e12 ? numeric : numeric * 1000;
}

function extractCountryFromLocations(locations) {
  const primary = String(locations?.[0] || "");
  if (!primary) {
    return null;
  }

  const parts = primary.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  const countryLike = parts.at(-1);
  if (/^[A-Z]{2}$/.test(countryLike)) {
    return null;
  }

  return countryLike;
}
