import { ensureSourcesCached, initCacheDb } from "../src/lib/cache-db.js";
import { loadSourceConfig } from "../src/lib/config.js";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  initCacheDb();
  const allSources = await loadSourceConfig();
  const generatedSources = allSources.filter((source) => source.generatedInventory || source.inventorySource === "openpostings");

  let filtered = generatedSources;

  if (args.provider) {
    filtered = filtered.filter((source) => String(source.provider || "").toLowerCase() === args.provider);
  }

  if (args.collectionKey) {
    filtered = filtered.filter((source) => String(source.atsCollectionKey || "") === args.collectionKey);
  }

  if (args.companyQuery) {
    const query = args.companyQuery;
    filtered = filtered.filter((source) => String(source.company || "").toLowerCase().includes(query));
  }

  const sliced = filtered.slice(args.offset, args.offset + args.limit);
  const result = await ensureSourcesCached(sliced, {}, { forceSync: true });

  console.log(JSON.stringify({
    requestedGeneratedSources: generatedSources.length,
    matchedSources: filtered.length,
    syncedBatchSize: sliced.length,
    provider: args.provider || null,
    collectionKey: args.collectionKey || null,
    companyQuery: args.companyQuery || null,
    offset: args.offset,
    limit: args.limit,
    syncedSources: result.syncedSources,
    failedSources: result.failedSources,
    attemptedSources: result.attemptedSources,
    cachedJobs: result.cachedJobs,
    cachedSources: result.cachedSources,
    errors: result.errors,
  }, null, 2));
}

function parseArgs(argv) {
  const parsed = {
    provider: "",
    collectionKey: "",
    companyQuery: "",
    offset: 0,
    limit: 100,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    const next = String(argv[index + 1] || "");

    if (arg === "--provider") {
      parsed.provider = next.trim().toLowerCase();
      index += 1;
      continue;
    }
    if (arg === "--collection") {
      parsed.collectionKey = next.trim();
      index += 1;
      continue;
    }
    if (arg === "--company") {
      parsed.companyQuery = next.trim().toLowerCase();
      index += 1;
      continue;
    }
    if (arg === "--offset") {
      parsed.offset = toNonNegativeInt(next, 0);
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      parsed.limit = toPositiveInt(next, 100);
      index += 1;
      continue;
    }
  }

  return parsed;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
