import { buildNormalizedJob, cleanText, fetchJson, safeText } from "./shared.js";

export async function fetchAshbyJobs(source) {
  const organization = source.organization || source.slug;
  const url = new URL(`https://api.ashbyhq.com/posting-api/job-board/${organization}`);
  url.searchParams.set("includeCompensation", "true");

  const payload = await fetchJson(url);
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];

  return jobs.map((job) =>
    buildNormalizedJob(source, {
      id: job.id,
      company: source.company,
      title: job.title,
      team: job.team || null,
      department: job.department || null,
      locationLabel: job.location || "Unspecified",
      city: job.secondaryLocations?.[0]?.address?.addressLocality || null,
      region: job.secondaryLocations?.[0]?.address?.addressRegion || null,
      country: job.secondaryLocations?.[0]?.address?.addressCountry || null,
      postedAt: job.publishedAt || job.updatedAt,
      applyUrl: job.jobUrl,
      descriptionSnippet: safeText(job.descriptionPlain || job.descriptionHtml),
      searchText: cleanText(job.descriptionPlain || job.descriptionHtml),
      employmentType: job.employmentType || null,
      compensation: job.compensation?.summary || null,
      rawLocationText: job.location || null,
      workArrangement: job.isRemote ? "remote" : job.locationType?.toLowerCase() || null,
    })
  );
}
