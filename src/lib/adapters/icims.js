import {
  absoluteUrl,
  buildNormalizedJob,
  cleanText,
  decodeHtmlEntities,
  deriveLocationMetadata,
  deriveTitleFromUrl,
  fetchDescriptionFallback,
  extractPostedDateFromHtml,
  fetchJson,
  fetchText,
  mapWithConcurrency,
  recordLiveFetchAuditSummary,
  safeText,
} from "./shared.js";

const MAX_ICIMS_PAGES = 8;
const ICIMS_DETAIL_CONCURRENCY = 3;
const ICIMS_DETAIL_MAX_JOBS = 120;
const ICIMS_LEGACY_MODE = String(process.env.JOBTRAWL_ICIMS_LEGACY_MODE || "").trim().toLowerCase() === "true";

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
  recordLiveFetchAuditSummary({
    rawJobCount: jobs.length,
    rawJobCountBasis: "icims_authenticated_searchresults",
  });

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
  if (ICIMS_LEGACY_MODE) {
    return fetchLegacyPublicICimsJobs(source, filters);
  }

  const searchUrl = resolveICimsSearchUrl(source, filters);
  const wrapperHtml = await fetchText(searchUrl);
  const visitedShapes = [];
  const visitedApiHints = new Set();
  let pageUrl = extractICimsIframeUrlFromHtml(wrapperHtml, searchUrl);
  const jobs = [];
  const seenPageUrls = new Set();
  const seenJobUrls = new Set();
  let parserGap = false;
  let shellOnly = false;
  let usedRedirectTarget = false;

  for (let page = 0; page < MAX_ICIMS_PAGES; page += 1) {
    const normalizedPageUrl = normalizeICimsPageUrl(pageUrl, { preferIframe: true });
    if (!normalizedPageUrl || seenPageUrls.has(normalizedPageUrl)) {
      break;
    }

    seenPageUrls.add(normalizedPageUrl);
    const pageHtml = await fetchText(normalizedPageUrl);
    const pageInspection = inspectICimsSearchPage(pageHtml, normalizedPageUrl);
    visitedShapes.push({
      url: normalizedPageUrl,
      pageType: pageInspection.pageType,
      jobCardCount: pageInspection.jobCardCount,
      jsonLdJobCount: pageInspection.jsonLdJobs.length,
      embeddedJobCount: pageInspection.embeddedJobs.length,
      redirectTarget: pageInspection.redirectTarget || null,
      hasPagination: pageInspection.hasPagination,
      isGeoGated: pageInspection.isGeoGated,
      isShellOnly: pageInspection.isShellOnly,
      explicitEmpty: pageInspection.explicitEmpty,
    });
    for (const apiUrl of pageInspection.apiHints) {
      visitedApiHints.add(apiUrl);
    }

    let batch = extractICimsSearchResults(source, pageHtml, normalizedPageUrl);
    if (batch.length === 0 && pageInspection.jsonLdJobs.length > 0) {
      batch = buildICimsJobsFromStructuredEntries(source, pageInspection.jsonLdJobs, normalizedPageUrl);
    }
    if (batch.length === 0 && pageInspection.embeddedJobs.length > 0) {
      batch = buildICimsJobsFromStructuredEntries(source, pageInspection.embeddedJobs, normalizedPageUrl);
    }

    if (
      batch.length === 0
      && pageInspection.redirectTarget
      && !seenPageUrls.has(pageInspection.redirectTarget)
    ) {
      usedRedirectTarget = true;
      pageUrl = pageInspection.redirectTarget;
      shellOnly = pageInspection.isShellOnly;
      parserGap = pageInspection.isShellOnly || pageInspection.isGeoGated || pageInspection.pageType === "js_shell";
      continue;
    }

    for (const job of batch) {
      if (!job.applyUrl || seenJobUrls.has(job.applyUrl)) {
        continue;
      }
      seenJobUrls.add(job.applyUrl);
      jobs.push(job);
    }

    const nextPageUrl = extractICimsNextPageUrlFromHtml(pageHtml, normalizedPageUrl);
    if (!nextPageUrl) {
      shellOnly = shellOnly || pageInspection.isShellOnly;
      parserGap = parserGap || (
        batch.length === 0
        && (pageInspection.isShellOnly || pageInspection.isGeoGated || pageInspection.pageType === "embedded_json")
        && !pageInspection.explicitEmpty
      );
      break;
    }

    pageUrl = nextPageUrl;
  }

  const keyword = String(filters?.keyword || "").trim();
  const detailJobs = source.fetchIcimsDetails !== false
    ? prioritizeICimsDetailJobs(jobs, keyword)
    : [];

  if (detailJobs.length > 0) {
    await enrichICimsDescriptions(detailJobs);
  }

  recordLiveFetchAuditSummary({
    rawJobCount: jobs.length,
    rawJobCountBasis: "icims_public_search_html_results",
    icimsSearchUrl: searchUrl,
    icimsVisitedShapes: visitedShapes,
    icimsApiHints: [...visitedApiHints].slice(0, 20),
    icimsShellOnly: shellOnly,
    icimsParserGap: parserGap,
    icimsUsedRedirectTarget: usedRedirectTarget,
    icimsPrimaryPageType: visitedShapes.find((entry) => entry.jobCardCount > 0 || entry.embeddedJobCount > 0 || entry.jsonLdJobCount > 0)?.pageType
      || visitedShapes[visitedShapes.length - 1]?.pageType
      || "unknown_html",
  });

  return jobs;
}

