import { absoluteUrl, buildNormalizedJob, cleanText, decodeHtmlEntities, fetchText } from "./shared.js";

export async function fetchApplicantProJobs(source) {
  const careersUrl = String(source.careersUrl || "").trim();
  if (!careersUrl) {
    throw new Error("ApplicantPro source requires careersUrl");
  }

  const listingUrl = new URL("/jobs/view.php", careersUrl);
  listingUrl.searchParams.set("n", "jobListings");
  listingUrl.searchParams.set("f", "getListings");
  listingUrl.searchParams.set("keywords", "");

  const html = await fetchText(listingUrl.toString(), {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      Referer: careersUrl,
    },
  });

  const postings = [];
  const seenUrls = new Set();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let anchorMatch = anchorPattern.exec(html);

  while (anchorMatch) {
    const attributes = String(anchorMatch[1] || "");
    const classNames = extractAttribute(attributes, "class").toLowerCase();
    if (!/\blist-group-item\b/.test(classNames)) {
      anchorMatch = anchorPattern.exec(html);
      continue;
    }

    const href = extractAttribute(attributes, "href");
    const applyUrl = absoluteUrl(href, careersUrl);
    const bodyHtml = String(anchorMatch[2] || "");
    const title = cleanInlineText(bodyHtml.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1] || "");
    if (!applyUrl || !title || seenUrls.has(applyUrl)) {
      anchorMatch = anchorPattern.exec(html);
      continue;
    }

    const details = [...bodyHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((match) => cleanInlineText(match[1]))
      .filter(Boolean);

    const locationLabel = details[0] || "Unspecified";
    const employmentType = details[1] || null;

    postings.push(buildNormalizedJob(source, {
      id: applyUrl,
      company: source.company,
      title,
      locationLabel,
      rawLocationText: locationLabel,
      employmentType,
      applyUrl,
    }));
    seenUrls.add(applyUrl);
    anchorMatch = anchorPattern.exec(html);
  }

  return postings;
}

function cleanInlineText(value) {
  return cleanText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))) || "";
}

function extractAttribute(attributes, name) {
  const pattern = new RegExp(`${name}=["']([^"']+)["']`, "i");
  return String(attributes.match(pattern)?.[1] || "").trim();
}
