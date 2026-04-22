import { buildNormalizedJob, fetchJson, safeText } from "./shared.js";

export async function fetchRecruiteeJobs(source) {
  const subdomain = resolveRecruiteeSubdomain(source);
  if (!subdomain) {
    throw new Error("Recruitee source requires subdomain");
  }

  const url = new URL(`https://${subdomain}.recruitee.com/api/offers/`);
  const payload = await fetchJson(url);
  const jobs = Array.isArray(payload.offers) ? payload.offers : Array.isArray(payload) ? payload : [];

  return jobs
    .filter((job) => job.careers_url || job.careers_apply_url)
    .map((job) =>
      buildNormalizedJob(source, {
        id: job.id,
        company: job.company_name || source.company,
        title: job.title,
        team: job.department?.name || null,
        department: job.department?.name || null,
        locationLabel: job.location || job.locations?.map((item) => item.name).join(", ") || "Unspecified",
        postedAt: job.published_at || job.created_at,
        applyUrl: job.careers_apply_url || job.careers_url,
        descriptionSnippet: safeText(job.description),
        employmentType: job.employment_type || null,
        rawLocationText: job.location || null,
        workArrangement: job.remote ? "remote" : null,
      })
    );
}

function resolveRecruiteeSubdomain(source) {
  const explicit = String(source?.subdomain || source?.slug || "").trim().toLowerCase();
  if (explicit) {
    return explicit;
  }

  const careersUrl = String(source?.careersUrl || "").trim();
  if (!careersUrl) {
    return "";
  }

  try {
    const hostname = new URL(careersUrl).hostname.toLowerCase();
    if (hostname.endsWith(".recruitee.com")) {
      return String(hostname.split(".")[0] || "").trim().toLowerCase();
    }
  } catch {
    return "";
  }

  return "";
}
