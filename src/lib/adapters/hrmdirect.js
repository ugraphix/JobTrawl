import { absoluteUrl, buildNormalizedJob, cleanText, decodeHtmlEntities, fetchText } from "./shared.js";

export async function fetchHrmDirectJobs(source) {
  const careersUrl = source.careersUrl || source.jobsUrl || resolveHrmDirectJobsUrl(source);
  if (!careersUrl) {
    throw new Error("HRM Direct source requires careersUrl or jobsUrl");
  }

  const html = await fetchText(careersUrl);
  const baseOrigin = new URL(careersUrl).origin;
  const postings = [];
  const seenUrls = new Set();
  const rowPattern = /<tr[^>]*class=["'][^"']*\breqitem1?\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;

  let rowMatch = rowPattern.exec(html);
  while (rowMatch) {
    const rowHtml = String(rowMatch[1] || "");
    const titleCell = extractCell(rowHtml, "posTitle");
    const titleLinkMatch = titleCell.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/a>|$)/i);
    const href = normalizeHref(titleLinkMatch?.[1] || "");
    if (!href) {
      rowMatch = rowPattern.exec(html);
      continue;
    }

    const applyUrl = absoluteUrl(href, `${baseOrigin}/employment/`);
    if (!applyUrl || seenUrls.has(applyUrl)) {
      rowMatch = rowPattern.exec(html);
      continue;
    }

    const city = cleanInlineText(extractCell(rowHtml, "cities"));
    const region = cleanInlineText(extractCell(rowHtml, "state"));
    const locationLabel = [city, region].filter(Boolean).join(", ") || "Unspecified";
    const department = cleanInlineText(extractCell(rowHtml, "departments")) || null;
    const postedAt = cleanInlineText(extractCell(rowHtml, "date")) || cleanInlineText(extractCell(rowHtml, "dates")) || null;

    postings.push(buildNormalizedJob(source, {
      id: applyUrl,
      company: source.company,
      title: cleanInlineText(titleLinkMatch?.[2] || titleCell) || "Untitled Position",
      team: department,
      department,
      locationLabel,
      city: city || null,
      region: region || null,
      postedAt,
      applyUrl,
      rawLocationText: locationLabel,
    }));
    seenUrls.add(applyUrl);
    rowMatch = rowPattern.exec(html);
  }

  return postings;
}

function resolveHrmDirectJobsUrl(source) {
  const raw = String(source.boardUrl || source.url || "").trim();
  if (!raw) {
    return "";
  }
  const url = new URL(raw);
  if (!/\/employment\/job-openings\.php$/i.test(String(url.pathname || ""))) {
    url.pathname = "/employment/job-openings.php";
  }
  if (!url.searchParams.has("search")) {
    url.searchParams.set("search", "true");
  }
  url.hash = "";
  return url.toString();
}

function extractCell(rowHtml, className) {
  const escaped = String(className || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(rowHtml || "").match(new RegExp(`<td[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "i"));
  return String(match?.[1] || "");
}

function normalizeHref(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/&#job/gi, "")
    .replace(/#job/gi, "")
    .replace(/&{2,}/g, "&")
    .replace(/[&\s]+$/g, "")
    .trim();
}

function cleanInlineText(value) {
  return cleanText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))) || "";
}
