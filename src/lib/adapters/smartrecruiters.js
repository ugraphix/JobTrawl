import { buildNormalizedJob, fetchJson, safeText } from "./shared.js";

export async function fetchSmartRecruitersJobs(source) {
  const companyIdentifier = source.companyIdentifier || source.slug;
  const url = new URL(`https://api.smartrecruiters.com/v1/companies/${companyIdentifier}/postings`);
  url.searchParams.set("limit", source.limit || "100");
  url.searchParams.set("offset", "0");

  const payload = await fetchJson(url);
  const jobs = Array.isArray(payload.content) ? payload.content : [];

  return jobs.map((job) =>
    buildNormalizedJob(source, {
      id: job.id,
      company: job.company?.name || source.company,
      title: job.name,
      team: job.department?.label || null,
      department: job.department?.label || null,
      locationLabel: [job.location?.city, job.location?.region, job.location?.country]
        .filter(Boolean)
        .join(", ") || "Unspecified",
      city: job.location?.city || null,
      region: job.location?.region || null,
      country: job.location?.country || null,
      postedAt: job.releasedDate,
      applyUrl: job.ref,
      descriptionSnippet: safeText(job.name),
      employmentType: job.typeOfEmployment?.label || null,
      rawLocationText: [job.location?.city, job.location?.region, job.location?.country].filter(Boolean).join(", "),
    })
  );
}