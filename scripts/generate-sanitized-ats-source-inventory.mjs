import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const cwd = process.cwd();
const inputPath = path.join(cwd, "_vendor_openlistings", "jobs.db");
const outputPath = path.join(cwd, "config", "sanitized-ats-source-inventory.json");

const ATS_NAME_TO_PROVIDER = new Map([
  ["applicantai", "applicantai"],
  ["applicantpro", "applicantpro"],
  ["applytojob", "applytojob"],
  ["ashby", "ashby"],
  ["ashbyhq", "ashby"],
  ["bamboohr", "bamboohr"],
  ["breezy", "breezy"],
  ["breezyhr", "breezy"],
  ["careerplug", "careerplug"],
  ["careerpuck", "careerpuck"],
  ["fountain", "fountain"],
  ["gem", "gem"],
  ["getro", "getro"],
  ["greenhouse", "greenhouse"],
  ["greenhouseio", "greenhouse"],
  ["hrmdirect", "hrmdirect"],
  ["icims", "icims"],
  ["jobaps", "jobaps"],
  ["jobvite", "jobvite"],
  ["join", "join"],
  ["lever", "lever"],
  ["leverco", "lever"],
  ["manatal", "manatal"],
  ["recruitee", "recruitee"],
  ["saphrcloud", "saphrcloud"],
  ["smartrecruiters", "smartrecruiters"],
  ["talentreef", "talentreef"],
  ["talentlyft", "talentlyft"],
  ["taleo", "taleo"],
  ["talexio", "talexio"],
  ["teamtailor", "teamtailor"],
  ["theapplicantmanager", "theapplicantmanager"],
  ["ukg", "ultipro"],
  ["ultipro", "ultipro"],
  ["workable", "workable"],
  ["workday", "workday"],
  ["zoho", "zoho"],
  ["zohorecruit", "zoho"],
]);

const SUMMARY_SAMPLE_LIMIT = 10;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const db = new DatabaseSync(inputPath, { readonly: true });
  const rows = db.prepare(`
    SELECT company_name, url_string, ATS_name
    FROM companies
    WHERE url_string IS NOT NULL
      AND trim(url_string) <> ''
      AND ATS_name IS NOT NULL
      AND trim(ATS_name) <> ''
    ORDER BY lower(ATS_name) ASC, lower(company_name) ASC, lower(url_string) ASC
  `).all();

  const sources = [];
  const seenKeys = new Set();
  const countsByProvider = new Map();
  const skippedByReason = new Map();
  const duplicateCountsByProvider = new Map();
  const invalidUrlCountsByProvider = new Map();
  const samplesByProvider = new Map();

  for (const row of rows) {
    const rawAtsName = String(row.ATS_name || "");
    const provider = normalizeProvider(rawAtsName);
    if (!provider) {
      increment(skippedByReason, "unsupported_provider");
      continue;
    }

    const url = safeUrl(row.url_string);
    if (!url) {
      increment(skippedByReason, "invalid_url");
      increment(invalidUrlCountsByProvider, provider);
      continue;
    }

    const source = createSource(row, provider, url);
    if (!source) {
      increment(skippedByReason, "provider_config_unresolved");
      continue;
    }

    if (!source.sourceKey) {
      increment(skippedByReason, "missing_source_key");
      continue;
    }

    if (seenKeys.has(source.sourceKey)) {
      increment(skippedByReason, "duplicate_source_key");
      increment(duplicateCountsByProvider, provider);
      continue;
    }

    seenKeys.add(source.sourceKey);
    sources.push(source);
    increment(countsByProvider, provider);

    const samples = samplesByProvider.get(provider) || [];
    if (samples.length < 2) {
      samples.push(source);
      samplesByProvider.set(provider, samples);
    }
  }

  sources.sort(compareSources);

  const payload = {
    schemaVersion: 1,
    sourceCount: sources.length,
    providerCounts: sortedObject(countsByProvider),
    skippedCounts: sortedObject(skippedByReason),
    duplicateCountsByProvider: sortedObject(duplicateCountsByProvider),
    invalidUrlCountsByProvider: sortedObject(invalidUrlCountsByProvider),
    sources,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const sampleRecords = pickSamples(samplesByProvider);
  console.log(JSON.stringify({
    output: path.relative(cwd, outputPath),
    totalGenerated: sources.length,
    providerCounts: payload.providerCounts,
    skippedCounts: payload.skippedCounts,
    duplicateCountsByProvider: payload.duplicateCountsByProvider,
    invalidUrlCountsByProvider: payload.invalidUrlCountsByProvider,
    sampleRecords,
  }, null, 2));
}

