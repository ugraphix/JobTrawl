import { absoluteUrl, buildNormalizedJob, cleanText, decodeHtmlEntities, fetchText } from "./shared.js";

export async function fetchTheApplicantManagerJobs(source) {
  const companyCode = String(source.companyCode || source.co || "").trim().toLowerCase();
  const careersUrl = source.careersUrl
    || (companyCode ? `https://theapplicantmanager.com/careers?co=${encodeURIComponent(companyCode)}` : "");

  if (!careersUrl) {
    throw new Error("TheApplicantManager source requires careersUrl or companyCode");
  }

  const html = await fetchText(careersUrl);
  const postings = [];
  const seenUrls = new Set();
  let currentDepartment = "";

  const paragraphPattern = /<p[^>]*class=["']([^"']*\bpos_title_list\b[^"']*)["'][^>]*>([\s\S]*?)<\/p>/gi;
  const linkPattern = /<a[^>]*class=["'][^"']*\bpos_title_list\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;

  let paragraphMatch = paragraphPattern.exec(html);
  while (paragraphMatch) {
    const classNames = String(paragraphMatch[1] || "").toLowerCase();
    const bodyHtml = String(paragraphMatch[2] || "");

    if (classNames.includes("bold_font")) {
      currentDepartment = cleanInlineText(bodyHtml);
      paragraphMatch = paragraphPattern.exec(html);
      continue;
    }

    const linkMatch = bodyHtml.match(linkPattern);
    if (!linkMatch?.[1]) {
      paragraphMatch = paragraphPattern.exec(html);
      continue;
    }

    const applyUrl = absoluteUrl(linkMatch[1], careersUrl);
    if (!applyUrl || seenUrls.has(applyUrl)) {
      paragraphMatch = paragraphPattern.exec(html);
      continue;
    }

    const title = cleanInlineText(linkMatch[2]);
    if (!title || title.toLowerCase() === "resume") {
      paragraphMatch = paragraphPattern.exec(html);
      continue;
    }

    postings.push(buildNormalizedJob(source, {
      id: applyUrl,
      company: source.company,
      title,
      department: currentDepartment || null,
      team: currentDepartment || null,
      locationLabel: "Unspecified",
      applyUrl,
    }));
    seenUrls.add(applyUrl);
    paragraphMatch = paragraphPattern.exec(html);
  }

  return postings;
}

function cleanInlineText(value) {
  return cleanText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))) || "";
}
