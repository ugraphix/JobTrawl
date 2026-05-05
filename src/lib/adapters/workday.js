import {
  buildNormalizedJob,
  cleanText,
  fetchJson,
  fetchWorkdayDescriptionFallback,
  mapWithConcurrency,
  recordLiveFetchAuditSummary,
  safeText,
} from "./shared.js";

const WORKDAY_DETAIL_CONCURRENCY = 3;
const WORKDAY_DETAIL_MAX_JOBS = 120;
const ZILLOW_DETAIL_MAX_JOBS = 60;
const WORKDAY_LIST_LIMIT = 20;
const WORKDAY_LIST_PAGE_DELAY_MS = 150;
const WORKDAY_LIST_RETRY_DELAY_MS = 800;
const WORKDAY_LIST_MAX_RETRIES = 1;

export async function fetchWorkdayJobs(source, filters = {}) {
  const resolvedSource = resolveWorkdaySourceConfig(source);
  const tenant = resolvedSource.tenant;
  const site = resolvedSource.site;
  const endpoint = resolvedSource.endpoint;

  if (!tenant || !site || !endpoint) {
    recordLiveFetchAuditSummary({
      workdaySourceStatus: "invalid_config",
      workdayTenant: tenant || null,
      workdaySite: site || null,
      workdayEndpoint: endpoint || null,
    });
    return [];
  }

  let offset = 0;
  let total = null;
  const jobs = [];

  while (true) {
    if (offset > 0) {
      await sleep(WORKDAY_LIST_PAGE_DELAY_MS);
    }

    let payload;
    try {
      payload = await fetchWorkdayListPage(endpoint, filters, offset);
    } catch (error) {
      if (isHardInvalidWorkdayError(error)) {
        recordLiveFetchAuditSummary({
          workdaySourceStatus: "invalid_endpoint",
          workdayTenant: tenant,
          workdaySite: site,
          workdayEndpoint: endpoint,
        });
        if (jobs.length === 0) {
          return [];
        }
        break;
      }

      if (isTemporaryWorkdayError(error)) {
        recordLiveFetchAuditSummary({
          workdaySourceStatus: "blocked_or_temporary",
          workdayTenant: tenant,
          workdaySite: site,
          workdayEndpoint: endpoint,
        });
        if (jobs.length === 0) {
          return [];
        }
        break;
      }

      throw error;
    }

    const postings = Array.isArray(payload.jobPostings) ? payload.jobPostings : [];
    if (total === null) {
      total = Number(payload.total || 0);
      if (Number.isFinite(total) && total >= 0) {
        recordLiveFetchAuditSummary({
          rawJobCount: total,
          rawJobCountBasis: "workday_payload_total",
        });
      }
    }
    jobs.push(...postings.map((job, index) => normalizeWorkdayJob(source, job, offset + index)));

    if (postings.length === 0) {
      recordLiveFetchAuditSummary({
        workdaySourceStatus: jobs.length > 0 ? "parsed" : "empty",
        workdayTenant: tenant,
        workdaySite: site,
        workdayEndpoint: endpoint,
      });
      break;
    }

    offset += postings.length;

    if (postings.length < WORKDAY_LIST_LIMIT) {
      break;
    }

    if (total !== null && total > 0 && offset >= total) {
      break;
    }
  }

  if (!Number.isFinite(total) || total < jobs.length) {
    recordLiveFetchAuditSummary({
      rawJobCount: jobs.length,
      rawJobCountBasis: "workday_accumulated_jobpostings",
    });
  }
  if (jobs.length > 0) {
    recordLiveFetchAuditSummary({
      workdaySourceStatus: "parsed",
      workdayTenant: tenant,
      workdaySite: site,
      workdayEndpoint: endpoint,
    });
  }

  const keyword = String(filters.keyword || "").trim();
  const isZillowSource = String(source?.key || "").toLowerCase() === "zillow-careerpage";
  const shouldFetchDetails = source.fetchWorkdayDetails !== false
    && jobs.length > 0
    && (
      Boolean(keyword)
      || jobs.length <= WORKDAY_DETAIL_MAX_JOBS
      || isZillowSource
    );

  if (shouldFetchDetails) {
    const detailJobs = isZillowSource
      ? prioritizeWorkdayDetailJobs(jobs, ZILLOW_DETAIL_MAX_JOBS)
      : prioritizeWorkdayDetailJobs(jobs, WORKDAY_DETAIL_MAX_JOBS);
    await enrichWorkdayDescriptions(detailJobs);
  }

  return jobs;
}

async function fetchWorkdayListPage(endpoint, filters, offset) {
  let attempt = 0;
  while (true) {
    try {
      return await fetchJson(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildRequestBody(filters, WORKDAY_LIST_LIMIT, offset)),
      });
    } catch (error) {
      attempt += 1;
      if (!isTemporaryWorkdayError(error) || attempt > WORKDAY_LIST_MAX_RETRIES) {
        throw error;
      }
      await sleep(WORKDAY_LIST_RETRY_DELAY_MS * attempt);
    }
  }
}

function buildRequestBody(filters, limit, offset) {
  const body = { limit, offset };
  const keyword = String(filters.keyword || "").trim();

  if (keyword) {
    body.searchText = keyword;
  }

  return body;
}

function normalizeWorkdayJob(source, job, index) {
  const applyUrl = absoluteWorkdayJobUrl(source, job.externalPath);
  const postingDate = extractPostingDate(job);

  return buildNormalizedJob(source, {
    id: job.bulletFields?.[0] || job.externalPath || `${source.key}-${index}`,
    company: source.company,
    title: job.title,
    locationLabel: job.locationsText || "Unspecified",
    postedAt: postingDate,
    applyUrl,
    descriptionSnippet: null,
    searchText: null,
    rawLocationText: job.locationsText || null,
  });
}

