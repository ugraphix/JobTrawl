import {
  absoluteUrl,
  buildNormalizedJob,
  cleanText,
  decodeHtmlEntities,
  deriveTitleFromUrl,
  fetchJson,
  fetchText,
  safeText,
} from "./shared.js";

const MAX_ICIMS_PAGES = 8;

export async function fetchICimsJobs(source, filters = {}) {
  const customerId = source.customerId;
  const portal = source.portalId || source.portalName || source.portal;
  const username = source.username;
  const password = source.password;

  if (customerId && portal && username && password) {
    return fetchAuthenticatedICimsJobs(source, customerId, portal, username, password);
  }

  return fetchPublicICimsJobs(source, filters);
}

async function fetchAuthenticatedICimsJobs(source, customerId, portal, username, password) {
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

async function fetchPublicICimsJobs(source, filters) {
  const searchUrl = resolveICimsSearchUrl(source, filters);
  const wrapperHtml = await fetchText(searchUrl);
  let pageUrl = extractICimsIframeUrlFromHtml(wrapperHtml, searchUrl);
  const jobs = [];
  const seenPageUrls = new Set();
  const seenJobUrls = new Set();

  for (let page = 0; page < MAX_ICIMS_PAGES; page += 1) {
    const normalizedPageUrl = ensureICimsIframeUrl(pageUrl);
    if (!normalizedPageUrl || seenPageUrls.has(normalizedPageUrl)) {
      break;
    }

    seenPageUrls.add(normalizedPageUrl);
    const pageHtml = await fetchText(normalizedPageUrl);
    const batch = extractICimsSearchResults(source, pageHtml, normalizedPageUrl);

    for (const job of batch) {
      if (!job.applyUrl || seenJobUrls.has(job.applyUrl)) {
        continue;
      }
      seenJobUrls.add(job.applyUrl);
      jobs.push(job);
    }

    const nextPageUrl = extractICimsNextPageUrlFromHtml(pageHtml, normalizedPageUrl);
    if (!nextPageUrl) {
      break;
    }

    pageUrl = nextPageUrl;
  }

  return jobs;
}

function resolveICimsSearchUrl(source, filters) {
  const template = source.keywordSearchUrlTemplate;
  if (!template) {
    return ensureICimsIframeUrl(source.careersUrl);
  }

  const keyword = String(filters?.keyword || "").trim();
  const location = buildSearchLocation(filters);

  return ensureICimsIframeUrl(
    template
      .replaceAll("{{keyword}}", encodeURIComponent(keyword))
      .replaceAll("{{location}}", encodeURIComponent(location))
  );
}

function buildSearchLocation(filters) {
  const groups = Array.isArray(filters?.locationGroups) ? filters.locationGroups : [];
  const firstGroup = groups.find((group) => group?.stateCode || (group?.areaNames && group.areaNames.length > 0));

  if (!firstGroup) {
    return "";
  }

  const area = Array.isArray(firstGroup.areaNames) && firstGroup.areaNames.length > 0 ? firstGroup.areaNames[0] : "";
  const state = firstGroup.stateCode || "";
  return [area, state].filter(Boolean).join(", ");
}

function ensureICimsIframeUrl(urlValue) {
  if (!urlValue) {
    return null;
  }

  try {
    const parsed = new URL(urlValue);
    if (!parsed.pathname.includes("/jobs/search")) {
      parsed.pathname = "/jobs/search";
    }
    if (!parsed.searchParams.has("ss")) {
      parsed.searchParams.set("ss", "1");
    }
    return parsed.toString();
  } catch {
    return urlValue;
  }
}

function extractICimsIframeUrlFromHtml(pageHtml, baseUrl) {
  const source = String(pageHtml || "");
  const patterns = [
    /icimsFrame\.src\s*=\s*'([^']+)'/i,
    /icimsFrame\.src\s*=\s*"([^"]+)"/i,
    /<iframe[^>]*id=["']icims_content_iframe["'][^>]*src=["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const rawValue = String(match?.[1] || "").trim();
    if (!rawValue) {
      continue;
    }

    let candidate = decodeHtmlEntities(rawValue).replace(/\\\//g, "/");
    if (candidate.startsWith("//")) {
      try {
        const parsedBase = new URL(baseUrl);
        candidate = `${parsedBase.protocol}${candidate}`;
      } catch {
        candidate = `https:${candidate}`;
      }
    } else if (!/^https?:\/\//i.test(candidate)) {
      candidate = absoluteUrl(candidate, baseUrl);
    }

    if (candidate) {
      return ensureICimsIframeUrl(candidate);
    }
  }

  return ensureICimsIframeUrl(baseUrl);
}

