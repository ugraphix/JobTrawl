import { absoluteUrl, buildNormalizedJob, cleanText, decodeHtmlEntities, fetchText } from "./shared.js";

export async function fetchBreezyJobs(source) {
  const subdomain = String(source.subdomain || source.slug || "").trim().toLowerCase();
  const careersUrl = source.careersUrl || source.portalUrl || (subdomain ? `https://${subdomain}.breezy.hr/` : "");
  if (!careersUrl) {
    throw new Error("Breezy source requires careersUrl or subdomain");
  }

  const html = await fetchText(careersUrl);
  const postings = [];
  const seenUrls = new Set();

  const linkPattern = /<a[^>]*href=["']((?:https?:\/\/[^"'<>]+)?\/p\/[^"'<>]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titlePattern = /<h2[^>]*>([\s\S]*?)<\/h2>/i;
  const locationPattern = /<li[^>]*class=["'][^"']*\blocation\b[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i;
  const postedPattern = /<li[^>]*class=["'][^"']*(?:posted|created|date)[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i;
  const departmentPattern = /<h2[^>]*class=["'][^"']*\bgroup-header\b[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/gi;

  let linkMatch = linkPattern.exec(html);
  while (linkMatch) {
    const applyUrl = absoluteUrl(linkMatch[1], careersUrl);
    if (!applyUrl || seenUrls.has(applyUrl)) {
      linkMatch = linkPattern.exec(html);
      continue;
    }

    const linkBody = String(linkMatch[2] || "");
    const title = cleanInlineText(linkBody.match(titlePattern)?.[1] || "");
    if (!title) {
      linkMatch = linkPattern.exec(html);
      continue;
    }

    const locationLabel = cleanInlineText(linkBody.match(locationPattern)?.[1] || "") || "Unspecified";
    const postedAt = cleanInlineText(linkBody.match(postedPattern)?.[1] || "") || null;
    const contextBefore = html.slice(Math.max(0, Number(linkMatch.index || 0) - 3000), Number(linkMatch.index || 0));
    const departmentMatches = Array.from(contextBefore.matchAll(departmentPattern));
    const department = departmentMatches.length > 0
      ? cleanInlineText(departmentMatches[departmentMatches.length - 1][1] || "")
      : "";

    postings.push(buildNormalizedJob(source, {
      id: applyUrl,
      company: source.company,
      title,
      team: department || null,
      department: department || null,
      locationLabel,
      postedAt,
      applyUrl,
      rawLocationText: locationLabel,
    }));
    seenUrls.add(applyUrl);
    linkMatch = linkPattern.exec(html);
  }

  return postings;
}

function cleanInlineText(value) {
  return cleanText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))) || "";
}