function resolveWorkdaySourceConfig(source = {}) {
  const derived = deriveWorkdayPartsFromCareersUrl(source.careersUrl);
  const host = derived.host || source.host || "wd5.myworkdaysite.com";
  const tenant = derived.tenant || source.tenant || "";
  const site = derived.site || source.site || "";
  const endpoint = host && tenant && site ? `https://${host}/wday/cxs/${tenant}/${site}/jobs` : null;
  return {
    ...source,
    host,
    tenant,
    site,
    endpoint,
  };
}

function deriveWorkdayPartsFromCareersUrl(careersUrl) {
  try {
    const parsed = new URL(String(careersUrl || "").trim());
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) {
      return {
        host: parsed.hostname,
        tenant: parsed.hostname.split(".")[0] || "",
        site: "",
      };
    }

    if (segments[0].toLowerCase() === "recruiting" && segments.length >= 3) {
      return {
        host: parsed.hostname,
        tenant: segments[1],
        site: segments[2],
      };
    }

    return {
      host: parsed.hostname,
      tenant: parsed.hostname.split(".")[0] || "",
      site: segments[0],
    };
  } catch {
    return {
      host: "",
      tenant: "",
      site: "",
    };
  }
}

function isTemporaryWorkdayError(error) {
  const status = Number(error?.status);
  return status === 403 || status === 429 || status === 502 || status === 503 || status === 504;
}

function isHardInvalidWorkdayError(error) {
  const status = Number(error?.status);
  return status === 404 || status === 410 || status === 422;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function enrichWorkdayDescriptions(jobs) {
  await mapWithConcurrency(jobs, WORKDAY_DETAIL_CONCURRENCY, async (job) => {
    if (!job?.applyUrl) {
      return job;
    }

    const fallback = await fetchWorkdayDescriptionFallback(job.applyUrl);
    if (fallback.descriptionSnippet || fallback.searchText) {
      job.descriptionSnippet = fallback.descriptionSnippet || safeText(cleanText(fallback.searchText), 2200) || null;
      job.searchText = fallback.searchText || fallback.descriptionSnippet || null;
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
    if ((!job.externalId || /^https?:/i.test(String(job.externalId || "").trim())) && fallback.jobId) {
      job.externalId = fallback.jobId;
    }
    if ((!job.workArrangement || job.workArrangement === "unknown") && fallback.workArrangement) {
      job.workArrangement = fallback.workArrangement;
    }

    return job;
  });
}

function prioritizeWorkdayDetailJobs(jobs, limit) {
  return [...jobs]
    .sort((left, right) => {
      const leftMissingMetadata = workdayNeedsDetailMetadata(left) ? 1 : 0;
      const rightMissingMetadata = workdayNeedsDetailMetadata(right) ? 1 : 0;
      if (leftMissingMetadata !== rightMissingMetadata) {
        return rightMissingMetadata - leftMissingMetadata;
      }
      return String(left?.title || "").localeCompare(String(right?.title || ""));
    })
    .slice(0, limit);
}

function workdayNeedsDetailMetadata(job) {
  if (!job) {
    return false;
  }
  return (
    !job.postedAt
    || !job.country
    || !job.city
    || String(job.locationLabel || "").trim().toLowerCase() === "unspecified"
    || /^\d+\s+locations?$/i.test(String(job.locationLabel || "").trim())
  );
}

function absoluteWorkdayJobUrl(source, externalPath) {
  if (!externalPath) {
    return source.careersUrl || null;
  }

  const rawPath = String(externalPath || "").trim();
  if (!rawPath) {
    return source.careersUrl || null;
  }

  if (/invalid-url/i.test(rawPath)) {
    return source.careersUrl || null;
  }

  if (/^https?:\/\//i.test(rawPath)) {
    return rawPath;
  }

  if (source.careersUrl) {
    const baseUrl = String(source.careersUrl).replace(/\/+$/, "");
    const joinedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    return `${baseUrl}${joinedPath}`;
  }

  const host = source.host || "wd5.myworkdaysite.com";
  const siteBase = host.includes("myworkdayjobs.com")
    ? `https://${host}/${source.site}`
    : `https://${host}/recruiting/${source.tenant}/${source.site}`;
  const joinedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return `${siteBase}${joinedPath}`;
}

function extractPostingDate(job) {
  const bulletFields = Array.isArray(job.bulletFields) ? job.bulletFields : [];
  const explicitField = bulletFields.find((field) => /posting date:/i.test(field));
  if (explicitField) {
    const match = explicitField.match(/posting date:\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i);
    if (match?.[1]) {
      const [month, day, year] = match[1].split("/");
      return `${year}-${month}-${day}`;
    }
  }

  if (typeof job.postedOn === "string") {
    const postedOnText = job.postedOn.trim();
    if (/posted today/i.test(postedOnText)) {
      return new Date().toISOString().slice(0, 10);
    }

    if (/posted yesterday/i.test(postedOnText)) {
      const date = new Date();
      date.setDate(date.getDate() - 1);
      return date.toISOString().slice(0, 10);
    }

    const daysMatch = postedOnText.match(/posted\s+(\d+)(?:\+)?\s+days?\s+ago/i);
    if (daysMatch?.[1]) {
      const date = new Date();
      date.setDate(date.getDate() - Number(daysMatch[1]));
      return date.toISOString().slice(0, 10);
    }
  }

  return null;
}
