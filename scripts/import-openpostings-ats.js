import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const cwd = process.cwd();
const dbPath = path.join(cwd, "openpostings_reference", "jobs.db");
const outputPath = path.join(cwd, "config", "openpostings-sources.json");

const ATS_NAME_TO_PROVIDER = new Map([
  ["workday", "workday"],
  ["ashbyhq", "ashby"],
  ["greenhouseio", "greenhouse"],
  ["greenhouse.io", "greenhouse"],
  ["greenhouse", "greenhouse"],
  ["leverco", "lever"],
  ["lever.co", "lever"],
  ["lever", "lever"],
  ["jobvite", "jobvite"],
  ["jobvite.com", "jobvite"],
  ["jobvitecom", "jobvite"],
  ["applicantpro", "applicantpro"],
  ["applicantpro.com", "applicantpro"],
  ["applicantprocom", "applicantpro"],
  ["applytojob", "applytojob"],
  ["applytojob.com", "applytojob"],
  ["applytojobcom", "applytojob"],
  ["theapplicantmanager", "theapplicantmanager"],
  ["theapplicantmanager.com", "theapplicantmanager"],
  ["theapplicantmanagercom", "theapplicantmanager"],
  ["icims", "icims"],
  ["icims.com", "icims"],
  ["icimscom", "icims"],
  ["recruitee", "recruitee"],
  ["recruitee.com", "recruitee"],
  ["recruiteecom", "recruitee"],
  ["ultipro", "ultipro"],
  ["ukg", "ultipro"],
  ["taleo", "taleo"],
  ["taleo.net", "taleo"],
  ["taleonet", "taleo"],
  ["breezy", "breezy"],
  ["breezyhr", "breezy"],
  ["breezy.hr", "breezy"],
  ["breezyhrcom", "breezy"],
  ["applicantai", "applicantai"],
  ["applicantai.com", "applicantai"],
  ["applicantaicom", "applicantai"],
  ["careerplug", "careerplug"],
  ["careerplug.com", "careerplug"],
  ["careerplugcom", "careerplug"],
  ["careerpuck", "careerpuck"],
  ["careerpuck.com", "careerpuck"],
  ["careerpuckcom", "careerpuck"],
  ["fountain", "fountain"],
  ["fountain.com", "fountain"],
  ["fountaincom", "fountain"],
  ["getro", "getro"],
  ["getro.com", "getro"],
  ["getrocom", "getro"],
  ["hrmdirect", "hrmdirect"],
  ["hrmdirect.com", "hrmdirect"],
  ["hrmdirectcom", "hrmdirect"],
  ["talentlyft", "talentlyft"],
  ["talentlyft.com", "talentlyft"],
  ["talentlyftcom", "talentlyft"],
  ["talexio", "talexio"],
  ["talexio.com", "talexio"],
  ["talexiocom", "talexio"],
  ["teamtailor", "teamtailor"],
  ["teamtailor.com", "teamtailor"],
  ["teamtailorcom", "teamtailor"],
  ["manatal", "manatal"],
  ["manatal.com", "manatal"],
  ["manatalcom", "manatal"],
  ["careers-page.com", "manatal"],
  ["careerspagecom", "manatal"],
  ["zoho", "zoho"],
  ["zohorecruit", "zoho"],
  ["zohorecruit.com", "zoho"],
  ["zohorecruitcom", "zoho"],
]);

