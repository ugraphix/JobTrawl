import {
  absoluteUrl,
  buildNormalizedJob,
  cleanText,
  fetchJson,
  fetchText,
  mapWithConcurrency,
  safeText,
} from "./shared.js";
import { fetchHostedBoardJobs } from "./hosted-board.js";

const BAMBOOHR_DETAIL_CONCURRENCY = 3;

export async function fetchBambooHrJobs(source, filters = {}) {
  const careersUrl = String(source.careersUrl || source.jobsUrl || "").trim();
  if (!careersUrl) {
    throw new Error("BambooHR source requires careersUrl");
  }

  const html = await fetchText(careersUrl);
  const indexUrls = extractQueryIndexUrls(html, careersUrl);
  const jobs = [];
  const seenUrls = new Set();

  for (const indexUrl of indexUrls) {
    try {
      const payload = await fetchJson(indexUrl);
      for (const entry of extractJobEntries(payload)) {
        const applyUrl = absoluteUrl(entry.url || entry.href || entry.link, careersUrl);
        const title = cleanText(entry.title || entry.name || entry.jobTitle || entry.label);
        if (!applyUrl || !title || seenUrls.has(applyUrl)) {
          continue;
        }

        const locationLabel = cleanText(
          entry.location
          || entry.locationName
          || entry.city
          || [entry.city, entry.region, entry.country].filter(Boolean).join(", ")
        ) || "Unspecified";

        jobs.push(buildNormalizedJob(source, {
          id: entry.id || applyUrl,
          company: source.company,
          title,
          team: cleanText(entry.department || entry.team || entry.category) || null,
          department: cleanText(entry.department || entry.team || entry.category) || null,
          locationLabel,
          city: cleanText(entry.city) || null,
          region: cleanText(entry.region || entry.state) || null,
          country: cleanText(entry.country) || null,
          postedAt: entry.postedAt || entry.datePosted || entry.publishDate || entry.updatedAt || null,
          applyUrl,
          descriptionSnippet: safeText(entry.description || entry.summary),
          searchText: cleanText(entry.description || entry.summary || title),
          employmentType: cleanText(entry.employmentType || entry.type) || null,
          rawLocationText: locationLabel,
        }));
        seenUrls.add(applyUrl);
      }
    } catch {
      continue;
    }
  }

  if (jobs.length > 0) {
    return jobs;
  }

  const listJobs = await fetchBambooHrListJobs(source, careersUrl);
  if (listJobs.length > 0) {
    return listJobs;
  }

  return fetchHostedBoardJobs(source, filters);
}

