import { absoluteUrl, buildNormalizedJob, fetchJson } from "./shared.js";

export async function fetchTalexioJobs(source) {
  const apiUrl = source.apiUrl || resolveApiUrl(source.careersUrl || source.jobsUrl || "");
  const jobsUrl = source.jobsUrl || resolveJobsUrl(source.careersUrl || "");
  if (!apiUrl) {
    throw new Error("Talexio source requires apiUrl or careersUrl");
  }

  const postings = [];
  const seenUrls = new Set();

  for (let page = 1; page <= 25; page += 1) {
    const url = `${apiUrl}?${new URLSearchParams({
      search: "",
      sortBy: "relevance",
      page: String(page),
      limit: "10",
    }).toString()}`;
    const payload = await fetchJson(url);
    const vacancies = Array.isArray(payload?.vacancies) ? payload.vacancies : [];
    if (vacancies.length === 0) {
      break;
    }

    for (const vacancy of vacancies) {
      const vacancyId = String(vacancy?.id || "").trim();
      const rawUrl = String(vacancy?.url || vacancy?.jobUrl || vacancy?.vacancyUrl || vacancy?.applyUrl || "").trim();
      const applyUrl = rawUrl
        ? absoluteUrl(rawUrl, jobsUrl || apiUrl)
        : vacancyId
          ? `${jobsUrl}?vacancyId=${encodeURIComponent(vacancyId)}`
          : "";
      if (!applyUrl || seenUrls.has(applyUrl)) {
        continue;
      }

      const locationLabel = [String(vacancy?.workLocation || "").trim(), String(vacancy?.country || "").trim()].filter(Boolean).join(", ") || "Unspecified";
      postings.push(buildNormalizedJob(source, {
        id: vacancyId || applyUrl,
        company: source.company,
        title: String(vacancy?.title || "").trim() || "Untitled Position",
        team: String(vacancy?.department || "").trim() || null,
        department: String(vacancy?.department || "").trim() || null,
        locationLabel,
        postedAt: String(vacancy?.publishDate || "").trim() || null,
        applyUrl,
        employmentType: String(vacancy?.jobType || "").trim() || null,
        rawLocationText: locationLabel,
      }));
      seenUrls.add(applyUrl);
    }

    if (vacancies.length < 10) {
      break;
    }
  }

  return postings;
}

function resolveJobsUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const url = new URL(raw);
  return `${url.origin}/jobs/`;
}

function resolveApiUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const url = new URL(raw);
  return `${url.origin}/api/jobs`;
}
