import { buildNormalizedJob, fetchJson, safeText } from "./shared.js";

export async function fetchWorkableJobs(source) {
  const subdomain = source.subdomain || source.slug;
  const url = new URL(`https://${subdomain}.workable.com/spi/v3/jobs`);

  const payload = await fetchJson(url);
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];

  return jobs.map((job) =>
    buildNormalizedJob(source, {
      id: job.shortcode || job.id,
      company: source.company,
      title: job.title,
      team: job.department || null,
      department: job.department || null,
      locationLabel: job.location?.location_str || job.location?.city || "Unspecified",
      city: job.location?.city || null,
      region: job.location?.region || null,
      country: job.location?.country || null,
      postedAt: job.published || job.created_at,
      applyUrl: job.url,
      descriptionSnippet: safeText(job.description),
      employmentType: job.employment_type || null,
      rawLocationText: job.location?.location_str || null,
      workArrangement: job.remote ? "remote" : null,
    })
  );
}