async function fetchLegacyPublicICimsJobs(source, filters) {
  const searchUrl = resolveICimsSearchUrl(source, filters);
  const wrapperHtml = await fetchText(searchUrl);
  let pageUrl = extractICimsIframeUrlFromHtml(wrapperHtml, searchUrl);
  const jobs = [];
  const seenPageUrls = new Set();
  const seenJobUrls = new Set();

  for (let page = 0; page < MAX_ICIMS_PAGES; page += 1) {
    const normalizedPageUrl = normalizeICimsPageUrl(pageUrl, { preferIframe: true });
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

  const keyword = String(filters?.keyword || "").trim();
  const detailJobs = source.fetchIcimsDetails !== false
    ? prioritizeICimsDetailJobs(jobs, keyword)
    : [];

  if (detailJobs.length > 0) {
    await enrichICimsDescriptions(detailJobs);
  }

  recordLiveFetchAuditSummary({
    rawJobCount: jobs.length,
    rawJobCountBasis: "icims_public_search_html_results_legacy",
    icimsSearchUrl: searchUrl,
    icimsLegacyMode: true,
  });

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

function normalizeICimsPageUrl(urlValue, { preferIframe = false } = {}) {
  if (!urlValue) {
    return null;
  }

  try {
    const parsed = new URL(urlValue);
    if (/icims\.com$/i.test(parsed.hostname) || /\.icims\.com$/i.test(parsed.hostname)) {
      if (!parsed.pathname.includes("/jobs/search")) {
        parsed.pathname = "/jobs/search";
      }
      if (!parsed.searchParams.has("ss")) {
        parsed.searchParams.set("ss", "1");
      }
      if (preferIframe && !parsed.searchParams.has("in_iframe")) {
        parsed.searchParams.set("in_iframe", "1");
      }
    }
    return parsed.toString();
  } catch {
    return urlValue;
  }
}

function ensureICimsIframeUrl(urlValue) {
  return normalizeICimsPageUrl(urlValue, { preferIframe: false });
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
      return normalizeICimsPageUrl(candidate, { preferIframe: false });
    }
  }

  return normalizeICimsPageUrl(baseUrl, { preferIframe: false });
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
      return normalizeICimsPageUrl(candidate, { preferIframe: true });
    }
  }

  return null;
}

