import { buildNormalizedJob, fetchJson } from "./shared.js";

export async function fetchCareerPuckJobs(source) {
  const boardSlug = resolveCareerPuckBoardSlug(source);
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

function resolveCareerPuckBoardSlug(source) {
  const explicit = String(source?.boardSlug || source?.slug || "").trim();
  if (explicit) {
    return explicit;
  }

  const careersUrl = String(source?.careersUrl || "").trim();
  if (!careersUrl) {
    return "";
  }

  try {
    const parsed = new URL(careersUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const boardIndex = parts.findIndex((part) => String(part).toLowerCase() === "job-board");
    if (boardIndex >= 0 && parts[boardIndex + 1]) {
      return String(parts[boardIndex + 1]).trim();
    }
  } catch {
    return "";
  }

  return "";
}