const args = parseArgs(process.argv.slice(2));
const limitPerProvider = args.limitPerProvider;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const db = new DatabaseSync(dbPath, { readonly: true });
  const companies = db.prepare(`
    SELECT id, company_name, url_string, ATS_name
    FROM companies
    ORDER BY ATS_name ASC, company_name ASC
  `).all();

  const sources = [];
  const providerCounts = new Map();
  const seenKeys = new Set();
  let unsupportedCount = 0;
  let unparsedCount = 0;

  for (const company of companies) {
    const provider = normalizeProvider(company.ATS_name);
    if (!provider) {
      unsupportedCount += 1;
      continue;
    }

    if (limitPerProvider > 0 && (providerCounts.get(provider) || 0) >= limitPerProvider) {
      continue;
    }

    const source = createSourceFromCompany(company, provider);
    if (!source) {
      unparsedCount += 1;
      continue;
    }

    if (seenKeys.has(source.key)) {
      continue;
    }

    sources.push(source);
    seenKeys.add(source.key);
    providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    importedFrom: "openpostings_reference/jobs.db",
    sourceCount: sources.length,
    unsupportedCount,
    unparsedCount,
    limitPerProvider: limitPerProvider > 0 ? limitPerProvider : null,
    providerCounts: Object.fromEntries([...providerCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    sources,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${sources.length} generated ATS sources to ${path.relative(cwd, outputPath)}`);
  console.log(JSON.stringify(payload.providerCounts, null, 2));
}

function parseArgs(argv) {
  let limit = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    if (arg === "--limit-per-provider") {
      limit = toPositiveInt(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit-per-provider=")) {
      limit = toPositiveInt(arg.split("=")[1]);
    }
  }

  return {
    limitPerProvider: limit,
  };
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeProvider(rawAtsName) {
  const normalized = String(rawAtsName || "").trim().toLowerCase();
  return ATS_NAME_TO_PROVIDER.get(normalized) || "";
}

function createSourceFromCompany(company, provider) {
  const companyName = cleanCompanyName(company.company_name, company.url_string);
  const url = safeUrl(company.url_string);
  if (!url) {
    return null;
  }

  const source = {
    key: buildSourceKey(companyName, provider, url),
    company: companyName,
    provider,
    careersUrl: normalizeCareersUrl(url),
    importedFrom: "openpostings_reference/jobs.db",
    importedCompanyId: company.id,
    inventorySource: "openpostings",
    atsCollectionKey: `imported-${provider}`,
    atsCollectionLabel: `${providerLabel(provider)} (Imported ATS inventory)`,
    generatedInventory: true,
  };

  switch (provider) {
    case "ashby": {
      const organization = firstPathSegment(url);
      if (!organization) return null;
      source.organization = organization;
      break;
    }
    case "greenhouse": {
      const boardToken = extractGreenhouseBoardToken(url);
      if (!boardToken) return null;
      source.boardToken = boardToken;
      break;
    }
    case "lever": {
      const site = firstPathSegment(url);
      if (!site) return null;
      source.site = site;
      break;
    }
    case "jobvite": {
      const site = firstPathSegment(url);
      if (!site) return null;
      source.site = site;
      break;
    }
    case "workday": {
      const workdayConfig = extractWorkdayConfig(url);
      if (!workdayConfig) return null;
      Object.assign(source, workdayConfig);
      break;
    }
    case "recruitee": {
      const subdomain = hostSubdomain(url, ".recruitee.com");
      if (!subdomain) return null;
      source.subdomain = subdomain;
      break;
    }
    case "zoho": {
      const subdomain = hostSubdomain(url, ".zohorecruit.com");
      if (!subdomain) return null;
      source.subdomain = subdomain;
      break;
    }
    case "breezy": {
      const subdomain = hostSubdomain(url, ".breezy.hr");
      if (!subdomain) return null;
      source.subdomain = subdomain;
      source.portalUrl = normalizeCareersUrl(url);
      break;
    }
    case "careerplug": {
      const subdomain = hostSubdomain(url, ".careerplug.com");
      if (!subdomain) return null;
      source.subdomain = subdomain;
      break;
    }
    case "careerpuck": {
      const boardSlug = lastPathSegment(url);
      if (!boardSlug) return null;
      source.boardSlug = boardSlug;
      break;
    }
    case "fountain": {
      source.boardUrl = normalizeCareersUrl(url);
      break;
    }
    case "getro": {
      const subdomain = hostSubdomain(url, ".getro.com");
      if (!subdomain) return null;
      source.subdomain = subdomain;
      break;
    }
    case "hrmdirect": {
      source.jobsUrl = normalizeHrmDirectJobsUrl(url);
      break;
    }
    case "talentlyft": {
      const subdomain = hostSubdomain(url, ".talentlyft.com");
      if (!subdomain) return null;
      source.subdomain = subdomain;
      break;
    }
    case "talexio": {
      source.jobsUrl = normalizeTalexioJobsUrl(url);
      source.apiUrl = resolveTalexioApiUrl(url);
      break;
    }
    case "teamtailor": {
      const subdomain = hostSubdomain(url, ".teamtailor.com");
      if (!subdomain) return null;
      source.subdomain = subdomain;
      break;
    }
    case "manatal": {
      const domainSlug = extractManatalDomainSlug(url);
      if (domainSlug) {
        source.domainSlug = domainSlug;
      }
      break;
    }
    case "theapplicantmanager": {
      const companyCode = String(url.searchParams.get("co") || "").trim().toLowerCase();
      if (companyCode) {
        source.companyCode = companyCode;
      }
      break;
    }
    case "applicantai": {
      const slug = firstPathSegment(url);
      if (slug) {
        source.slug = slug;
      }
      break;
    }
    default:
      break;
  }

  return source;
}

function cleanCompanyName(name, rawUrl) {
  const normalized = String(name || "").trim();
  if (normalized) {
    return normalized;
  }
  const fallbackUrl = safeUrl(rawUrl);
  const host = String(fallbackUrl?.hostname || "").replace(/^www\./i, "");
  return host || "Unknown Company";
}

function buildSourceKey(companyName, provider, url) {
  const companyPart = slugify(companyName) || slugify(hostWithoutWww(url.hostname)) || "source";
  return `${companyPart}-${provider}`;
}

function normalizeCareersUrl(url) {
  const next = new URL(url.toString());
  next.hash = "";
  return next.toString();
}

function extractGreenhouseBoardToken(url) {
  const forParam = String(url.searchParams.get("for") || "").trim();
  if (forParam) {
    return forParam;
  }
  const host = String(url.hostname || "").toLowerCase();
  if (!host.includes("greenhouse.io")) {
    return "";
  }
  return firstPathSegment(url);
}

function extractWorkdayConfig(url) {
  const host = String(url.hostname || "").trim().toLowerCase();
  if (!host.includes(".myworkdayjobs.com")) {
    return null;
  }

  const segments = String(url.pathname || "").split("/").filter(Boolean);
  const site = segments[0];
  const tenant = String(host.split(".")[0] || "").trim().toLowerCase();
  if (!site || !tenant) {
    return null;
  }

  return {
    host,
    tenant,
    site,
    careersUrl: `${url.protocol}//${host}/${site}`,
  };
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

function hostWithoutWww(hostname) {
  return String(hostname || "").replace(/^www\./i, "");
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function safeUrl(value) {
  try {
    return new URL(String(value || "").trim());
  } catch {
    return null;
  }
}

function providerLabel(provider) {
  const labels = {
    applicantai: "ApplicantAI",
    applicantpro: "ApplicantPro",
    applytojob: "ApplyToJob",
    ashby: "Ashby",
    bamboohr: "BambooHR",
    breezy: "BreezyHR",
    careerplug: "Career Plug",
    careerpuck: "Career Puck",
    fountain: "Fountain",
    gem: "Gem",
    getro: "Getro",
    greenhouse: "Greenhouse",
    hrmdirect: "HRM Direct",
    icims: "iCIMS",
    join: "JOIN",
    jobaps: "Jobaps",
    jobvite: "Jobvite",
    lever: "Lever",
    manatal: "Manatal",
    recruitee: "Recruitee",
    saphrcloud: "Saphrcloud",
    talentreef: "Talent Reef",
    talentlyft: "Talent Lyft",
    taleo: "Taleo",
    talexio: "Talexio",
    teamtailor: "Team Tailor",
    theapplicantmanager: "The Applicant Manager",
    ultipro: "UltiPro / UKG",
    workable: "Workable",
    workday: "Workday",
    zoho: "Zoho Recruit",
  };

  return labels[provider] || provider;
}
