import { absoluteUrl, buildNormalizedJob, cleanText, decodeHtmlEntities, fetchText } from "./shared.js";

export async function fetchApplicantAiJobs(source) {
  const slug = String(source.slug || "").trim();
  const careersUrl = source.careersUrl || (slug ? `https://applicantai.com/${slug}` : "");
  if (!careersUrl) {
    throw new Error("ApplicantAI source requires careersUrl or slug");
  }

  const html = await fetchText(careersUrl);
  const postings = [];
  const seenUrls = new Set();

  const blockPattern = /<div[^>]*class=["'][^"']*\bmy-4\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  const headingLinkPattern = /<h4[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h4>/i;
  const locationPattern = /<small[^>]*class=["'][^"']*\btext-muted\b[^"']*["'][^>]*>([\s\S]*?)<\/small>/i;

  let blockMatch = blockPattern.exec(html);
  while (blockMatch) {
    const blockHtml = String(blockMatch[1] || "");
    const headingMatch = blockHtml.match(headingLinkPattern);
    if (!headingMatch?.[1]) {
      blockMatch = blockPattern.exec(html);
      continue;
    }

    const href = String(headingMatch[1] || "").trim();
    if (!/\/jobs?\//i.test(href)) {
      blockMatch = blockPattern.exec(html);
      continue;
    }

    const applyUrl = absoluteUrl(href, careersUrl);
    if (!applyUrl || seenUrls.has(applyUrl)) {
      blockMatch = blockPattern.exec(html);
      continue;
    }

    const title = cleanInlineText(headingMatch[2]) || "Untitled Position";
    const locationLabel = cleanInlineText(blockHtml.match(locationPattern)?.[1] || "") || "Unspecified";

    postings.push(buildNormalizedJob(source, {
      id: applyUrl,
      company: source.company,
      title,
      locationLabel,
      applyUrl,
      rawLocationText: locationLabel,
    }));
    seenUrls.add(applyUrl);
    blockMatch = blockPattern.exec(html);
  }

  return postings;
}

function cleanInlineText(value) {
  return cleanText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))) || "";
}
