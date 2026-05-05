import {
  absoluteUrl,
  buildNormalizedJob,
  fetchDescriptionFallback,
  fetchText,
  mapWithConcurrency,
  safeText,
} from "./shared.js";
import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchApplyToJobJobs(source, filters = {}) {
  const requestUrl = String(source?.careersUrl || "").trim();

  if (!requestUrl) {
    return fetchHostedBoardJobs(source, filters);
  }

  const html = await fetchText(requestUrl);
  const listCardJobs = extractApplyToJobListCardJobs(source, html, requestUrl);
  if (listCardJobs.length > 0) {
    return await enrichApplyToJobListCardJobs(listCardJobs);
  }

  return fetchHostedBoardJobs(source, filters);
}

function extractApplyToJobListCardJobs(source, html, requestUrl) {
  const deduped = new Map();

  const cardMatches = html.matchAll(
    /<li class=["']list-group-item["'][^>]*>\s*<h3[^>]*class=["'][^"']*list-group-item-heading[^"']*["'][^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h3>\s*(?:<ul[^>]*class=["'][^"']*list-group-item-text[^"']*["'][^>]*>([\s\S]*?)<\/ul>)?[\s\S]*?<\/li>/gi
  );

  for (const match of cardMatches) {
    const href = absoluteUrl(match[1], requestUrl);
    const title = safeText(match[2], 220);
    if (!href || !title) {
      continue;
    }

    const metadataHtml = match[3] || "";
    const locationMatch = metadataHtml.match(/<li[^>]*>\s*(?:<i[^>]*class=["'][^"']*fa-map-marker[^"']*["'][^>]*><\/i>)?\s*([\s\S]*?)<\/li>/i);
    const locationLabel = safeText(locationMatch?.[1], 160) || "Unspecified";
    const departmentMatch = metadataHtml.match(/<li[^>]*>\s*(?:<i[^>]*class=["'][^"']*fa-sitemap[^"']*["'][^>]*><\/i>)?\s*([\s\S]*?)<\/li>/i);
    const department = safeText(departmentMatch?.[1], 120);

    const job = buildNormalizedJob(source, {
      id: href,
      company: source.company,
      title,
      department,
      locationLabel,
      rawLocationText: locationLabel,
      applyUrl: href,
    });

    if (!deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  if (deduped.size === 0) {
    for (const match of html.matchAll(/<a[^>]+href=["']([^"']*\/apply\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = absoluteUrl(match[1], requestUrl);
      const title = safeText(match[2], 220);
      if (!href || !title) {
        continue;
      }

      const job = buildNormalizedJob(source, {
        id: href,
        company: source.company,
        title,
        locationLabel: "Unspecified",
        rawLocationText: "Unspecified",
        applyUrl: href,
      });

      if (!deduped.has(job.applyUrl)) {
        deduped.set(job.applyUrl, job);
      }
    }
  }

  return [...deduped.values()];
}

async function enrichApplyToJobListCardJobs(jobs) {
  const jobsNeedingDetails = jobs.filter((job) => (
    job?.applyUrl
    && (
      !job.postedAt
      || !job.descriptionSnippet
      || !job.searchText
      || !job.compensation
      || !job.applicationDeadlineAt
    )
  ));

  if (jobsNeedingDetails.length === 0) {
    return jobs;
  }

  await mapWithConcurrency(jobsNeedingDetails.slice(0, 30), 4, async (job) => {
    try {
      const fallback = await fetchDescriptionFallback(job.applyUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (fallback.postedAt && !job.postedAt) {
        job.postedAt = fallback.postedAt;
      }
      if (fallback.descriptionSnippet && !job.descriptionSnippet) {
        job.descriptionSnippet = fallback.descriptionSnippet;
      }
      if (fallback.searchText && !job.searchText) {
        job.searchText = fallback.searchText;
      }
      if (fallback.compensation && !job.compensation) {
        job.compensation = fallback.compensation;
      }
      if (fallback.applicationDeadlineAt && !job.applicationDeadlineAt) {
        job.applicationDeadlineAt = fallback.applicationDeadlineAt;
      }
      if (fallback.workArrangement && (!job.workArrangement || job.workArrangement === "unknown")) {
        job.workArrangement = fallback.workArrangement;
      }
      if (fallback.invalidApplyPage) {
        job.invalidApplyPage = true;
      }
    } catch {
      // Preserve the parsed listing data even when detail enrichment fails.
    }

    return job;
  });

  return jobs;
}