function extractICimsNextPageUrlFromHtml(pageHtml, currentUrl) {
  const source = String(pageHtml || "");
  const patterns = [
    /<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']next["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const rawValue = String(match?.[1] || "").trim();
    if (!rawValue) {
      continue;
    }

    let candidate = decodeHtmlEntities(rawValue).replace(/\\\//g, "/");
    if (candidate.startsWith("//")) {
      try {
        const parsedCurrent = new URL(currentUrl);
        candidate = `${parsedCurrent.protocol}${candidate}`;
      } catch {
        candidate = `https:${candidate}`;
      }
    } else if (!/^https?:\/\//i.test(candidate)) {
      candidate = absoluteUrl(candidate, currentUrl);
    }

    if (candidate) {
      return ensureICimsIframeUrl(candidate);
    }
  }

  return null;
}

function extractICimsSearchResults(source, html, requestUrl) {
  const matches = [...html.matchAll(/<li[^>]*class=["'][^"']*iCIMS_JobCardItem[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)];
  const jobs = [];

  for (const match of matches) {
    const cardHtml = match[1];
    const titleMatch = cardHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) {
      continue;
    }

    const href = titleMatch[1];
    const absoluteHref = absoluteUrl(href, requestUrl || source.careersUrl);
    if (!absoluteHref || absoluteHref.toLowerCase().includes("/jobs/intro")) {
      continue;
    }

    const headingMatch = titleMatch[2].match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    const title = safeText(headingMatch?.[1] || titleMatch[2], 220);
    const locationMatch = cardHtml.match(/field-label["']>\s*Location\s*<\/span>[\s\S]*?<dd[^>]*iCIMS_JobHeaderData[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
    const employmentTypeMatch = cardHtml.match(/iCIMS_JobHeaderField["']>\s*Type\s*<\/dt>[\s\S]*?<dd[^>]*iCIMS_JobHeaderData[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
    const departmentMatch = cardHtml.match(/iCIMS_JobHeaderField["']>\s*(Division|Department)\s*<\/dt>[\s\S]*?<dd[^>]*iCIMS_JobHeaderData[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
    const postedAt = extractICimsPostingDateFromHtml(cardHtml);
    const locationLabel = safeText(locationMatch?.[1], 160) || "Unspecified";

    jobs.push(buildNormalizedJob(source, {
      id: absoluteHref,
      company: source.company,
      title: title || deriveTitleFromUrl(absoluteHref) || "Untitled role",
      department: safeText(departmentMatch?.[2], 120),
      employmentType: safeText(employmentTypeMatch?.[1], 80),
      locationLabel,
      postedAt,
      rawLocationText: locationLabel,
      applyUrl: absoluteHref,
      descriptionSnippet: safeText(cleanText(cardHtml), 220),
    }));
  }

  return jobs;
}

function extractICimsPostingDateFromHtml(sourceHtml) {
  const source = String(sourceHtml || "");
  const match = source.match(
    /field-label["']>\s*Date Posted\s*<\/span>[\s\S]*?<span[^>]*?(?:title=["']([^"']+)["'])?[^>]*>\s*([^<]*)/i
  );
  const withTitle = String(match?.[1] || "").trim();
  if (withTitle) {
    return withTitle;
  }
  return safeText(match?.[2], 80) || null;
}
