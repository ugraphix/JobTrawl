import { buildNormalizedJob, fetchText, safeText, stripTags, absoluteUrl } from "./shared.js";
import { fetchHostedBoardJobs } from "./hosted-board.js";

export async function fetchTaleoJobs(source) {
  if (source.rssUrl) {
    const xml = await fetchText(source.rssUrl, { accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" });
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];

    return items.map((match, index) => {
      const item = match[1];
      const title = extractTag(item, "title") || `Taleo job ${index + 1}`;
      const link = extractTag(item, "link");
      const description = stripTags(extractTag(item, "description") || "");
      const location = extractTag(item, "location") || extractTag(item, "city") || "Unspecified";

      return buildNormalizedJob(source, {
        id: link || `${source.key}-${index}`,
        company: source.company,
        title,
        locationLabel: location,
        postedAt: extractTag(item, "pubDate") || null,
        applyUrl: absoluteUrl(link, source.rssUrl),
        descriptionSnippet: safeText(description),
        rawLocationText: location,
      });
    });
  }

  return fetchHostedBoardJobs(source);
}

function extractTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? match[1].trim() : null;
}