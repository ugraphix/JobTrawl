import {
  buildNormalizedJob,
  fetchText,
  fetchJson,
  extractJsonLdJobPostings,
  extractPreloadStateJobs,
  extractPhenomDdoJobs,
  absoluteUrl,
  safeText,
  deriveTitleFromUrl,
  extractPostedDateFromHtml,
  mapWithConcurrency,
  cleanText,
} from "./shared.js";

export async function fetchHostedBoardJobs(source, filters = {}) {
  if (source.htmlListStrategy === "jibe-json-api-jobs") {
    const jibeJobs = await fetchJibeJsonApiJobs(source, filters);
    if (jibeJobs.length > 0) {
      return enrichMissingPostedDates(jibeJobs);
    }
  }

  if (source.jobSitemapUrl) {
    const sitemapJobs = await fetchSitemapJobs(source);
    if (sitemapJobs.length > 0) {
      return enrichMissingPostedDates(sitemapJobs);
    }
  }

  if (source.htmlListStrategy === "govjobs-ajax-results") {
    const govJobs = await fetchGovJobsAjaxResults(source, filters);
    if (govJobs.length > 0) {
      return enrichMissingPostedDates(govJobs);
    }
  }

  if (source.htmlListStrategy === "adp-public-job-requisitions") {
    const adpJobs = await fetchAdpPublicJobRequisitions(source, filters);
    if (adpJobs.length > 0) {
      return enrichMissingPostedDates(adpJobs);
    }
  }

  if (source.htmlListStrategy === "saashr-rest-job-requisitions") {
    const saashrJobs = await fetchSaaShrRestJobRequisitions(source, filters);
    if (saashrJobs.length > 0) {
      return enrichMissingPostedDates(saashrJobs);
    }
  }

  const requestUrl = resolveCareersUrl(source, filters);

  if (!requestUrl) {
    throw new Error("This provider requires careersUrl");
  }

  const html = await fetchText(requestUrl);
  const structuredHtmlJobs = extractStructuredHtmlJobs(source, html, requestUrl);
  if (structuredHtmlJobs.length > 0) {
    return enrichMissingPostedDates(structuredHtmlJobs);
  }

  const jobs = extractJsonLdJobPostings(html);
  const preloadJobs = extractPreloadStateJobs(html);
  const phenomJobs = extractPhenomDdoJobs(html);

  if (jobs.length > 0) {
    const normalizedJobs = jobs.map((job, index) => {
      const address = job.jobLocation?.address || job.jobLocation?.[0]?.address || {};
      const locationLabel = [
        address.addressLocality,
        address.addressRegion,
        address.addressCountry,
      ].filter(Boolean).join(", ") || job.jobLocationType || "Unspecified";

      return buildNormalizedJob(source, {
        id: job.identifier?.value || job.identifier || job.url || `${source.key}-${index}`,
        company: job.hiringOrganization?.name || source.company,
        title: job.title,
        department: job.industry || null,
        locationLabel,
        city: address.addressLocality || null,
        region: address.addressRegion || null,
        country: address.addressCountry || null,
        postedAt: job.datePosted || job.validThrough,
        applyUrl: absoluteUrl(job.url, requestUrl) || requestUrl,
        descriptionSnippet: safeText(job.description),
        searchText: cleanText(job.description),
        employmentType: Array.isArray(job.employmentType) ? job.employmentType.join(", ") : job.employmentType,
        rawLocationText: locationLabel,
        workArrangement: job.jobLocationType?.toLowerCase().includes("telecommute") ? "remote" : null,
      });
    });

    return enrichMissingPostedDates(normalizedJobs);
  }

  if (preloadJobs.length > 0) {
    const normalizedJobs = preloadJobs.map((job, index) => {
      const location = job.locations?.[0] || {};
      const postedField = job.customFields?.find((field) => field?.cfKey === "cf_start_date")?.value || null;
      const teamField = job.customFields?.find((field) => field?.cfKey === "cf_career_site_sub_category")?.value
        || job.customFields?.find((field) => field?.cfKey === "cf_job_family")?.value
        || null;
      const workArrangementField = job.customFields?.find((field) => field?.cfKey === "cf_remote_type")?.value
        || job.customFields?.find((field) => field?.cfKey === "cf_remote")?.value
        || null;
      const compensationField = job.customFields?.find((field) => field?.cfKey === "cf_salary")?.value
        || job.customFields?.find((field) => field?.cfKey === "cf_salary_range")?.value
        || null;

      return buildNormalizedJob(source, {
        id: job.reference || job.requisitionID || job.uniqueID || job.applyURL || `${source.key}-${index}`,
        company: source.company,
        title: job.title,
        team: teamField,
        locationLabel: location.locationText || location.locationName || location.cityStateAbbr || "Unspecified",
        city: location.city || null,
        region: location.stateAbbr || location.state || null,
        country: location.countryAbbr || location.country || null,
        postedAt: postedField,
        applyUrl: absoluteUrl(job.applyURL || job.originalURL, requestUrl) || requestUrl,
        descriptionSnippet: null,
        employmentType: Array.isArray(job.employmentType) ? job.employmentType.join(", ") : null,
        compensation: compensationField,
        rawLocationText: location.locationParsedText || location.locationText || location.locationName || null,
        workArrangement: workArrangementField,
      });
    });

    return enrichMissingPostedDates(normalizedJobs);
  }

  if (phenomJobs.length > 0) {
    const normalizedJobs = phenomJobs.map((job, index) => {
      const locationLabel = job.location
        || (Array.isArray(job.multi_location) ? job.multi_location.join(" | ") : null)
        || job.cityStateCountry
        || "Unspecified";

      return buildNormalizedJob(source, {
        id: job.jobId || job.reqId || job.jobSeqNo || `${source.key}-${index}`,
        company: source.company,
        title: job.title,
        team: job.department || job.category || null,
        department: job.category || null,
        locationLabel,
        city: job.city || null,
        region: job.state || null,
        country: job.country || null,
        postedAt: job.postedDate || job.dateCreated || null,
        applyUrl: absoluteUrl(job.applyUrl, requestUrl) || requestUrl,
        descriptionSnippet: safeText(job.descriptionTeaser || job.descriptionTeaser_first200 || job.descriptionTeaser_ats),
        searchText: cleanText(job.description || job.descriptionTeaser || job.descriptionTeaser_first200 || job.descriptionTeaser_ats),
        employmentType: job.type || null,
        rawLocationText: locationLabel,
      });
    });

    return enrichMissingPostedDates(normalizedJobs);
  }

  if (source.disableAnchorFallback) {
    return [];
  }

  return enrichMissingPostedDates(extractAnchorJobs(source, html, requestUrl));
}

