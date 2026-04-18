import { absoluteUrl, buildNormalizedJob, cleanText, decodeHtmlEntities, fetchText } from "./shared.js";

export async function fetchTalentlyftJobs(source) {
  const subdomain = String(source.subdomain || source.slug || "").trim().toLowerCase();
  const careersUrl = source.careersUrl || (subdomain ? `https://${subdomain}.talentlyft.com/` : "");
  if (!careersUrl) {
    throw new Error("Talentlyft source requires careersUrl or subdomain");
  }

  const landingHtml = await fetchText(careersUrl);
  const runtimeConfig = extractInitialConfig(landingHtml, careersUrl);
  const postings = [];
  const seenUrls = new Set();
  let totalPages = 1;

  for (let page = 1; page <= Math.min(25, totalPages); page += 1) {
    const params = new URLSearchParams({
      layoutId: String(runtimeConfig.layoutId || "Jobs-1"),
      websiteUrl: String(runtimeConfig.websiteUrl || ""),
      themeId: String(runtimeConfig.themeId || "2"),
      language: String(runtimeConfig.language || "en"),
      subdomain: String(runtimeConfig.subdomain || ""),
      page: String(page),
      pageSize: "20",
      contains: "",
    }).toString();

    const fragmentHtml = await fetchText(`${runtimeConfig.apiUrl}${runtimeConfig.apiUrl.includes("?") ? "&" : "?"}${params}`, {
      accept: "text/html, */*; q=0.01",
      headers: {
        "x-requested-with": "XMLHttpRequest",
        Referer: `${String(runtimeConfig.websiteUrl || "").replace(/\/+$/, "")}/`,
      },
    });

    const batch = parseFragment(source, runtimeConfig, fragmentHtml);
    for (const job of batch) {
      if (!seenUrls.has(job.applyUrl)) {
        postings.push(job);
        seenUrls.add(job.applyUrl);
      }
    }

    totalPages = Math.max(totalPages, extractTotalPages(fragmentHtml));
    if (batch.length === 0 && page >= totalPages) {
      break;
    }
  }

  return postings;
}

function extractInitialConfig(pageHtml, fallbackUrl) {
  const source = String(pageHtml || "");
  const parsed = new URL(fallbackUrl);
  const websiteUrlDefault = `${parsed.protocol}//${parsed.host}`;
  const subdomainDefault = String(parsed.hostname || "").split(".")[0] || "";
  const pickFirst = (patterns) => {
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) {
        return String(match[1]).trim();
      }
    }
    return "";
  };

  const layoutId = pickFirst([/layoutId\s*:\s*['"]([^'"]+)['"]/i, /layoutId\s*=\s*['"]([^'"]+)['"]/i]) || "Jobs-1";
  const themeId = pickFirst([/themeId\s*:\s*['"]([^'"]+)['"]/i, /themeId\s*=\s*['"]([^'"]+)['"]/i]) || "2";
  const language = pickFirst([/language\s*:\s*['"]([^'"]+)['"]/i, /language\s*=\s*['"]([^'"]+)['"]/i]) || "en";
  const subdomain = pickFirst([/subdomain\s*:\s*['"]([^'"]+)['"]/i, /subdomain\s*=\s*['"]([^'"]+)['"]/i]) || subdomainDefault;
  const websiteUrl = pickFirst([/websiteUrl\s*:\s*['"]([^'"]+)['"]/i, /websiteUrl\s*=\s*['"]([^'"]+)['"]/i]) || websiteUrlDefault;

  return {
    layoutId,
    themeId,
    language,
    subdomain,
    websiteUrl,
    baseOrigin: websiteUrlDefault,
    apiUrl: `${websiteUrl}/JobList/`,
  };
}

function parseFragment(source, runtimeConfig, fragmentHtml) {
  const html = String(fragmentHtml || "");
  const itemPattern = /<a[^>]*class=['"][^'"]*\bjobs__box\b[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  const jobs = [];
  let itemMatch = itemPattern.exec(html);
  while (itemMatch) {
    const blockHtml = String(itemMatch[0] || "");
    const bodyHtml = String(itemMatch[1] || "");
    const href = String(blockHtml.match(/\bhref=['"]([^'"]+)['"]/i)?.[1] || "").trim();
    const applyUrl = absoluteUrl(href, `${runtimeConfig.baseOrigin}/`);
    if (!applyUrl) {
      itemMatch = itemPattern.exec(html);
      continue;
    }

    const title = cleanInlineText(bodyHtml.match(/<h3[^>]*class=['"][^'"]*\bjobs__box__heading\b[^'"]*['"][^>]*>([\s\S]*?)<\/h3>/i)?.[1] || "") || "Untitled Position";
    const locationLabel = cleanInlineText(bodyHtml.match(/<p[^>]*class=['"][^'"]*\bjobs__box__text\b[^'"]*['"][^>]*>([\s\S]*?)<\/p>/i)?.[1] || "") || "Unspecified";
    const id = String(blockHtml.match(/\bdata-job-id=['"](\d+)['"]/i)?.[1] || blockHtml.match(/\bid=['"](\d+)['"]/i)?.[1] || applyUrl).trim();

    jobs.push(buildNormalizedJob(source, {
      id,
      company: source.company,
      title,
      locationLabel,
      applyUrl,
      rawLocationText: locationLabel,
    }));
    itemMatch = itemPattern.exec(html);
  }

  return jobs;
}

function extractTotalPages(fragmentHtml) {
  const pages = Array.from(String(fragmentHtml || "").matchAll(/data-page=['"](\d+)['"]/gi))
    .map((match) => Number(match?.[1] || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return pages.length > 0 ? Math.max(...pages) : 1;
}

function cleanInlineText(value) {
  return cleanText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))) || "";
}
