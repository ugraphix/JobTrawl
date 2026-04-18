import { buildNormalizedJob, fetchJson } from "./shared.js";

export async function fetchFountainJobs(source) {
  const apiUrl = source.apiUrl || resolveFountainApiUrl(source.careersUrl || source.boardUrl || "");
  if (!apiUrl) {
    throw new Error("Fountain source requires apiUrl or careersUrl");
  }

  const payload = await fetchJson(apiUrl);
  const openings = Array.isArray(payload?.openings) ? payload.openings : [];
  const boardUrl = String(source.boardUrl || apiUrl.replace(/\.json(?:\?.*)?$/i, "")).trim();

  return openings.map((opening) => {
    const toParam = String(opening?.to_param || "").trim();
    const applyUrl = toParam ? `${boardUrl}/${toParam}` : boardUrl;
    const locationLabel = String(opening?.location_name || opening?.location_address || "").trim() || "Unspecified";
    return buildNormalizedJob(source, {
      id: applyUrl,
      company: source.company,
      title: String(opening?.title || "").trim() || "Untitled Position",
      locationLabel,
      postedAt: String(opening?.posted_at || opening?.created_at || opening?.updated_at || opening?.published_at || "").trim() || null,
      applyUrl,
      employmentType: String(opening?.job_type || "").trim() || null,
      rawLocationText: locationLabel,
    });
  });
}

function resolveFountainApiUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return raw.endsWith(".json") ? raw : `${raw.replace(/\/+$/, "")}.json`;
}