async function fetchSitemapJobs(source) {
  const xml = await fetchText(source.jobSitemapUrl, {
    accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
  });
  const entries = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?[\s\S]*?<\/url>/gi)];
  const jobs = entries
    .map((match, index) => buildSitemapJob(source, match[1], match[2], index))
    .filter(Boolean);

  const deduped = new Map();
  for (const job of jobs) {
    if (!deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

function buildSitemapJob(source, url, lastmod, index) {
  const applyUrl = absoluteUrl(url, source.jobSitemapUrl || source.careersUrl);
  if (!applyUrl) {
    return null;
  }

  if (!matchesSitemapUrl(source, applyUrl)) {
    return null;
  }

  const parsed = parseSitemapJobUrl(applyUrl, source);
  const title = parsed?.title || deriveTitleFromUrl(applyUrl);

  if (!looksLikeJobTitle(title) || isExcludedJobLink(title, applyUrl)) {
    return null;
  }

  const locationLabel = parsed?.locationLabel || "Unspecified";

  return buildNormalizedJob(source, {
    id: applyUrl || `${source.key}-sitemap-${index}`,
    company: source.company,
    title,
    locationLabel,
    city: parsed?.city || null,
    region: parsed?.region || null,
    country: parsed?.country || null,
    postedAt: lastmod || null,
    applyUrl,
    rawLocationText: locationLabel,
  });
}

function parseSitemapJobUrl(url, source) {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);

    if (source?.sitemapFormat === "phenom-job-id-title" && segments.length >= 5 && segments[2] === "job") {
      return {
        title: slugToTitle(segments[4]),
        locationLabel: "Unspecified",
      };
    }

    if (source?.sitemapFormat === "job-title-location" && segments[0] === "job" && segments.length >= 3) {
      return {
        title: slugToTitle(segments[1]),
        ...parseLocationSlug(segments[2]),
      };
    }

    if (source?.sitemapFormat === "job-location-title" && segments[0] === "job" && segments.length >= 3) {
      return {
        title: slugToTitle(segments[2]),
        ...parseLocationSlug(segments[1]),
      };
    }

    if (segments.length < 3) {
      return null;
    }

    const [locationSlug, titleSlug] = segments;
    const location = parseLocationSlug(locationSlug);

    return {
      title: slugToTitle(titleSlug),
      ...location,
    };
  } catch {
    return null;
  }
}