function inspectICimsSearchPage(pageHtml, requestUrl) {
  const source = String(pageHtml || "");
  const jsonLdJobs = extractICimsStructuredJobsFromJsonLd(source, requestUrl);
  const embeddedJobs = extractICimsStructuredJobsFromEmbeddedState(source, requestUrl);
  const redirectTarget = extractICimsRedirectTargetFromHtml(source, requestUrl);
  const apiHints = extractICimsApiHints(source);
  const jobCardCount = (source.match(/<li[^>]*class=["'][^"']*iCIMS_JobCardItem[^"']*["'][^>]*>/gi) || []).length;
  const hasPagination = Boolean(source.match(/<link[^>]*rel=["']next["'][^>]*href=/i));
  const hasShellMarkers = /<base href="\/careers-home|window\._jibe|app\.jibecdn\.com\/prod\/search|id="ng-app"|<app-root|data-jibe-search-version/i.test(source);
  const isGeoGated = /permission to access your location has been denied|location information has yet to be received/i.test(source);
  const explicitEmpty = /no current job openings|there are no job openings|sorry,\s*we have no current job openings/i.test(source);

  let pageType = "unknown_html";
  if (jobCardCount > 0) {
    pageType = "static_html";
  } else if (jsonLdJobs.length > 0) {
    pageType = "json_ld";
  } else if (embeddedJobs.length > 0) {
    pageType = "embedded_json";
  } else if (hasShellMarkers || redirectTarget) {
    pageType = "js_shell";
  } else if (isGeoGated) {
    pageType = "geo_gated";
  } else if (explicitEmpty) {
    pageType = "empty_board";
  }

  return {
    pageType,
    redirectTarget,
    apiHints,
    hasPagination,
    isGeoGated,
    explicitEmpty,
    isShellOnly: Boolean((hasShellMarkers || redirectTarget) && jobCardCount === 0 && jsonLdJobs.length === 0 && embeddedJobs.length === 0),
    jobCardCount,
    jsonLdJobs,
    embeddedJobs,
  };
}

function extractICimsRedirectTargetFromHtml(sourceHtml, baseUrl) {
  const source = String(sourceHtml || "");
  const match = source.match(/window\.top\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
  const raw = String(match?.[1] || "").trim();
  if (!raw) {
    return null;
  }
  return absoluteUrl(decodeHtmlEntities(raw).replace(/\\\//g, "/"), baseUrl);
}

function extractICimsApiHints(sourceHtml) {
  const source = String(sourceHtml || "");
  const matches = source.match(/https?:\/\/[^"'\s>]+|\/api\/[A-Za-z0-9_./?=&-]+/g) || [];
  return [...new Set(matches.filter((value) => /api|job|search|career/i.test(value)))];
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

function extractICimsStructuredJobsFromJsonLd(sourceHtml, requestUrl) {
  const source = String(sourceHtml || "");
  const matches = [...source.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const jobs = [];

  for (const match of matches) {
    const raw = String(match?.[1] || "").trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(decodeHtmlEntities(raw));
      collectICimsStructuredJobs(parsed, requestUrl, jobs);
    } catch {
      // ignore malformed JSON-LD
    }
  }

  return jobs;
}

function extractICimsStructuredJobsFromEmbeddedState(sourceHtml, requestUrl) {
  const source = String(sourceHtml || "");
  const matches = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  const jobs = [];
  const seenRawJobs = new Set();

  for (const match of matches) {
    const body = String(match?.[1] || "");
    if (!body || !/(jobposting|jobtitle|employment_type|jobid|searchresults)/i.test(body)) {
      continue;
    }

    const objectMatches = [
      ...body.matchAll(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/gi),
      ...body.matchAll(/window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?});/gi),
      ...body.matchAll(/window\._jibe(?:\.[A-Za-z0-9_]+)?\s*=\s*({[\s\S]*?});/gi),
    ];

    for (const objectMatch of objectMatches) {
      const rawObject = String(objectMatch?.[1] || "").trim();
      if (!rawObject || seenRawJobs.has(rawObject)) {
        continue;
      }
      seenRawJobs.add(rawObject);
      try {
        const parsed = JSON.parse(rawObject);
        collectICimsStructuredJobs(parsed, requestUrl, jobs);
      } catch {
        // ignore invalid embedded state blocks
      }
    }
  }

  return jobs;
}

function collectICimsStructuredJobs(value, requestUrl, jobs, seen = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectICimsStructuredJobs(item, requestUrl, jobs, seen);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const type = String(value["@type"] || "").toLowerCase();
  const title = safeText(
    value.title
      || value.jobTitle
      || value.name
      || value.positionTitle,
    220
  );
  const applyUrl = absoluteUrl(
    value.applyUrl
      || value.portalUrl
      || value.url
      || value.jobUrl
      || value.canonicalUrl,
    requestUrl
  );

  if (
    (type === "jobposting" || /job/i.test(type) || title)
    && applyUrl
    && title
    && !applyUrl.toLowerCase().includes("/jobs/intro")
    && !applyUrl.toLowerCase().includes("/jobs/login")
  ) {
    const dedupeKey = `${title.toLowerCase()}|${applyUrl.toLowerCase()}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      const locationLabel = buildICimsStructuredLocationLabel(value);
      jobs.push({
        id: value.id || value.jobId || value.reqId || applyUrl,
        title,
        applyUrl,
        locationLabel,
        rawLocationText: locationLabel || null,
        postedAt: value.datePosted || value.postedAt || value.updatedAt || value.publishedAt || null,
        employmentType: value.employmentType || value.jobType || value.type || null,
        department: value.department || value.category || null,
        descriptionSnippet: safeText(
          value.description
            || value.summary
            || value.snippet
            || value.teaser,
          220
        ),
        city: String(value.city || value.locationCity || value.addressLocality || "").trim() || null,
        region: String(value.region || value.state || value.addressRegion || "").trim() || null,
        country: String(value.country || value.addressCountry || "").trim() || null,
      });
    }
  }

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      collectICimsStructuredJobs(nested, requestUrl, jobs, seen);
    } else if (nested && typeof nested === "object") {
      collectICimsStructuredJobs(nested, requestUrl, jobs, seen);
    }
  }
}

function buildICimsJobsFromStructuredEntries(source, entries, requestUrl) {
  return (Array.isArray(entries) ? entries : []).map((entry, index) => {
    const locationLabel = String(entry.locationLabel || "").trim() || "Unspecified";
    return buildNormalizedJob(source, {
      id: entry.id || entry.applyUrl || `${source.key}-${index}`,
      company: source.company,
      title: entry.title || deriveTitleFromUrl(entry.applyUrl) || `iCIMS job ${index + 1}`,
      department: entry.department || null,
      employmentType: entry.employmentType || null,
      locationLabel,
      postedAt: entry.postedAt || null,
      rawLocationText: entry.rawLocationText || locationLabel,
      applyUrl: absoluteUrl(entry.applyUrl, requestUrl),
      descriptionSnippet: entry.descriptionSnippet || null,
      city: entry.city || null,
      region: entry.region || null,
      country: entry.country || null,
    });
  }).filter((job) => job?.applyUrl);
}

function buildICimsStructuredLocationLabel(value) {
  const address = value?.jobLocation?.address || value?.address || {};
  const parts = [
    value.locationLabel,
    value.location,
    value.locationName,
    value.jobLocationName,
    address.addressLocality,
    address.addressRegion,
    address.addressCountry,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return parts.length > 0 ? [...new Set(parts)].join(", ") : "";
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

async function enrichICimsDescriptions(jobs) {
  await mapWithConcurrency(jobs, ICIMS_DETAIL_CONCURRENCY, async (job) => {
    if (!job?.applyUrl) {
      return job;
    }

    const fallback = await fetchDescriptionFallback(job.applyUrl);
    let detailHtml = "";
    if (fallback.descriptionSnippet || fallback.searchText) {
      job.descriptionSnippet = fallback.descriptionSnippet || job.descriptionSnippet || null;
      job.searchText = fallback.searchText || fallback.descriptionSnippet || job.searchText || null;
    }
    if (!job.postedAt && fallback.postedAt) {
      job.postedAt = fallback.postedAt;
    }
    if (!job.applicationDeadlineAt && fallback.applicationDeadlineAt) {
      job.applicationDeadlineAt = fallback.applicationDeadlineAt;
    }
    if (!job.compensation && fallback.compensation) {
      job.compensation = fallback.compensation;
    }
    if ((!job.workArrangement || job.workArrangement === "unknown") && fallback.workArrangement) {
      job.workArrangement = fallback.workArrangement;
    }
    if (shouldReplaceExternalId(job.externalId, fallback.jobId)) {
      job.externalId = fallback.jobId;
    }

    const needsDetailMetadata = !job.postedAt
      || !job.country
      || !job.city
      || !job.region
      || isPollutedICimsLocation(job.locationLabel)
      || String(job.locationLabel || "").trim().toLowerCase() === "unspecified";

    if (needsDetailMetadata) {
      detailHtml = await fetchText(job.applyUrl).catch(() => "");
      const detailMetadata = extractICimsDetailMetadata(detailHtml);
      if (!job.postedAt && detailMetadata.postedAt) {
        job.postedAt = detailMetadata.postedAt;
      }
      if ((!job.locationLabel || job.locationLabel === "Unspecified" || isPollutedICimsLocation(job.locationLabel))
        && detailMetadata.locationLabel) {
        job.locationLabel = detailMetadata.locationLabel;
      }
      if ((!job.rawLocationText || job.rawLocationText === "Unspecified") && detailMetadata.rawLocationText) {
        job.rawLocationText = detailMetadata.rawLocationText;
      }
      if (!job.country && detailMetadata.country) {
        job.country = detailMetadata.country;
      }
      if (!job.city && detailMetadata.city) {
        job.city = detailMetadata.city;
      }
      if (!job.region && detailMetadata.region) {
        job.region = detailMetadata.region;
      }
    }

    const derivedLocation = deriveLocationMetadata({
      title: job.title,
      applyUrl: job.applyUrl,
      locationLabel: job.locationLabel,
      rawLocationText: [job.rawLocationText, fallback.searchText, fallback.descriptionSnippet].filter(Boolean).join(" | "),
      searchText: fallback.searchText,
      descriptionSnippet: fallback.descriptionSnippet,
    });
    if (
      (!job.locationLabel || job.locationLabel === "Unspecified" || !job.country || !job.city || !job.region)
      && derivedLocation.locationLabel
    ) {
      job.locationLabel = job.locationLabel && job.locationLabel !== "Unspecified"
        ? job.locationLabel
        : (derivedLocation.locationLabel || job.locationLabel);
      job.city = job.city || derivedLocation.city || null;
      job.region = job.region || derivedLocation.region || null;
      job.country = job.country || derivedLocation.country || null;
      job.rawLocationText = derivedLocation.rawLocationText || job.rawLocationText || null;
    }

    return job;
  });
}

function prioritizeICimsDetailJobs(jobs, keyword) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return [];
  }

  if (keyword) {
    return jobs;
  }

  return [...jobs]
    .sort((left, right) => {
      const leftNeedsMetadata = needsICimsDetailEnrichment(left) ? 1 : 0;
      const rightNeedsMetadata = needsICimsDetailEnrichment(right) ? 1 : 0;
      if (leftNeedsMetadata !== rightNeedsMetadata) {
        return rightNeedsMetadata - leftNeedsMetadata;
      }
      const leftKeywordPriority = hasICimsDetailKeywordPriority(left) ? 1 : 0;
      const rightKeywordPriority = hasICimsDetailKeywordPriority(right) ? 1 : 0;
      if (leftKeywordPriority !== rightKeywordPriority) {
        return rightKeywordPriority - leftKeywordPriority;
      }
      return String(left?.title || "").localeCompare(String(right?.title || ""));
    })
    .slice(0, ICIMS_DETAIL_MAX_JOBS);
}

function hasICimsDetailKeywordPriority(job) {
  return /\b(product manager|product owner|product\s*(?:&|and)\s*operations|product operations|product lead)\b/i.test(String(job?.title || ""));
}

function needsICimsDetailEnrichment(job) {
  if (!job) {
    return false;
  }
  return (
    !job.postedAt
    || !job.country
    || !job.city
    || String(job.locationLabel || "").trim().toLowerCase() === "unspecified"
    || isPollutedICimsLocation(job.locationLabel)
    || !job.descriptionSnippet
  );
}

function extractICimsDetailMetadata(html) {
  const source = String(html || "");
  if (!source) {
    return buildEmptyICimsDetailMetadata();
  }

  const jsonLdMatches = [...source.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of jsonLdMatches) {
    try {
      const parsed = JSON.parse(decodeHtmlEntities(match[1] || "").trim());
      const structuredJobs = collectICimsDetailJsonLdJobs(parsed);
      for (const entry of structuredJobs) {
        const locations = collectICimsJsonLdLocations(entry);
        const locationMetadata = buildICimsDetailLocationMetadata(locations);
        if (!locationMetadata.locationLabel && !locationMetadata.rawLocationText) {
          continue;
        }
        return {
          postedAt: extractPostedDateFromHtml(source) || String(entry.datePosted || "").trim() || null,
          locationLabel: locationMetadata.locationLabel,
          rawLocationText: locationMetadata.rawLocationText,
          city: locationMetadata.city,
          region: locationMetadata.region,
          country: locationMetadata.country,
        };
      }
    } catch {
      // ignore invalid JSON-LD blocks
    }
  }

  return {
    postedAt: extractPostedDateFromHtml(source),
    locationLabel: null,
    rawLocationText: null,
    city: null,
    region: null,
    country: null,
  };
}

function buildEmptyICimsDetailMetadata() {
  return {
    postedAt: null,
    locationLabel: null,
    rawLocationText: null,
    city: null,
    region: null,
    country: null,
  };
}

function collectICimsDetailJsonLdJobs(value, jobs = [], seen = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectICimsDetailJsonLdJobs(item, jobs, seen);
    }
    return jobs;
  }

  if (!value || typeof value !== "object" || seen.has(value)) {
    return jobs;
  }
  seen.add(value);

  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some((type) => String(type || "").toLowerCase() === "jobposting")) {
    jobs.push(value);
  }

  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      collectICimsDetailJsonLdJobs(nested, jobs, seen);
    }
  }

  return jobs;
}

function collectICimsJsonLdLocations(entry) {
  const rawLocations = Array.isArray(entry?.jobLocation)
    ? entry.jobLocation
    : entry?.jobLocation
      ? [entry.jobLocation]
      : [];

  return rawLocations
    .map(normalizeICimsJsonLdLocation)
    .filter(Boolean);
}

function normalizeICimsJsonLdLocation(location) {
  if (!location || typeof location !== "object") {
    return null;
  }

  const address = location.address && typeof location.address === "object"
    ? location.address
    : location;
  const city = normalizeICimsAddressValue(address.addressLocality);
  const region = normalizeICimsAddressValue(address.addressRegion);
  const country = normalizeICimsCountryValue(address.addressCountry);
  const name = normalizeICimsAddressValue(location.name);
  const streetAddress = normalizeICimsAddressValue(address.streetAddress);

  if (![city, region, country, name, streetAddress].some(Boolean)) {
    return null;
  }

  return {
    name,
    city,
    region,
    country,
    streetAddress,
  };
}

function buildICimsDetailLocationMetadata(locations) {
  const normalizedLocations = (Array.isArray(locations) ? locations : [])
    .map((location) => ({
      city: location.city || null,
      region: location.region || null,
      country: location.country || null,
      label: [location.city, location.region, location.country].filter(Boolean).join(", ")
        || [location.name, location.country].filter(Boolean).join(", ")
        || location.country
        || location.name
        || null,
    }))
    .filter((location) => location.label || location.country);

  if (normalizedLocations.length === 0) {
    return {
      locationLabel: null,
      rawLocationText: null,
      city: null,
      region: null,
      country: null,
    };
  }

  const rawLocationText = [...new Set(normalizedLocations.map((location) => location.label).filter(Boolean))]
    .join(" | ");
  const usLocation = normalizedLocations.find((location) => location.country === "US");
  if (usLocation) {
    return {
      locationLabel: usLocation.label || "United States",
      rawLocationText,
      city: usLocation.city,
      region: usLocation.region,
      country: "US",
    };
  }

  const countries = new Set(normalizedLocations.map((location) => location.country).filter(Boolean));
  const first = normalizedLocations[0] || {};
  return {
    locationLabel: first.label || rawLocationText || null,
    rawLocationText,
    city: first.city || null,
    region: first.region || null,
    country: countries.size > 0 ? [...countries][0] : null,
  };
}

function normalizeICimsAddressValue(value) {
  const normalized = safeText(value, 160);
  if (!normalized || /^(unavailable|null|undefined|n\/a|na)$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeICimsCountryValue(value) {
  const normalized = normalizeICimsAddressValue(value);
  if (!normalized) {
    return null;
  }

  const aliases = new Map([
    ["US", "US"],
    ["USA", "US"],
    ["UNITED STATES", "US"],
    ["UNITED STATES OF AMERICA", "US"],
    ["BR", "Brazil"],
    ["BRA", "Brazil"],
    ["BRAZIL", "Brazil"],
    ["CO", "Colombia"],
    ["COL", "Colombia"],
    ["COLOMBIA", "Colombia"],
    ["MX", "Mexico"],
    ["MEX", "Mexico"],
    ["MEXICO", "Mexico"],
  ]);

  return aliases.get(normalized.toUpperCase()) || normalized;
}

function isPollutedICimsLocation(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }

  return text.length > 180
    || /\b(?:overview|responsibilities|requirements|please enable cookies|welcome page|returning candidate|full time|permanent location)\b/i.test(text);
}

function shouldReplaceExternalId(currentValue, nextValue) {
  const current = String(currentValue || "").trim();
  const next = String(nextValue || "").trim();
  if (!next) {
    return false;
  }
  if (!current || /^https?:/i.test(current)) {
    return true;
  }
  if (current === next) {
    return false;
  }
  if (/^\d{4,}$/.test(current) && /^[A-Za-z]+-\d+(?:-\d+)?$/i.test(next)) {
    return true;
  }
  if (/^\d{4,}$/.test(current) && /^\d{4,}-\d{4,}$/.test(next)) {
    return true;
  }
  if (current.length < next.length && next.includes(current)) {
    return true;
  }
  return false;
}
