import { buildNormalizedJob, cleanText, fetchJson, safeText } from "./shared.js";

export async function fetchGreenhouseJobs(source) {
  const boardToken = source.boardToken || source.slug;
  const url = new URL(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs`);
  url.searchParams.set("content", "true");

  const payload = await fetchJson(url);
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];

  return jobs.map((job) =>
    buildNormalizedJob(source, {
      id: job.id,
      company: source.company,
      title: job.title,
      team: job.departments?.map((item) => item.name).join(", ") || null,
      department: job.offices?.map((item) => item.name).join(", ") || null,
      locationLabel: job.location?.name || "Unspecified",
      postedAt: job.first_published || job.created_at || null,
      updatedAt: job.updated_at || null,
      dateStatus: (job.first_published || job.created_at) ? "posted" : job.updated_at ? "updated" : "unknown",
      applyUrl: job.absolute_url,
      descriptionSnippet: safeText(job.content),
      searchText: cleanText(job.content),
      rawLocationText: job.location?.name || null,
    })
  );
}