function slugToTitle(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function matchesSitemapUrl(source, applyUrl) {
  const urlValue = String(applyUrl || "").toLowerCase();

  if (source.sitemapJobPathPattern && !urlValue.includes(String(source.sitemapJobPathPattern).toLowerCase())) {
    return false;
  }

  const allowedLocationSlugs = Array.isArray(source.sitemapAllowedLocationSlugs)
    ? source.sitemapAllowedLocationSlugs
    : [];

  if (allowedLocationSlugs.length === 0) {
    return true;
  }

  try {
    const segments = new URL(applyUrl).pathname.split("/").filter(Boolean);
    const locationSegmentIndex = source.sitemapFormat === "job-title-location"
      ? 2
      : source.sitemapFormat === "job-location-title"
        ? 1
        : 0;
    const locationSlug = String(segments[locationSegmentIndex] || "").toLowerCase();
    return allowedLocationSlugs.some((allowed) => locationSlug === String(allowed).toLowerCase());
  } catch {
    return false;
  }
}

function parseLocationSlug(slug) {
  const parts = String(slug || "").split("-").filter(Boolean);
  if (parts.length < 2) {
    return { locationLabel: "Unspecified" };
  }

  const regionPart = parts[parts.length - 1];
  const cityParts = parts.slice(0, -1);
  const city = cityParts.map(capitalizeWord).join(" ");
  const region = regionPart.toUpperCase();
  const looksLikeStateCode = /^[A-Z]{2}$/.test(region);

  return {
    locationLabel: looksLikeStateCode ? `${city}, ${region}` : parts.map(capitalizeWord).join(" "),
    city: city || null,
    region: looksLikeStateCode ? region : null,
    country: looksLikeStateCode ? "US" : null,
  };
}

function capitalizeWord(value) {
  const word = String(value || "");
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

function extractAnchorJobs(source, html, requestUrl) {
  const matches = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const jobs = [];

  for (const match of matches) {
    const href = match[1];
    const text = safeText(match[2], 120);

    if (!text || text.length < 4) {
      continue;
    }

    if (!looksLikeJobLink(source.provider, href)) {
      continue;
    }

    if (!looksLikeJobTitle(text) || isExcludedJobLink(text, href)) {
      continue;
    }

    jobs.push(
      buildNormalizedJob(source, {
        id: href,
        company: source.company,
        title: text,
        locationLabel: "Unspecified",
        applyUrl: absoluteUrl(href, requestUrl || source.careersUrl),
        descriptionSnippet: null,
      })
    );
  }

  const deduped = new Map();
  for (const job of jobs) {
    if (!deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

function extractStructuredHtmlJobs(source, html, requestUrl) {
  if (source.htmlListStrategy === "ultipro-joboptions") {
    return extractUltiProJobOptions(source, html, requestUrl);
  }

  if (source.provider === "jobvite") {
    return extractJobviteJobList(source, html, requestUrl);
  }

  if (source.htmlListStrategy === "icims-search-results") {
    return extractICimsSearchResults(source, html, requestUrl);
  }

  if (source.htmlTableStrategy === "smartsheet-careers-table") {
    return extractSmartsheetTableJobs(source, html, requestUrl);
  }

  if (source.htmlListStrategy === "talentbrew-search-results") {
    return extractTalentBrewJobs(source, html, requestUrl);
  }

  return [];
}

async function fetchAdpPublicJobRequisitions(source, filters) {
  const config = getAdpPublicSourceConfig(source);

  if (!config.cid || !config.ccId) {
    return [];
  }

  const clientId = await fetchAdpClientId(config);
  if (!clientId) {
    return [];
  }

  const pageSize = 20;
  const jobs = [];
  let skip = 0;
  let totalNumber = null;

  while (totalNumber === null || skip < totalNumber) {
    const requestUrl = buildAdpPublicApiUrl(config, "/v1/job-requisitions", {
      locale: config.locale,
      "$top": String(pageSize),
      "$skip": String(skip),
      userQuery: String(filters?.keyword || "").trim() || undefined,
    }, clientId);

    const payload = await fetchJson(requestUrl);
    const requisitions = Array.isArray(payload?.jobRequisitions) ? payload.jobRequisitions : [];

    if (requisitions.length === 0) {
      break;
    }

    totalNumber = Number(payload?.meta?.totalNumber) || totalNumber || 0;

    jobs.push(...requisitions.map((job, index) => buildAdpNormalizedJob(source, job, config, skip + index)));

    skip += requisitions.length;

    if (totalNumber !== null && skip >= totalNumber) {
      break;
    }
  }

  const deduped = new Map();
  for (const job of jobs) {
    if (job?.applyUrl && !deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

async function fetchSaaShrRestJobRequisitions(source, filters) {
  const config = getSaaShrSourceConfig(source);
  const pageSize = 20;
  const jobs = [];
  let page = 1;
  let total = null;

  while (total === null || jobs.length < total) {
    const requestUrl = buildSaaShrRestUrl(config, "/job-requisitions", {
      offset: String(page),
      size: String(pageSize),
      sort: "desc",
      ein_id: config.einId || "",
      lang: config.lang,
      keywords: String(filters?.keyword || "").trim() || undefined,
    });
    const payload = await fetchJson(requestUrl);
    const requisitions = Array.isArray(payload?.job_requisitions) ? payload.job_requisitions : [];

    if (requisitions.length === 0) {
      break;
    }

    total = Number(payload?._paging?.total) || total || 0;
    jobs.push(...requisitions.map((job, index) => buildSaaShrNormalizedJob(source, job, config, (page - 1) * pageSize + index)));

    if (jobs.length >= total) {
      break;
    }

    page += 1;
  }

  const deduped = new Map();
  for (const job of jobs) {
    if (job?.applyUrl && !deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

async function fetchJibeJsonApiJobs(source, filters) {
  const endpoint = source.jsonApiUrl || new URL("/api/jobs", source.careersUrl).toString();
  const pageSize = Number(source.jsonApiLimit || 100);
  const jobs = [];
  let page = 1;
  let totalCount = null;

  while (totalCount === null || jobs.length < totalCount) {
    const requestUrl = new URL(endpoint);
    requestUrl.searchParams.set("page", String(page));
    requestUrl.searchParams.set("limit", String(pageSize));

    const keyword = String(filters?.keyword || "").trim();
    if (keyword) {
      requestUrl.searchParams.set("keywords", keyword);
    }

    const payload = await fetchJson(requestUrl);
    const pageJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    totalCount = Number(payload?.totalCount || payload?.count || totalCount || 0);

    if (pageJobs.length === 0) {
      break;
    }

    jobs.push(...pageJobs.map((job, index) => buildJibeJsonApiJob(source, job, (page - 1) * pageSize + index)));

    if (pageJobs.length < pageSize) {
      break;
    }

    page += 1;
  }

  const deduped = new Map();
  for (const job of jobs) {
    if (job?.applyUrl && !deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

function getAdpPublicSourceConfig(source) {
  const careersUrl = new URL(source.careersUrl);
  return {
    careersUrl: source.careersUrl,
    origin: careersUrl.origin,
    cid: source.adpCid || careersUrl.searchParams.get("cid") || "",
    ccId: source.adpCcId || careersUrl.searchParams.get("ccId") || "",
    locale: source.adpLocale || careersUrl.searchParams.get("lang") || careersUrl.searchParams.get("locale") || "en_US",
    selectedMenuKey: careersUrl.searchParams.get("selectedMenuKey") || "CareerCenter",
  };
}

function getSaaShrSourceConfig(source) {
  const careersUrl = new URL(source.careersUrl);
  return {
    origin: careersUrl.origin,
    companyId: source.saashrCompanyId || deriveSaaShrCompanyId(careersUrl.pathname),
    lang: source.saashrLang || careersUrl.searchParams.get("lang") || "en-US",
    einId: source.saashrEinId || careersUrl.searchParams.get("ein_id") || "",
  };
}

async function fetchAdpClientId(config) {
  const requestUrl = buildAdpPublicApiUrl(config, "/client-features", {
    locale: config.locale,
  });
  const payload = await fetchJson(requestUrl);
  const fields = payload?.meta?.customFieldGroup?.stringFields || [];
  const clientIdField = fields.find((field) => field?.nameCode?.codeValue === "ClientID");
  return clientIdField?.stringValue || null;
}

function buildAdpPublicApiUrl(config, pathName, params = {}, clientId = null) {
  const url = new URL(`/mascsr/default/careercenter/public/events/staffing${pathName}`, config.origin);
  url.searchParams.set("cid", config.cid);
  if (clientId) {
    url.searchParams.set("clientId", clientId);
  }
  url.searchParams.set("timeStamp", Date.now().toString());
  if (config.ccId) {
    url.searchParams.set("ccId", config.ccId);
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function buildSaaShrRestUrl(config, pathName, params = {}) {
  const url = new URL(`/ta/rest/ui/recruitment/companies/%7C${config.companyId}${pathName}`, config.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function buildAdpNormalizedJob(source, job, config, index) {
  const externalJobId = getAdpStringField(job, "ExternalJobID") || job.clientRequisitionID || job.itemID || `${source.key}-${index}`;
  const salaryRange = getAdpStringField(job, "SalaryRange");
  const department = getAdpStringField(job, "HomeDepartment") || getAdpStringField(job, "JobClass") || null;
  const location = job?.requisitionLocations?.[0];
  const locationLabel = location?.nameCode?.shortName || buildAdpLocationLabel(location) || "Unspecified";
  const city = location?.address?.cityName || null;
  const region = location?.address?.countrySubdivisionLevel1?.codeValue || null;
  const applyUrl = buildAdpApplyUrl(config, externalJobId);

  return buildNormalizedJob(source, {
    id: job.itemID || externalJobId,
    company: source.company,
    title: job.requisitionTitle,
    department,
    locationLabel,
    city,
    region,
    country: "US",
    postedAt: job.postDate || getAdpDateField(job, "PostingDate"),
    applyUrl,
    descriptionSnippet: safeText(job.requisitionDescription),
    searchText: cleanText(job.requisitionDescription),
    employmentType: job?.workLevelCode?.shortName || null,
    compensation: salaryRange,
    rawLocationText: locationLabel,
  });
}

function buildSaaShrNormalizedJob(source, job, config, index) {
  const locationLabel = buildSaaShrLocationLabel(job.location);
  const city = job?.location?.city || null;
  const region = job?.location?.state || null;
  const compensation = buildSaaShrCompensation(job);

  return buildNormalizedJob(source, {
    id: job.id || `${source.key}-${index}`,
    company: source.company,
    title: job.job_title,
    locationLabel,
    city,
    region,
    country: job?.location?.country || null,
    applyUrl: buildSaaShrJobUrl(config, job.id),
    descriptionSnippet: safeText(job.job_description),
    searchText: cleanText(job.job_description),
    employmentType: job?.employee_type?.name || null,
    compensation,
    rawLocationText: locationLabel,
    workArrangement: job?.is_remote_job ? "remote" : null,
  });
}

function buildJibeJsonApiJob(source, jobWrapper, index) {
  const job = jobWrapper?.data || jobWrapper || {};
  const categoryNames = Array.isArray(job.categories)
    ? job.categories.map((category) => safeText(category?.name, 120)).filter(Boolean)
    : [];
  const locationLabel = job.full_location
    || job.short_location
    || [job.city, job.state, job.country].filter(Boolean).join(", ")
    || job.location_name
    || "Unspecified";
  const compensation = [job.tags2?.[0], job.tags3?.[0]].filter(Boolean).join(" - ") || null;
  const applyUrl = job.meta_data?.canonical_url
    || job.apply_url
    || absoluteUrl(`/jobs/${job.slug || job.req_id}`, source.careersUrl);

  return buildNormalizedJob(source, {
    id: job.req_id || job.slug || `${source.key}-${index}`,
    company: job.hiring_organization || source.company,
    title: job.title,
    team: categoryNames[0] || null,
    department: categoryNames[0] || null,
    locationLabel,
    city: job.city || null,
    region: job.state || null,
    country: job.country_code || job.country || null,
    postedAt: job.posted_date || job.update_date || null,
    applyUrl,
    descriptionSnippet: safeText(job.description),
    searchText: cleanText([
      job.description,
      job.qualifications,
      job.responsibilities,
      ...categoryNames,
    ].filter(Boolean).join(" ")),
    employmentType: job.employment_type || null,
    compensation,
    rawLocationText: locationLabel,
    coordinates: Number.isFinite(Number(job.latitude)) && Number.isFinite(Number(job.longitude))
      ? { latitude: Number(job.latitude), longitude: Number(job.longitude) }
      : null,
    workArrangement: job.tags5?.[0] === "Yes" || /remote/i.test(locationLabel) ? "remote" : null,
  });
}

function buildAdpApplyUrl(config, externalJobId) {
  const url = new URL('/mascsr/default/mdf/recruitment/recruitment.html', config.origin);
  url.searchParams.set('cid', config.cid);
  if (config.ccId) {
    url.searchParams.set('ccId', config.ccId);
  }
  url.searchParams.set('selectedMenuKey', config.selectedMenuKey || 'CareerCenter');
  url.searchParams.set('jobId', externalJobId);
  url.searchParams.set('lang', config.locale);
  return url.toString();
}

function buildSaaShrJobUrl(config, jobId) {
  const url = new URL(`/ta/${config.companyId}.careers`, config.origin);
  url.searchParams.set("ShowJob", String(jobId));
  url.searchParams.set("lang", config.lang);
  return url.toString();
}

function getAdpStringField(job, codeValue) {
  return job?.customFieldGroup?.stringFields?.find((field) => field?.nameCode?.codeValue === codeValue)?.stringValue || null;
}

function getAdpDateField(job, codeValue) {
  return job?.customFieldGroup?.dateFields?.find((field) => field?.nameCode?.codeValue === codeValue)?.dateValue || null;
}

function deriveSaaShrCompanyId(pathname) {
  const match = String(pathname || "").match(/\/ta\/([^./]+)\.(?:careers|jobs)/i);
  return match?.[1] || null;
}

function buildAdpLocationLabel(location) {
  if (!location?.address) {
    return null;
  }

  return [
    location.address.cityName,
    location.address.countrySubdivisionLevel1?.codeValue,
    location.address.countryCode?.codeValue,
  ].filter(Boolean).join(', ');
}

function buildSaaShrLocationLabel(location) {
  if (!location) {
    return "Unspecified";
  }

  return [
    location.city,
    location.state,
  ].filter(Boolean).join(", ") || location.address_line_1 || "Unspecified";
}

function buildSaaShrCompensation(job) {
  const from = Number(job?.base_pay_from);
  const to = Number(job?.base_pay_to);
  const frequency = String(job?.base_pay_frequency || "").trim();
  if (!Number.isFinite(from) && !Number.isFinite(to)) {
    return null;
  }

  const pieces = [];
  if (Number.isFinite(from)) {
    pieces.push(`$${from.toLocaleString("en-US", { minimumFractionDigits: from % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);
  }
  if (Number.isFinite(to)) {
    pieces.push(`$${to.toLocaleString("en-US", { minimumFractionDigits: to % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);
  }

  return `${pieces.join(" - ")}${frequency ? ` / ${frequency}` : ""}`;
}

function extractJobviteJobList(source, html, requestUrl) {
  const matches = [...html.matchAll(/<li class=["']row["'][^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi)];
  const jobs = [];

  for (const match of matches) {
    const href = match[1];
    const cardHtml = match[2];
    const titleMatch = cardHtml.match(/<div class=["']jv-job-list-name["'][^>]*>([\s\S]*?)<\/div>/i);
    const locationMatch = cardHtml.match(/<div class=["']jv-job-list-location["'][^>]*>([\s\S]*?)<\/div>/i);
    const title = safeText(titleMatch?.[1], 220);

    if (!looksLikeJobTitle(title) || isExcludedJobLink(title, href)) {
      continue;
    }

    const locationText = safeText(locationMatch?.[1], 220) || "Unspecified";
    const [locationLabelPart, ...metaParts] = locationText.split("|").map((value) => value.trim()).filter(Boolean);
    const department = metaParts
      .find((value) => /^department:/i.test(value))
      ?.replace(/^department:\s*/i, "")
      || null;
    const employmentType = metaParts
      .find((value) => /^job type:/i.test(value))
      ?.replace(/^job type:\s*/i, "")
      || null;

    jobs.push(buildNormalizedJob(source, {
      id: href,
      company: source.company,
      title,
      department,
      employmentType,
      locationLabel: locationLabelPart || "Unspecified",
      rawLocationText: locationLabelPart || locationText,
      applyUrl: absoluteUrl(href, requestUrl || source.careersUrl),
    }));
  }

  const deduped = new Map();
  for (const job of jobs) {
    if (!deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

async function fetchGovJobsAjaxResults(source, filters) {
  const jobs = [];
  let page = 1;

  while (page <= 25) {
    const requestUrl = buildGovJobsAjaxUrl(source, filters, page);
    const html = await fetchText(requestUrl, {
      accept: "text/html, */*; q=0.01",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    const pageJobs = extractGovJobsAjaxResults(source, html, requestUrl);
    jobs.push(...pageJobs);

    const nextPage = extractGovJobsNextPage(html, page);
    if (!nextPage || nextPage <= page) {
      break;
    }

    page = nextPage;
  }

  const deduped = new Map();
  for (const job of jobs) {
    if (!deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

function buildGovJobsAjaxUrl(source, filters, page = 1) {
  const careersUrl = new URL(source.careersUrl);
  const routePrefix = source.govjobsRoutePrefix || "/careers";
  const url = new URL(`${routePrefix}/home/index`, careersUrl.origin);

  if (source.govjobsAgency) {
    url.searchParams.set("agency", source.govjobsAgency);
  }

  if (source.govjobsDepartment) {
    url.searchParams.set("departmentFolder", source.govjobsDepartment);
  }

  const keyword = String(filters?.keyword || "").trim();
  if (keyword) {
    url.searchParams.set("keyword", keyword);
  }

  if (page > 1) {
    url.searchParams.set("page", String(page));
  }

  return url.toString();
}

function extractGovJobsNextPage(html, currentPage) {
  const nextPageMatch = html.match(/aria-label=["']Go to Next Page["'][^>]+href=["'][^"']*page=(\d+)/i);
  if (!nextPageMatch) {
    return null;
  }

  const nextPage = Number(nextPageMatch[1]);
  return Number.isFinite(nextPage) && nextPage > currentPage ? nextPage : null;
}

function matchesGovJobsDepartmentFilter(source, departmentValue) {
  const expected = Array.isArray(source.govjobsDepartmentNameIncludes)
    ? source.govjobsDepartmentNameIncludes
    : source.govjobsDepartmentNameIncludes
      ? [source.govjobsDepartmentNameIncludes]
      : [];

  if (expected.length === 0) {
    return true;
  }

  const normalizedDepartment = safeText(departmentValue, 160)?.toLowerCase() || "";
  return expected.some((value) => normalizedDepartment.includes(String(value).toLowerCase()));
}

function extractGovJobsAjaxResults(source, html, requestUrl) {
  const matches = [...html.matchAll(/<li class=["'][^"']*\blist-item\b[^"']*["'][^>]*data-job-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/li>/gi)];
  const jobs = [];

  for (const match of matches) {
    const jobId = match[1];
    const cardHtml = match[2];
    const titleMatch = cardHtml.match(/<a[^>]+class=["'][^"']*\bitem-details-link\b[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);

    if (!titleMatch) {
      continue;
    }

    const href = titleMatch[1];
    const title = safeText(titleMatch[2], 220);
    const departmentNameAttribute = titleMatch[0].match(/data-department-name=["']([^"']+)["']/i)?.[1] || null;

    if (!looksLikeJobTitle(title) || isExcludedJobLink(title, href)) {
      continue;
    }

    const metaMatches = [...cardHtml.matchAll(/<li>([\s\S]*?)<\/li>/gi)]
      .map((entry) => safeText(entry[1], 160))
      .filter(Boolean);
    const locationLabel = metaMatches[0] || "Unspecified";
    const employmentType = metaMatches[1] || null;
    const department = metaMatches[2]?.replace(/^department:\s*/i, "") || departmentNameAttribute || null;
    const postedAt = metaMatches.find((value) => /posted|closing date|closing/i.test(value)) || null;

    if (!matchesGovJobsDepartmentFilter(source, department || departmentNameAttribute)) {
      continue;
    }

    jobs.push(buildNormalizedJob(source, {
      id: jobId,
      company: source.company,
      title,
      department,
      locationLabel,
      rawLocationText: locationLabel,
      employmentType,
      postedAt,
      applyUrl: absoluteUrl(href, requestUrl || source.careersUrl),
    }));
  }

  const deduped = new Map();
  for (const job of jobs) {
    if (!deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

function extractUltiProJobOptions(source, html, requestUrl) {
  const detailTemplateMatch = html.match(/opportunityLinkUrl:\s*"([^"]+)"/i);
  const optionsJson = extractAssignedArray(html, "jobOptions");

  if (!optionsJson || !detailTemplateMatch) {
    return [];
  }

  try {
    const options = JSON.parse(optionsJson);
    const detailTemplate = detailTemplateMatch[1];
    const jobs = options
      .filter((option) => option && !option.Disabled && option.Text && option.Value)
      .map((option) => {
        const applyUrl = absoluteUrl(
          detailTemplate.replace("00000000-0000-0000-0000-000000000000", option.Value),
          requestUrl || source.careersUrl
        );

        return buildNormalizedJob(source, {
          id: option.Value,
          company: source.company,
          title: safeText(option.Text, 220),
          locationLabel: "Unspecified",
          applyUrl,
        });
      })
      .filter((job) => looksLikeJobTitle(job.title) && !isExcludedJobLink(job.title, job.applyUrl));

    const deduped = new Map();
    for (const job of jobs) {
      if (!deduped.has(job.applyUrl)) {
        deduped.set(job.applyUrl, job);
      }
    }

    return [...deduped.values()];
  } catch {
    return [];
  }
}

function extractAssignedArray(html, marker) {
  const value = String(html || "");
  const markerIndex = value.indexOf(`${marker}:`);
  if (markerIndex === -1) {
    return null;
  }

  const arrayStart = value.indexOf("[", markerIndex);
  if (arrayStart === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "[") {
      depth += 1;
      continue;
    }

    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(arrayStart, index + 1);
      }
    }
  }

  return null;
}

function extractICimsSearchResults(source, html, requestUrl) {
  const matches = [...html.matchAll(/<li class=["']iCIMS_JobCardItem["'][^>]*>([\s\S]*?)<\/li>/gi)];
  const jobs = [];

  for (const match of matches) {
    const cardHtml = match[1];
    const titleMatch = cardHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*>\s*<span[^>]*>[\s\S]*?<\/span>\s*<h3[^>]*>([\s\S]*?)<\/h3>/i);

    if (!titleMatch) {
      continue;
    }

    const href = titleMatch[1];
    const title = safeText(titleMatch[2], 220);
    const locationMatch = cardHtml.match(/<span class=["']sr-only field-label["']>\s*Location\s*<\/span>[\s\S]*?<dd class=["']iCIMS_JobHeaderData["'][^>]*><span[^>]*>\s*([\s\S]*?)<\/span>/i);
    const employmentTypeMatch = cardHtml.match(/<dt class=["']iCIMS_JobHeaderField["']>\s*Type\s*<\/dt>[\s\S]*?<dd class=["']iCIMS_JobHeaderData["'][^>]*><span[^>]*>\s*([\s\S]*?)<\/span>/i);
    const departmentMatch = cardHtml.match(/<dt class=["']iCIMS_JobHeaderField["']>\s*Division\s*<\/dt>[\s\S]*?<dd class=["']iCIMS_JobHeaderData["'][^>]*><span[^>]*>\s*([\s\S]*?)<\/span>/i);
    const locationLabel = safeText(locationMatch?.[1], 160) || "Unspecified";

    jobs.push(buildNormalizedJob(source, {
      id: href,
      company: source.company,
      title,
      department: safeText(departmentMatch?.[1], 120),
      employmentType: safeText(employmentTypeMatch?.[1], 80),
      locationLabel,
      rawLocationText: locationLabel,
      applyUrl: absoluteUrl(href, requestUrl || source.careersUrl),
    }));
  }

  const deduped = new Map();
  for (const job of jobs) {
    if (!deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

function extractSmartsheetTableJobs(source, html, requestUrl) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const jobs = [];

  for (const rowMatch of rows) {
    const rowHtml = rowMatch[1];
    const titleMatch = rowHtml.match(/<td[^>]*views-field-title[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);

    if (!titleMatch) {
      continue;
    }

    const href = titleMatch[1];
    const title = safeText(titleMatch[2], 220);

    if (!looksLikeJobTitle(title) || isExcludedJobLink(title, href)) {
      continue;
    }

    const departmentMatch = rowHtml.match(/<td[^>]*views-field-field-department[^>]*>([\s\S]*?)<\/td>/i);
    const locationMatch = rowHtml.match(/<td[^>]*views-field-field-posting-location[^>]*>([\s\S]*?)<\/td>/i);
    const department = safeText(departmentMatch?.[1], 120);
    const locationLabel = safeText(locationMatch?.[1], 120) || "Unspecified";

    jobs.push(buildNormalizedJob(source, {
      id: href,
      company: source.company,
      title,
      department,
      locationLabel,
      rawLocationText: locationLabel,
      applyUrl: absoluteUrl(href, requestUrl || source.careersUrl),
    }));
  }

  const deduped = new Map();
  for (const job of jobs) {
    if (!deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

function extractTalentBrewJobs(source, html, requestUrl) {
  const matches = [...html.matchAll(/<li>\s*<a[^>]+href=["']([^"']+)["'][^>]*>\s*<h2>([\s\S]*?)<\/h2>\s*<span class=["']job-location["']>([\s\S]*?)<\/span>[\s\S]*?<\/a>/gi)];
  const jobs = matches.map((match) => {
    const href = match[1];
    const title = safeText(match[2], 220);
    const locationLabel = safeText(match[3], 160) || "Unspecified";

    return buildNormalizedJob(source, {
      id: href,
      company: source.company,
      title,
      locationLabel,
      rawLocationText: locationLabel,
      applyUrl: absoluteUrl(href, requestUrl || source.careersUrl),
    });
  }).filter((job) => looksLikeJobTitle(job.title) && !isExcludedJobLink(job.title, job.applyUrl));

  const deduped = new Map();
  for (const job of jobs) {
    if (!deduped.has(job.applyUrl)) {
      deduped.set(job.applyUrl, job);
    }
  }

  return [...deduped.values()];
}

async function enrichMissingPostedDates(jobs) {
  const missingDateJobs = jobs.filter((job) => !job.postedAt && job.applyUrl);

  if (missingDateJobs.length === 0) {
    return jobs;
  }

  const cache = new Map();

  await mapWithConcurrency(missingDateJobs.slice(0, 30), 4, async (job) => {
    if (cache.has(job.applyUrl)) {
      job.postedAt = cache.get(job.applyUrl);
      return job;
    }

    try {
      const html = await fetchText(job.applyUrl, { signal: AbortSignal.timeout(5000) });
      const postedDate = extractPostedDateFromHtml(html);
      cache.set(job.applyUrl, postedDate);
      if (postedDate) {
        job.postedAt = postedDate;
      }
    } catch {
      cache.set(job.applyUrl, null);
    }

    return job;
  });

  return jobs;
}

function looksLikeJobLink(provider, href) {
  const value = String(href || "").toLowerCase();

  if (provider === "careerpage") {
    return value.includes("job")
      || value.includes("career")
      || value.includes("position")
      || value.includes("opening")
      || value.includes("requisition");
  }

  if (provider === "jobvite") {
    return value.includes("/job/");
  }

  if (provider === "applytojob") {
    return value.includes("/apply/");
  }

  if (provider === "applicantpro") {
    return value.includes("/jobs/");
  }

  if (provider === "ultipro") {
    return value.includes("job") || value.includes("careers");
  }

  if (provider === "taleo") {
    return value.includes("jobdetail") || value.includes("job=") || value.includes("requisition");
  }

  return value.includes("job");
}

function resolveCareersUrl(source, filters) {
  const keyword = String(filters?.keyword || "").trim();
  const location = buildSearchLocation(filters);
  const template = source.keywordSearchUrlTemplate;

  if (template) {
    return template
      .replaceAll("{{keyword}}", encodeURIComponent(keyword))
      .replaceAll("{{location}}", encodeURIComponent(location));
  }

  return source.careersUrl;
}

function buildSearchLocation(filters) {
  const groups = Array.isArray(filters?.locationGroups) ? filters.locationGroups : [];
  const firstGroup = groups.find((group) => group?.stateCode || (group?.areaNames && group.areaNames.length > 0));

  if (firstGroup) {
    const area = Array.isArray(firstGroup.areaNames) && firstGroup.areaNames.length > 0 ? firstGroup.areaNames[0] : "";
    const state = firstGroup.stateCode || "";
    return [area, state].filter(Boolean).join(", ");
  }

  return "";
}

function looksLikeJobTitle(text) {
  const value = safeText(text, 200)?.toLowerCase() || "";

  if (!value || value.length < 4) {
    return false;
  }

  const blockedExactTitles = new Set([
    "administration",
    "all careers",
    "blog",
    "commercial",
    "communications",
    "corporate",
    "corporate solutions",
    "cookie policy",
    "cookie preferences",
    "cookie settings",
    "eeo statement",
    "eeo statement and accommodation request",
    "find out more about harborview",
    "finance",
    "home health hospice",
    "home health & hospice",
    "imaging",
    "information technology",
    "log in",
    "linkedin",
    "location",
    "login",
    "meet our recruiters",
    "nursing careers",
    "application process",
    "physicians and providers",
    "providers",
    "read before you apply",
    "research careers",
    "saved jobs",
    "save job",
    "search jobs",
    "search our open positions",
    "search provider careers",
    "search nursing careers",
    "title",
    "department",
    "learning and development",
    "lab sciences",
    "view jobs",
    "view all jobs",
    "view chi jobs",
    "talent network",
    "join our talent network",
    "team members",
    "view my profile",
    "careers",
    "career opportunities",
    "explore open roles",
    "current openings",
    "open positions",
    "open roles",
    "job opportunities",
    "our story",
    "career areas",
    "our events",
    "preferences",
    "privacy policy",
    "privacy choices",
    "recently viewed jobs",
  ]);

  if (blockedExactTitles.has(value)) {
    return false;
  }

  const blockedTitlePatterns = [
    /\b(sign in|sign-on|forgot password|applicant login)\b/i,
    /\b(team members?|employees?|benefits|cookie|locations|culture|about us|blog)\b/i,
    /\b(eeo statement|accommodation request|physicians and providers|view my profile)\b/i,
    /\b(saved jobs|job alerts|talent community|join our team)\b/i,
    /\b(application process|job shadowing|learning and development|meet our recruiters)\b/i,
    /\b(read before you apply|find out more about|privacy policy|privacy choices|terms of use|research careers|linkedin|our story|career areas|life at)\b/i,
    /^(title|department|location|administration|commercial|communications|corporate|finance|providers)$/i,
    /\bsearch\b.*\bjobs?\b/i,
  ];

  if (blockedTitlePatterns.some((pattern) => pattern.test(value))) {
    return false;
  }

  return true;
}

function isExcludedJobLink(text, href) {
  const textValue = String(text || "").toLowerCase();
  const hrefValue = String(href || "").toLowerCase();

  const blockedHrefFragments = [
    "/login",
    "/log-in",
    "/signin",
    "/sign-in",
    "/saved-jobs",
    "/savedjobs",
    "/talent-network",
    "/talentnetwork",
    "/team-members",
    "/team-memberships",
    "/blog",
    "/cookie",
    "/events",
    "/benefits",
    "/eeo",
    "/locations",
    "/our-team",
    "/about",
    "/culture",
    "/faqs",
    "/preferences",
    "/privacy",
    "/profile",
    "/terms",
  ];

  if (blockedHrefFragments.some((fragment) => hrefValue.includes(fragment))) {
    return true;
  }

  if (/\b(cookie|login|preferences|privacy|saved jobs|talent network|team members?|terms|view my profile|eeo statement)\b/i.test(textValue)) {
    return true;
  }

  return !hasCareerPageJobSignals(textValue, hrefValue);
}

function hasCareerPageJobSignals(textValue, hrefValue) {
  const jobUrlSignals = [
    "/job/",
    "/jobs/",
    "/job-",
    "jobid=",
    "job_id=",
    "jobreqid",
    "gh_jid",
    "requisition",
    "opening",
    "/opening/",
    "/position/",
    "/positions/",
    "/posting/",
    "/postings/",
    "/opportunitydetail",
    "/vacancy/",
    "careersection",
  ];

  if (jobUrlSignals.some((signal) => hrefValue.includes(signal))) {
    return true;
  }

  return /\b(account(ant| executive| manager)?|administrator|analyst|architect|assistant|associate|attorney|advisor|counsel|consultant|coordinator|designer|developer|director|editor|engineer|head|intern|lead|manager|officer|partner|physician|nurse|practitioner|principal|producer|product manager|product owner|product marketer|product marketing|program manager|programmer|project manager|recruiter|representative|research(?:er| scientist)?|scientist|software|specialist|strategist|supervisor|technician|therapist|vp|vice president|writer)\b/i.test(textValue);
}
