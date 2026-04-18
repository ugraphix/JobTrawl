import { buildNormalizedJob, cleanText, decodeHtmlEntities, fetchText } from "./shared.js";

export async function fetchZohoJobs(source) {
  const subdomain = String(source.subdomain || source.slug || "").trim().toLowerCase();
  const careersUrl = source.careersUrl || (subdomain ? `https://${subdomain}.zohorecruit.com/jobs/Careers` : "");
  if (!careersUrl) {
    throw new Error("Zoho source requires careersUrl or subdomain");
  }

  const html = await fetchText(careersUrl);
  const rawJobsPayload =
    html.match(/<input[^>]+(?:id|name)=["']jobs["'][^>]+value=["']([^"']+)["']/i)?.[1]
    || html.match(/<input[^>]+value=["']([^"']+)["'][^>]+(?:id|name)=["']jobs["'][^>]*>/i)?.[1];
  if (!rawJobsPayload) {
    return [];
  }

  let jobs = [];
  try {
    const parsed = JSON.parse(decodeHtmlEntities(rawJobsPayload));
    jobs = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }

  const listUrl = careersUrl;
  const postings = [];
  const seenIds = new Set();

  for (const job of jobs) {
    if (!job || typeof job !== "object" || job.Publish === false) {
      continue;
    }

    const jobId = String(job.id || "").trim();
    if (!jobId || seenIds.has(jobId)) {
      continue;
    }

    const city = cleanInlineText(job.City);
    const region = cleanInlineText(job.State);
    const country = cleanInlineText(job.Country);
    const locationLabel = [city, region, country].filter(Boolean).join(", ") || "Unspecified";
    const title = cleanInlineText(job.Posting_Title) || cleanInlineText(job.Job_Opening_Name) || "Untitled Position";

    postings.push(buildNormalizedJob(source, {
      id: jobId,
      company: source.company,
      title,
      team: cleanInlineText(job.Industry) || null,
      department: cleanInlineText(job.Industry) || null,
      locationLabel,
      city: city || null,
      region: region || null,
      country: country || null,
      postedAt: cleanInlineText(job.Date_Opened) || null,
      applyUrl: buildZohoJobUrl(listUrl, jobId),
      rawLocationText: locationLabel,
    }));
    seenIds.add(jobId);
  }

  return postings;
}

function buildZohoJobUrl(listUrl, jobId) {
  const url = new URL(listUrl);
  url.searchParams.set("id", jobId);
  return url.toString();
}

function cleanInlineText(value) {
  return cleanText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))) || "";
}
