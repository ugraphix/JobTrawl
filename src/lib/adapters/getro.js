import { buildNormalizedJob, fetchText } from "./shared.js";

export async function fetchGetroJobs(source) {
  const subdomain = String(source.subdomain || source.slug || "").trim().toLowerCase();
  const careersUrl = source.careersUrl || source.jobsUrl || (subdomain ? `https://${subdomain}.getro.com/jobs` : "");
  if (!careersUrl) {
    throw new Error("Getro source requires careersUrl or subdomain");
  }

  const html = await fetchText(careersUrl);
  const payload = extractNextData(html);
  const foundJobs = Array.isArray(payload?.props?.pageProps?.initialState?.jobs?.found)
    ? payload.props.pageProps.initialState.jobs.found
    : [];

  return foundJobs
    .filter((job) => String(job?.url || "").trim())
    .map((job) => {
      const searchableLocations = Array.isArray(job?.searchableLocations) ? job.searchableLocations : [];
      const locations = Array.isArray(job?.locations) ? job.locations : [];
      const locationLabel = String(searchableLocations[0] || locations[0] || "").trim() || "Unspecified";
      let postedAt = null;
      const createdAtRaw = job?.createdAt;
      if (Number.isFinite(Number(createdAtRaw)) && Number(createdAtRaw) > 0) {
        postedAt = new Date(Number(createdAtRaw)).toISOString();
      } else if (typeof createdAtRaw === "string" && createdAtRaw.trim()) {
        postedAt = createdAtRaw.trim();
      }

      return buildNormalizedJob(source, {
        id: job.url,
        company: source.company,
        title: String(job?.title || "").trim() || "Untitled Position",
        locationLabel,
        postedAt,
        applyUrl: String(job.url).trim(),
        rawLocationText: locationLabel,
      });
    });
}

function extractNextData(html) {
  const match = String(html || "").match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>\s*(\{[\s\S]*?\})\s*<\/script>/i);
  if (!match?.[1]) {
    return {};
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return {};
  }
}
