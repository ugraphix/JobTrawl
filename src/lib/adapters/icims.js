import { buildNormalizedJob, fetchJson, deriveTitleFromUrl } from "./shared.js";

export async function fetchICimsJobs(source) {
  const customerId = source.customerId;
  const portal = source.portalId || source.portalName || source.portal;
  const username = source.username;
  const password = source.password;

  if (!customerId || !portal || !username || !password) {
    throw new Error("iCIMS source requires customerId, portalId or portalName, username, and password");
  }

  const url = new URL(`https://api.icims.com/customers/${customerId}/search/portals/${portal}`);
  const payload = await fetchJson(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    },
  });

  const jobs = Array.isArray(payload.searchResults) ? payload.searchResults : [];

  return jobs.map((job, index) => {
    const portalUrl = job.portalUrl || job.applyUrl || job.url;
    return buildNormalizedJob(source, {
      id: job.id || portalUrl || `${source.key}-${index}`,
      company: source.company,
      title: job.title || deriveTitleFromUrl(portalUrl) || `iCIMS job ${index + 1}`,
      locationLabel: job.location || "Unspecified",
      postedAt: job.updatedDate || job.postedDate || null,
      applyUrl: portalUrl,
      rawLocationText: job.location || null,
      employmentType: job.employmentType || null,
    });
  });
}