import { readFile } from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const inventoryPath = path.join(cwd, "config", "sanitized-ats-source-inventory.json");

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "sourceCount",
  "providerCounts",
  "skippedCounts",
  "duplicateCountsByProvider",
  "invalidUrlCountsByProvider",
  "sources",
]);

const SOURCE_KEYS = new Set([
  "apiUrl",
  "boardSlug",
  "boardToken",
  "boardUrl",
  "careersUrl",
  "company",
  "companyCode",
  "companyIdentifier",
  "companySlug",
  "domainSlug",
  "host",
  "jobsUrl",
  "organization",
  "portalUrl",
  "provider",
  "searchUrl",
  "site",
  "slug",
  "sourceKey",
  "subdomain",
  "tenant",
]);

const FORBIDDEN_TEXT_PATTERNS = [
  { name: "local Windows path", pattern: /[A-Za-z]:\\/ },
  { name: "Users path segment", pattern: /\bUsers[\\/]/i },
  { name: "OneDrive path segment", pattern: /\bOneDrive[\\/]/i },
  { name: "_vendor_openlistings reference", pattern: /_vendor_openlistings/i },
  { name: "jobs.db reference", pattern: /jobs\.db/i },
  { name: "sqlite reference", pattern: /sqlite/i },
  { name: "tmp-greenhouse-inertia reference", pattern: /tmp-greenhouse-inertia/i },
  { name: "job description field", pattern: /descriptionSnippet|jobDescription|description|searchText/i },
  { name: "raw HTML", pattern: /<\s*(?:!doctype|html|script|body|div|span|section|article|a)\b/i },
  { name: "captured JavaScript bundle", pattern: /\b(?:webpackJsonp|__NEXT_DATA__|window\.__|vitePreload|chunk\.js)\b/i },
  { name: "cookie field", pattern: /\bcookie\b/i },
  { name: "token field", pattern: /access[_-]?token|auth[_-]?token|bearer\s+[a-z0-9._-]+/i },
  { name: "secret field", pattern: /"[^"]*(?:client[_-]?secret|api[_-]?secret|password)[^"]*"\s*:/i },
];

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const raw = await readFile(inventoryPath, "utf8");
  const failures = [];

  for (const item of FORBIDDEN_TEXT_PATTERNS) {
    if (item.pattern.test(raw)) {
      failures.push(`Forbidden content detected: ${item.name}`);
    }
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    failures.push(`Invalid JSON: ${error.message}`);
  }

  if (payload) {
    validatePayload(payload, failures);
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({ valid: false, failures }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    valid: true,
    sourceCount: payload.sources.length,
    providerCounts: payload.providerCounts,
    checkedAllowlist: true,
    forbiddenContentDetected: false,
  }, null, 2));
}

function validatePayload(payload, failures) {
  for (const key of Object.keys(payload)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      failures.push(`Unexpected top-level field: ${key}`);
    }
  }

  if (!Array.isArray(payload.sources)) {
    failures.push("sources must be an array");
    return;
  }

  if (payload.sourceCount !== payload.sources.length) {
    failures.push(`sourceCount ${payload.sourceCount} does not match sources length ${payload.sources.length}`);
  }

  const seenKeys = new Set();
  for (const [index, source] of payload.sources.entries()) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      failures.push(`Source at index ${index} must be an object`);
      continue;
    }

    for (const key of Object.keys(source)) {
      if (!SOURCE_KEYS.has(key)) {
        failures.push(`Unexpected source field at index ${index}: ${key}`);
      }
    }

    for (const requiredKey of ["provider", "sourceKey", "company", "careersUrl"]) {
      if (!source[requiredKey] || typeof source[requiredKey] !== "string") {
        failures.push(`Source at index ${index} missing required string field: ${requiredKey}`);
      }
    }

    if (source.sourceKey) {
      if (seenKeys.has(source.sourceKey)) {
        failures.push(`Duplicate sourceKey: ${source.sourceKey}`);
      }
      seenKeys.add(source.sourceKey);
    }

    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "string") {
        failures.push(`Source ${source.sourceKey || index} field ${key} must be a string`);
      }
    }
  }

  const sorted = [...payload.sources].sort((left, right) =>
    left.provider.localeCompare(right.provider)
    || left.sourceKey.localeCompare(right.sourceKey)
  );
  for (let index = 0; index < sorted.length; index += 1) {
    if (payload.sources[index]?.sourceKey !== sorted[index]?.sourceKey) {
      failures.push("Sources are not stably sorted by provider/sourceKey");
      break;
    }
  }
}