function normalizeProvider(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, "");
  return ATS_NAME_TO_PROVIDER.get(key) || "";
}

function createSource(row, provider, url) {
  const company = cleanCompanyName(row.company_name, url);
  const sourceKey = buildSourceKey(company, provider);
  if (!sourceKey) {
    return null;
  }

  const base = {
    provider,
    sourceKey,
    company,
    careersUrl: normalizeUrl(url),
  };

  switch (provider) {
    case "workday": {
      const config = extractWorkdayConfig(url);
      return config ? { ...base, ...config, careersUrl: config.careersUrl } : null;
    }
    case "ashby": {
      const organization = firstPathSegment(url);
      return organization ? { ...base, organization } : null;
    }
    case "greenhouse": {
      const boardToken = extractGreenhouseBoardToken(url);
      return boardToken ? { ...base, boardToken } : null;
    }
    case "lever": {
      const companySlug = firstPathSegment(url);
      return companySlug ? { ...base, companySlug, site: companySlug } : null;
    }
    case "jobvite": {
      const site = firstPathSegment(url);
      return site ? { ...base, site } : null;
    }
    case "recruitee": {
      const subdomain = hostSubdomain(url, ".recruitee.com");
      return subdomain ? { ...base, subdomain } : null;
    }
    case "zoho": {
      const subdomain = hostSubdomain(url, ".zohorecruit.com");
      return subdomain ? { ...base, subdomain } : null;
    }
    case "breezy": {
      const subdomain = hostSubdomain(url, ".breezy.hr");
      return subdomain ? { ...base, subdomain, portalUrl: normalizeUrl(url) } : null;
    }
    case "bamboohr": {
      const subdomain = hostSubdomain(url, ".bamboohr.com");
      return subdomain ? { ...base, subdomain } : null;
    }
    case "careerplug": {
      const subdomain = hostSubdomain(url, ".careerplug.com");
      return subdomain ? { ...base, subdomain } : null;
    }
    case "careerpuck": {
      const boardSlug = lastPathSegment(url);
      return boardSlug ? { ...base, boardSlug } : null;
    }
    case "fountain": {
      return { ...base, boardUrl: normalizeUrl(url) };
    }
    case "gem": {
      const slug = firstPathSegment(url);
      return slug ? { ...base, slug } : null;
    }
    case "getro": {
      const subdomain = hostSubdomain(url, ".getro.com");
      return subdomain ? { ...base, subdomain } : null;
    }
    case "hrmdirect": {
      return { ...base, jobsUrl: normalizeHrmDirectJobsUrl(url) };
    }
    case "icims": {
      const host = String(url.hostname || "").toLowerCase();
      return host.endsWith(".icims.com") ? { ...base, host, searchUrl: normalizeUrl(url) } : null;
    }
    case "jobaps": {
      const slug = firstPathSegment(url);
      return slug ? { ...base, slug } : null;
    }
    case "join": {
      const companySlug = extractJoinCompanySlug(url);
      return companySlug ? { ...base, companySlug } : null;
    }
    case "manatal": {
      const domainSlug = extractManatalDomainSlug(url);
      return domainSlug ? { ...base, domainSlug } : base;
    }
    case "saphrcloud": {
      return { ...base, searchUrl: normalizeUrl(url) };
    }
    case "smartrecruiters": {
      const companyIdentifier = firstPathSegment(url);
      return companyIdentifier ? { ...base, companyIdentifier, slug: companyIdentifier } : null;
    }
    case "talentreef": {
      const slug = lastPathSegment(url);
      return slug ? { ...base, slug } : null;
    }
    case "talentlyft": {
      const subdomain = hostSubdomain(url, ".talentlyft.com");
      return subdomain ? { ...base, subdomain } : null;
    }
    case "talexio": {
      return { ...base, jobsUrl: normalizeTalexioJobsUrl(url), apiUrl: resolveTalexioApiUrl(url) };
    }
    case "teamtailor": {
      const subdomain = hostSubdomain(url, ".teamtailor.com");
      return subdomain ? { ...base, subdomain } : null;
    }
    case "theapplicantmanager": {
      const companyCode = String(url.searchParams.get("co") || "").trim().toLowerCase();
      return companyCode ? { ...base, companyCode } : base;
    }
    case "applicantai": {
      const slug = firstPathSegment(url);
      return slug ? { ...base, slug } : base;
    }
    case "applicantpro":
    case "applytojob":
    case "taleo":
    case "ultipro":
    case "workable": {
      return base;
    }
    default:
      return null;
  }
}

