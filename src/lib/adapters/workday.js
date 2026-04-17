import { buildNormalizedJob, fetchJson, safeText } from "./shared.js";

export async function fetchWorkdayJobs(source, filters = {}) {
  const tenant = source.tenant;
  const site = source.site;

  if (!tenant || !site) {
    throw new Error("This provider requires tenant and site");
  }

  const endpoint = `https://${source.host || "wd5.myworkdaysite.com"}/wday/cxs/${tenant}/${site}/jobs`;
  const limit = 20;
  let offset = 0;
  let total = null;
  const jobs = [];

  while (true) {
    const payload = await fetchJson(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildRequestBody(filters, limit, offset)),
    });

    const postings = Array.isArray(payload.jobPostings) ? payload.jobPostings : [];
    if (total === null) {
      total = Number(payload.total || 0);
    }
    jobs.push(...postings.map((job, index) => normalizeWorkdayJob(source, job, offset + index)));

    if (postings.length === 0) {
      break;
    }

    offset += postings.length;

    if (postings.length < limit) {
      break;
    }

    if (total !== null && total > 0 && offset >= total) {
      break;
    }
  }

  return jobs;
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
    descriptionSnippet: safeText([
      job.timeLeftToApply,
      job.jobPostingEndDateAsText,
      ...(Array.isArray(job.bulletFields) ? job.bulletFields : []),
    ].filter(Boolean).join(" • "), 240),
    rawLocationText: job.locationsText || null,
  });
}

function absoluteWorkdayJobUrl(source, externalPath) {
  if (!externalPath) {
    return source.careersUrl || null;
  }

  const host = source.host || "wd5.myworkdaysite.com";
  return `https://${host}/recruiting/${source.tenant}/${source.site}${externalPath}`;
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
    if (/posted today/i.test(job.postedOn)) {
      return new Date().toISOString().slice(0, 10);
    }

    const daysMatch = job.postedOn.match(/posted\s+(\d+)\s+days?\s+ago/i);
    if (daysMatch?.[1]) {
      const date = new Date();
      date.setDate(date.getDate() - Number(daysMatch[1]));
      return date.toISOString().slice(0, 10);
    }
  }

  return null;
}