async function fetchBambooHrListJobs(source, careersUrl) {
  const listUrl = buildBambooHrListUrl(careersUrl);
  if (!listUrl) {
    return [];
  }

  let payload;
  try {
    payload = await fetchJson(listUrl);
  } catch {
    return [];
  }

  const entries = Array.isArray(payload?.result)
    ? payload.result
    : Array.isArray(payload?.jobs)
      ? payload.jobs
      : [];
  if (entries.length === 0) {
    return [];
  }

  const jobs = await mapWithConcurrency(entries, BAMBOOHR_DETAIL_CONCURRENCY, async (entry) => {
    const detail = await fetchBambooHrDetail(entry, careersUrl);
    return buildBambooHrJob(source, careersUrl, entry, detail);
  });

  const deduped = new Map();
  for (const job of jobs.filter(Boolean)) {
    if (!deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }
  return [...deduped.values()];
}

function buildBambooHrListUrl(careersUrl) {
  try {
    return new URL("list", ensureTrailingSlash(careersUrl)).toString();
  } catch {
    return "";
  }
}

async function fetchBambooHrDetail(entry, careersUrl) {
  const id = cleanText(entry?.id || entry?.jobOpeningId || entry?.jobId);
  if (!id) {
    return null;
  }

  try {
    const detailUrl = new URL(`${encodeURIComponent(id)}/detail`, ensureTrailingSlash(careersUrl)).toString();
    const payload = await fetchJson(detailUrl);
    return payload?.result?.jobOpening || payload?.result || null;
  } catch {
    return null;
  }
}

function buildBambooHrJob(source, careersUrl, entry, detail) {
  const merged = {
    ...(entry && typeof entry === "object" ? entry : {}),
    ...(detail && typeof detail === "object" ? detail : {}),
  };
  const id = cleanText(merged.id || merged.jobOpeningId || merged.jobId);
  const title = cleanText(merged.jobOpeningName || merged.title || merged.name || merged.jobTitle);
  if (!id || !title) {
    return null;
  }

  const applyUrl = absoluteUrl(merged.jobOpeningShareUrl || `./${encodeURIComponent(id)}`, careersUrl);
  if (!applyUrl) {
    return null;
  }

  const location = buildBambooHrLocation(merged);
  const description = merged.description || merged.jobDescription || merged.summary || null;
  const descriptionSnippet = safeText(description, 1400);
  const searchText = cleanText(description || [
    title,
    merged.departmentLabel,
    merged.employmentStatusLabel,
    location.rawLocationText,
  ].filter(Boolean).join(" \n "));

  return buildNormalizedJob(source, {
    id,
    company: source.company,
    title,
    team: cleanText(merged.departmentLabel || merged.department || merged.departmentName) || null,
    department: cleanText(merged.departmentLabel || merged.department || merged.departmentName) || null,
    locationLabel: location.locationLabel,
    city: location.city,
    region: location.region,
    country: location.country,
    postedAt: merged.datePosted || merged.postedAt || merged.createdAt || merged.updatedAt || null,
    applyUrl,
    descriptionSnippet,
    searchText,
    employmentType: cleanText(merged.employmentStatusLabel || merged.employmentType || merged.type) || null,
    rawLocationText: location.rawLocationText,
    workArrangement: merged.isRemote === true ? "remote" : null,
  });
}

function buildBambooHrLocation(value) {
  const atsLocation = value?.atsLocation || {};
  const plainLocation = value?.location || {};
  const city = cleanText(atsLocation.city || plainLocation.city || value?.city) || null;
  const region = cleanText(
    atsLocation.state
    || atsLocation.province
    || plainLocation.state
    || plainLocation.province
    || value?.state
    || value?.region
  ) || null;
  const country = cleanText(
    atsLocation.addressCountry
    || atsLocation.country
    || plainLocation.addressCountry
    || plainLocation.country
    || value?.country
  ) || null;
  const locationLabel = cleanText(
    value?.locationLabel
    || value?.locationName
    || [city, region, country].filter(Boolean).join(", ")
  ) || "Unspecified";

  return {
    city,
    region,
    country,
    locationLabel,
    rawLocationText: locationLabel,
  };
}

function ensureTrailingSlash(value) {
  const raw = String(value || "").trim();
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function extractQueryIndexUrls(html, baseUrl) {
  const urls = new Set();
  const patterns = [
    /["']([^"'<>]*query-index\.json[^"'<>]*)["']/gi,
    /\bindexPath\b[^"'<>]*["']([^"'<>]*query-index\.json[^"'<>]*)["']/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(String(html || ""));
    while (match) {
      const value = absoluteUrl(match[1], baseUrl);
      if (value) {
        urls.add(value);
      }
      match = pattern.exec(String(html || ""));
    }
  }

  return [...urls];
}

function extractJobEntries(node) {
  const found = [];
  walk(node, found);
  return found;
}

function walk(node, found) {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    if (
      node.length > 0
      && node.every((item) => item && typeof item === "object")
      && node.some((item) => hasJobLikeFields(item))
    ) {
      found.push(...node);
      return;
    }

    for (const item of node) {
      walk(item, found);
    }
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  for (const value of Object.values(node)) {
    walk(value, found);
  }
}

function hasJobLikeFields(value) {
  return Boolean(
    cleanText(value?.title || value?.name || value?.jobTitle || value?.label)
    && cleanText(value?.url || value?.href || value?.link)
  );
}