function cleanCompanyName(name, url) {
  const normalized = cleanString(name);
  if (normalized) {
    return normalized;
  }
  return String(url.hostname || "").replace(/^www\./i, "") || "Unknown Company";
}

function buildSourceKey(company, provider) {
  const slug = slugify(company);
  return slug && provider ? `${slug}-${provider}` : "";
}

function safeUrl(value) {
  const cleaned = cleanString(value)
    .replace(/^(?:ï»¿|\uFEFF)+/u, "")
    .trim();
  try {
    const url = new URL(cleaned);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  const next = new URL(url.toString());
  next.hash = "";
  return next.toString();
}

function extractWorkdayConfig(url) {
  const host = String(url.hostname || "").toLowerCase();
  if (!host.includes(".myworkdayjobs.com")) {
    return null;
  }

  const tenant = String(host.split(".")[0] || "").trim().toLowerCase();
  const segments = String(url.pathname || "").split("/").filter(Boolean);
  const site = segments.find((segment) => !/^[a-z]{2}-[A-Z]{2}$/.test(segment)) || "";
  if (!tenant || !site) {
    return null;
  }

  return {
    host,
    tenant,
    site,
    careersUrl: `${url.protocol}//${host}/${site}`,
  };
}

function extractGreenhouseBoardToken(url) {
  const fromParam = cleanString(url.searchParams.get("for"));
  if (fromParam) {
    return fromParam;
  }
  const host = String(url.hostname || "").toLowerCase();
  if (!host.includes("greenhouse.io")) {
    return "";
  }
  return firstPathSegment(url);
}

function extractJoinCompanySlug(url) {
  const segments = String(url.pathname || "").split("/").filter(Boolean);
  const companyIndex = segments.findIndex((segment) => segment.toLowerCase() === "companies");
  if (companyIndex >= 0 && segments[companyIndex + 1]) {
    return segments[companyIndex + 1];
  }
  return firstPathSegment(url);
}

function normalizeHrmDirectJobsUrl(url) {
  const next = new URL(url.toString());
  next.pathname = "/employment/job-openings.php";
  next.searchParams.set("search", "true");
  next.hash = "";
  return next.toString();
}

function normalizeTalexioJobsUrl(url) {
  return `${url.protocol}//${url.host}/jobs/`;
}

function resolveTalexioApiUrl(url) {
  return `${url.protocol}//${url.host}/api/jobs`;
}

function extractManatalDomainSlug(url) {
  const host = String(url.hostname || "").toLowerCase();
  if (host.endsWith(".careers-page.com") && host !== "www.careers-page.com") {
    return String(host.split(".")[0] || "").trim().toLowerCase();
  }
  return firstPathSegment(url);
}

function hostSubdomain(url, suffix) {
  const host = String(url.hostname || "").toLowerCase();
  if (!host.endsWith(suffix)) {
    return "";
  }
  return host.slice(0, host.length - suffix.length).replace(/\.$/, "");
}

function firstPathSegment(url) {
  return String(url.pathname || "").split("/").filter(Boolean)[0] || "";
}

function lastPathSegment(url) {
  const segments = String(url.pathname || "").split("/").filter(Boolean);
  return segments[segments.length - 1] || "";
}

function cleanString(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

function slugify(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function compareSources(left, right) {
  return (
    left.provider.localeCompare(right.provider)
    || left.sourceKey.localeCompare(right.sourceKey)
    || left.company.localeCompare(right.company)
  );
}

function pickSamples(samplesByProvider) {
  const samples = [];
  for (const provider of [...samplesByProvider.keys()].sort()) {
    for (const sample of samplesByProvider.get(provider) || []) {
      samples.push(sample);
      if (samples.length >= SUMMARY_SAMPLE_LIMIT) {
        return samples;
      }
    }
  }
  return samples;
}
