import { absoluteUrl, buildNormalizedJob, cleanText, decodeHtmlEntities, fetchText } from "./shared.js";

export async function fetchCareerPlugJobs(source) {
  const subdomain = String(source.subdomain || source.slug || "").trim().toLowerCase();
  const careersUrl = source.careersUrl || source.jobsUrl || (subdomain ? `https://${subdomain}.careerplug.com/jobs` : "");
  if (!careersUrl) {
    throw new Error("CareerPlug source requires careersUrl or subdomain");
  }

  const html = await fetchText(careersUrl);
  const postings = [];
  const seenUrls = new Set();
  const rowPattern = /<a[^>]*\baria-label=["'][^"']*["'][^>]*\bhref=["'](\/jobs\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titlePattern = /<div[^>]*class=["'][^"']*\bjob-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
  const locationPattern = /<div[^>]*class=["'][^"']*\bjob-location\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
  const typePattern = /<div[^>]*class=["'][^"']*\bjob-type\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;

  let rowMatch = rowPattern.exec(html);
  while (rowMatch) {
    const applyUrl = absoluteUrl(rowMatch[1], careersUrl);
    if (!applyUrl || seenUrls.has(applyUrl)) {
      rowMatch = rowPattern.exec(html);
      continue;
    }

    const rowHtml = String(rowMatch[2] || "");
    const title = cleanInlineText(rowHtml.match(titlePattern)?.[1] || "") || "Untitled Position";
    const locationLabel = cleanInlineText(rowHtml.match(locationPattern)?.[1] || "") || "Unspecified";
    const employmentType = cleanInlineText(rowHtml.match(typePattern)?.[1] || "") || null;

    postings.push(buildNormalizedJob(source, {
      id: applyUrl,
      company: source.company,
      title,
      locationLabel,
      employmentType,
      applyUrl,
      rawLocationText: locationLabel,
    }));
    seenUrls.add(applyUrl);
    rowMatch = rowPattern.exec(html);
  }

  return postings;
}

function cleanInlineText(value) {
  return cleanText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))) || "";
}
