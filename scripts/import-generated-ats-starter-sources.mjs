import { promises as fs } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const sourcesPath = path.join(rootDir, "config", "sources.json");
const candidatesPath = path.join(rootDir, "config", "generated-ats-source-candidates.json");

const TARGET_PROVIDERS = [
  "theapplicantmanager",
  "recruitee",
  "taleo",
  "breezy",
  "applicantai",
  "careerplug",
  "careerpuck",
  "fountain",
  "getro",
  "hrmdirect",
  "talentlyft",
  "talexio",
  "teamtailor",
  "talentreef",
  "manatal",
  "zoho",
  "bamboohr",
  "gem",
  "jobaps",
  "join",
  "saphrcloud",
];

const MAX_PER_PROVIDER = 5;

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

const sourcesPayload = JSON.parse(await fs.readFile(sourcesPath, "utf8"));
const candidatesPayload = JSON.parse(await fs.readFile(candidatesPath, "utf8"));

const existingSources = Array.isArray(sourcesPayload.sources) ? sourcesPayload.sources : [];
const candidateSources = Array.isArray(candidatesPayload.sources) ? candidatesPayload.sources : [];

const existingProviders = new Set(existingSources.map((source) => normalizeKey(source.provider)));
const existingKeys = new Set(existingSources.map((source) => String(source.key || "").trim()));

const inserted = [];

for (const provider of TARGET_PROVIDERS) {
  if (existingProviders.has(provider)) {
    continue;
  }

  const providerCandidates = candidateSources
    .filter((source) => normalizeKey(source.provider) === provider && !existingKeys.has(source.key))
    .slice(0, MAX_PER_PROVIDER);

  for (const candidate of providerCandidates) {
    existingSources.push(candidate);
    existingKeys.add(candidate.key);
    inserted.push(candidate);
  }
}

sourcesPayload.sources = existingSources;
await fs.writeFile(sourcesPath, `${JSON.stringify(sourcesPayload, null, 2)}\n`, "utf8");

const byProvider = inserted.reduce((acc, source) => {
  acc[source.provider] = (acc[source.provider] || 0) + 1;
  return acc;
}, {});

console.log(JSON.stringify({
  inserted: inserted.length,
  byProvider,
  sampleKeys: inserted.slice(0, 20).map((source) => source.key),
}, null, 2));

