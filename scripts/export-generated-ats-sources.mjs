import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const rootDir = process.cwd();
const generatedAtsDbPath = path.join(rootDir, "generated_ats_reference", "jobs.db");
const existingSourcesPath = path.join(rootDir, "config", "sources.json");
const outputPath = path.join(rootDir, "config", "generated-ats-source-candidates.json");

const ATS_PROVIDER_MAP = new Map([
  ["AshbyHQ", "ashby"],
  ["GreenHouse", "greenhouse"],
  ["LeverCO", "lever"],
  ["jobvite", "jobvite"],
  ["applicantpro", "applicantpro"],
  ["applytojob", "applytojob"],
  ["theapplicantmanager", "theapplicantmanager"],
  ["icims", "icims"],
  ["Icims", "icims"],
  ["recruitee", "recruitee"],
  ["ultipro", "ultipro"],
  ["taleo", "taleo"],
  ["breezyHR", "breezy"],
  ["applicantAI", "applicantai"],
  ["careerplug", "careerplug"],
  ["careerpuck", "careerpuck"],
  ["fountain", "fountain"],
  ["getro", "getro"],
  ["hrmdirect", "hrmdirect"],
  ["talentlyft", "talentlyft"],
  ["talexio", "talexio"],
  ["teamtailor", "teamtailor"],
  ["manatal", "manatal"],
  ["Zoho", "zoho"],
  ["BambooHR", "bamboohr"],
  ["Gem", "gem"],
  ["jobaps", "jobaps"],
  ["join", "join"],
  ["Saphrcloud", "saphrcloud"],
  ["TalentReef", "talentreef"],
]);

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toTitle(value) {
  return String(value || "")
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

function buildSourceKey(company, provider) {
  return `${normalizeKey(company)}-${provider}`;
}

function parseProviderSpecificFields(provider, urlString) {
  const careersUrl = String(urlString || "").trim();
  if (!careersUrl) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(careersUrl);
  } catch {
    return { careersUrl };
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  const host = parsed.hostname.toLowerCase();

  switch (provider) {
    case "ashby": {
      const organization = pathname.split("/").filter(Boolean).at(-1);
      return organization ? { careersUrl, organization } : { careersUrl };
    }
    case "greenhouse": {
      const parts = pathname.split("/").filter(Boolean);
      const boardToken = parts.at(-1);
      return boardToken ? { careersUrl, boardToken } : { careersUrl };
    }
    case "lever": {
      const site = pathname.split("/").filter(Boolean).at(-1);
      return site ? { careersUrl, site } : { careersUrl };
    }
    case "teamtailor": {
      return { careersUrl, host };
    }
    case "workday": {
      return { careersUrl, host };
    }
    case "icims":
    case "jobvite":
    case "applicantpro":
    case "applytojob":
    case "theapplicantmanager":
    case "recruitee":
    case "ultipro":
    case "taleo":
    case "breezy":
    case "applicantai":
    case "careerplug":
    case "careerpuck":
    case "fountain":
    case "getro":
    case "hrmdirect":
    case "talentlyft":
    case "talexio":
    case "talentreef":
    case "manatal":
    case "zoho":
    case "bamboohr":
    case "gem":
    case "jobaps":
    case "join":
    case "saphrcloud":
      return { careersUrl };
    default:
      return { careersUrl };
  }
}

const db = new DatabaseSync(generatedAtsDbPath, { readonly: true });
const existingSourcesRaw = JSON.parse(await fs.readFile(existingSourcesPath, "utf8"));
const existingSources = Array.isArray(existingSourcesRaw?.sources) ? existingSourcesRaw.sources : [];
const existingKeys = new Set(existingSources.map((source) => String(source.key || "").trim()));
const existingProviderCompanies = new Set(
  existingSources.map((source) => `${normalizeKey(source.company)}::${String(source.provider || "").trim().toLowerCase()}`)
);

const rows = db.prepare(`
  SELECT company_name, url_string, ATS_name
  FROM companies
  WHERE company_name IS NOT NULL AND company_name <> ''
    AND url_string IS NOT NULL AND url_string <> ''
    AND ATS_name IS NOT NULL AND ATS_name <> ''
  ORDER BY ATS_name, company_name
`).all();

const candidates = [];
for (const row of rows) {
  const provider = ATS_PROVIDER_MAP.get(String(row.ATS_name || "").trim());
  if (!provider) {
    continue;
  }

  const company = toTitle(row.company_name);
  const dedupeKey = `${normalizeKey(company)}::${provider}`;
  if (existingProviderCompanies.has(dedupeKey)) {
    continue;
  }

  const providerFields = parseProviderSpecificFields(provider, row.url_string);
  if (!providerFields) {
    continue;
  }

  let key = buildSourceKey(company, provider);
  let suffix = 2;
  while (existingKeys.has(key) || candidates.some((candidate) => candidate.key === key)) {
    key = `${buildSourceKey(company, provider)}-${suffix}`;
    suffix += 1;
  }

  candidates.push({
    key,
    company,
    provider,
    importedFrom: "generated_ats_reference/jobs.db",
    generatedAtsName: row.ATS_name,
    ...providerFields,
  });
}

const byProvider = candidates.reduce((acc, source) => {
  acc[source.provider] = (acc[source.provider] || 0) + 1;
  return acc;
}, {});

const payload = {
  generatedAt: new Date().toISOString(),
  source: generatedAtsDbPath,
  totalCandidates: candidates.length,
  byProvider,
  sources: candidates,
};

await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  outputPath,
  totalCandidates: candidates.length,
  byProvider,
}, null, 2));

