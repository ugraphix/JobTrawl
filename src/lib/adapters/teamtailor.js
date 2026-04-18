import { absoluteUrl, buildNormalizedJob, cleanText, decodeHtmlEntities, fetchText } from "./shared.js";

export async function fetchTeamtailorJobs(source) {
  const subdomain = String(source.subdomain || source.slug || "").trim().toLowerCase();
  const careersUrl = source.careersUrl || source.jobsUrl || (subdomain ? `https://${subdomain}.teamtailor.com/jobs` : "");
  if (!careersUrl) {
    throw new Error("Teamtailor source requires careersUrl or subdomain");
  }

  const html = await fetchText(careersUrl);
  const postings = [];
  const seenUrls = new Set();
  const itemPattern = /<li[^>]*class=["'][^"']*\bblock-grid-item\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  const hrefPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>/i;
  const titleAttrPattern = /<span[^>]*class=["'][^"']*\btext-block-base-link\b[^"']*["'][^>]*\btitle=["']([^"']+)["'][^>]*>/i;
  const titleBodyPattern = /<span[^>]*class=["'][^"']*\btext-block-base-link\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i;
  const metaPattern = /<div[^>]*class=["'][^"']*\bmt-1\b[^"']*\btext-md\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;

  let itemMatch = itemPattern.exec(html);
  while (itemMatch) {
    const itemHtml = String(itemMatch[1] || "");
    const href = String(itemHtml.match(hrefPattern)?.[1] || "").trim();
    const applyUrl = absoluteUrl(href, careersUrl);
    if (!applyUrl || seenUrls.has(applyUrl)) {
      itemMatch = itemPattern.exec(html);
      continue;
    }

    const title = cleanInlineText(itemHtml.match(titleAttrPattern)?.[1] || "")
      || cleanInlineText(itemHtml.match(titleBodyPattern)?.[1] || "")
      || "Untitled Position";
    const metaParts = extractMetaParts(String(itemHtml.match(metaPattern)?.[1] || ""));
    const department = metaParts.length > 1 ? metaParts[0] : null;
    const locationLabel = metaParts.length > 1 ? metaParts.slice(1).join(" / ") : metaParts[0] || "Unspecified";

    postings.push(buildNormalizedJob(source, {
      id: applyUrl,
      company: source.company,
      title,
      team: department,
      department,
      locationLabel,
      applyUrl,
      rawLocationText: locationLabel,
    }));
    seenUrls.add(applyUrl);
    itemMatch = itemPattern.exec(html);
  }

  return postings;
}

function extractMetaParts(value) {
  const parts = [];
  const seen = new Set();
  const spanPattern = /<span[^>]*>([\s\S]*?)<\/span>/gi;
  let spanMatch = spanPattern.exec(value);
  while (spanMatch) {
    const text = cleanInlineText(spanMatch[1]);
    if (text && !seen.has(text.toLowerCase())) {
      parts.push(text);
      seen.add(text.toLowerCase());
    }
    spanMatch = spanPattern.exec(value);
  }
  return parts;
}

function cleanInlineText(value) {
  return cleanText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))) || "";
}
