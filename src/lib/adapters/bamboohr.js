import {
  absoluteUrl,
  buildNormalizedJob,
  cleanText,
  fetchJson,
  fetchText,
  safeText,
} from "./shared.js";
import { fetchHostedBoardJobs } from "./hosted-board.js";

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

  return fetchHostedBoardJobs(source, filters);
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
