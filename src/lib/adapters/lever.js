import { buildNormalizedJob, cleanText, fetchJson, safeText } from "./shared.js";

export async function fetchLeverJobs(source) {
  const site = source.site || source.slug;
  const url = new URL(`https://api.lever.co/v0/postings/${site}`);
  url.searchParams.set("mode", "json");

  const jobs = await fetchJson(url);

  return jobs.map((job) =>
    buildNormalizedJob(source, {
      id: job.id,
      company: source.company,
      title: job.text,
      team: job.categories?.team || null,
      department: job.categories?.department || null,
      locationLabel: job.categories?.location || job.categories?.allLocations || "Unspecified",
      postedAt: job.createdAt ? new Date(job.createdAt) : null,
      applyUrl: job.hostedUrl || job.applyUrl,
      descriptionSnippet: safeText(job.descriptionPlain || job.description),
      searchText: cleanText(job.descriptionPlain || job.description),
      employmentType: job.categories?.commitment || null,
      rawLocationText: job.categories?.location || null,
      workArrangement: job.categories?.workplaceType?.toLowerCase() || null,
    })
  );
}
