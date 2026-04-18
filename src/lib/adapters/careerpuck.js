import { buildNormalizedJob, fetchJson } from "./shared.js";

export async function fetchCareerPuckJobs(source) {
  const boardSlug = String(source.boardSlug || source.slug || "").trim();
  const apiUrl = source.apiUrl || (boardSlug ? `https://api.careerpuck.com/v1/public/job-boards/${encodeURIComponent(boardSlug)}` : "");
  if (!apiUrl) {
    throw new Error("CareerPuck source requires apiUrl or boardSlug");
  }

  const payload = await fetchJson(apiUrl);
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];

  return jobs
    .filter((job) => {
      const status = String(job?.status || "").trim().toLowerCase();
      return !status || status === "public";
    })
    .map((job) =>
      buildNormalizedJob(source, {
        id: job.publicUrl || job.applyUrl || job.id,
        company: source.company,
        title: String(job?.title || "").trim() || "Untitled Position",
        team: Array.isArray(job?.departments) ? job.departments.map((item) => item?.name).filter(Boolean).join(" / ") || null : null,
        department: Array.isArray(job?.departments) ? job.departments.map((item) => item?.name).filter(Boolean).join(" / ") || null : null,
        locationLabel: String(job?.location || "").trim() || "Unspecified",
        postedAt: String(job?.postedAt || "").trim() || null,
        applyUrl: String(job?.publicUrl || job?.applyUrl || "").trim(),
        rawLocationText: String(job?.location || "").trim() || null,
      })
    )
    .filter((job) => job.applyUrl);
}
