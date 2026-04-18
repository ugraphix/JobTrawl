import { absoluteUrl, buildNormalizedJob, cleanText, fetchJson, safeText } from "./shared.js";
import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchJobApsJobs(source, filters = {}) {
  const apiUrl = String(source.apiUrl || "").trim();
  if (apiUrl) {
    const payload = await fetchJson(apiUrl);
    const jobs = extractJobs(payload);
    if (jobs.length > 0) {
      return jobs
        .map((job, index) => normalizeJobApsJob(source, job, index, source.careersUrl || apiUrl))
        .filter(Boolean);
    }
  }

  return fetchHostedBoardJobs(source, filters);
}

function extractJobs(payload) {
  const candidates = [
    payload?.jobs,
    payload?.JobPostings,
    payload?.jobPostings,
    payload?.results,
    payload?.data,
    payload?.Items,
    payload?.items,
  ];

  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function normalizeJobApsJob(source, job, index, baseUrl) {
  const applyUrl = absoluteUrl(
    job?.url
      || job?.applyUrl
      || job?.jobUrl
      || job?.detailUrl
      || job?.postingUrl,
    baseUrl
  );
  const title = cleanText(job?.title || job?.jobTitle || job?.name || job?.job_name);

  if (!applyUrl || !title) {
    return null;
  }

  const locationLabel = cleanText(
    job?.location
    || job?.locationLabel
    || [job?.city, job?.state, job?.country].filter(Boolean).join(", ")
  ) || "Unspecified";

  return buildNormalizedJob(source, {
    id: job?.id || job?.jobId || applyUrl || `${source.key}-${index}`,
    company: source.company,
    title,
    team: cleanText(job?.department || job?.category) || null,
    department: cleanText(job?.department || job?.category) || null,
    locationLabel,
    city: cleanText(job?.city) || null,
    region: cleanText(job?.state || job?.region) || null,
    country: cleanText(job?.country) || null,
    postedAt: job?.postedAt || job?.postingDate || job?.datePosted || job?.publishDate || null,
    applyUrl,
    descriptionSnippet: safeText(job?.description || job?.summary),
    searchText: cleanText(job?.description || job?.summary || title),
    employmentType: cleanText(job?.employmentType || job?.type) || null,
    rawLocationText: locationLabel,
  });
}
