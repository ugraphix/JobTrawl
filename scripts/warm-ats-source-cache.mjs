import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadSourceConfig } from "../src/lib/config.js";
import { getCacheDbPath } from "../src/lib/cache-db.js";
import { expandKeywordQueriesForSearch } from "../src/lib/filters.js";

const REPORT_PATH = path.join(process.cwd(), "data", "cache-warm-report.json");
const RECENT_CACHE_WINDOW_MS = 6 * 60 * 60 * 1000;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.reportOnly) {
    throw new Error("Only --report-only mode is implemented in this phase.");
  }

  const allSources = dedupeSources(await loadSourceConfig());
  const cacheSnapshot = readCacheSnapshot();
  const selectedSources = selectSources(allSources, cacheSnapshot, options);
  const selectedKeys = new Set(selectedSources.map((source) => source.key));
  const selectedCacheRows = cacheSnapshot.sources.filter((row) => selectedKeys.has(row.sourceKey));
  const selectedCachedKeys = new Set(selectedCacheRows.filter((row) => row.cachedJobs > 0).map((row) => row.sourceKey));
  const recentCutoff = Date.now() - RECENT_CACHE_WINDOW_MS;
  const recentlyCachedKeys = new Set(
    selectedCacheRows
      .filter((row) => Number(row.lastSyncedAt || 0) >= recentCutoff)
      .map((row) => row.sourceKey)
  );

  const priorityKeys = options.keyword
    ? rankSourcesForKeyword(allSources, cacheSnapshot, options.keyword).slice(0, Math.max(options.limit || 100, 100))
    : [];
  const selectedPriorityKeySet = new Set(priorityKeys.map((item) => item.sourceKey));
  const estimatedWarmOrder = selectedSources
    .map((source) => {
      const cacheRow = cacheSnapshot.bySourceKey.get(source.key);
      const priority = selectedPriorityKeySet.has(source.key) ? 0 : selectedCachedKeys.has(source.key) ? 2 : 1;
      return {
        sourceKey: source.key,
        provider: source.provider,
        company: source.company || source.name || "",
        cachedJobs: Number(cacheRow?.cachedJobs || 0),
        lastSyncedAt: cacheRow?.lastSyncedAt || null,
        lastError: cacheRow?.lastError || null,
        priority,
      };
    })
    .sort(compareWarmOrder)
    .slice(0, options.limit || selectedSources.length);

  const report = {
    mode: "report-only",
    reportPath: path.relative(process.cwd(), REPORT_PATH),
    options,
    cacheDbPath: getCacheDbPath(),
    totals: {
      runtimeSources: allSources.length,
      selectedSources: selectedSources.length,
      cachedSourcesSelected: selectedSources.filter((source) => selectedCachedKeys.has(source.key)).length,
      recentlyCachedSourcesSelected: selectedSources.filter((source) => recentlyCachedKeys.has(source.key)).length,
      uncachedSourcesSelected: selectedSources.filter((source) => !selectedCachedKeys.has(source.key)).length,
      cachedJobsSelected: selectedCacheRows.reduce((sum, row) => sum + Number(row.cachedJobs || 0), 0),
    },
    selectedSourcesByProvider: countSourcesByProvider(selectedSources),
    cacheCoverageByProvider: buildCoverageByProvider(selectedSources, cacheSnapshot),
    recentlyCachedByProvider: countSourcesByProvider(
      selectedSources.filter((source) => recentlyCachedKeys.has(source.key))
    ),
    uncachedByProvider: countSourcesByProvider(
      selectedSources.filter((source) => !selectedCachedKeys.has(source.key))
    ),
    keywordPrioritySources: priorityKeys.slice(0, 25),
    estimatedWarmOrder: estimatedWarmOrder.slice(0, 100),
  };

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    reportOnly: true,
    reportPath: report.reportPath,
    totals: report.totals,
    selectedSourcesByProvider: report.selectedSourcesByProvider,
    cacheCoverageByProvider: report.cacheCoverageByProvider,
    keywordPrioritySources: report.keywordPrioritySources.slice(0, 10),
    estimatedWarmOrder: report.estimatedWarmOrder.slice(0, 10),
  }, null, 2));
}

function parseArgs(argv) {
  const options = {
    reportOnly: false,
    providers: [],
    limit: 0,
    keyword: "",
    resume: false,
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    if (arg === "--report-only") {
      options.reportOnly = true;
    } else if (arg === "--provider") {
      const provider = normalizeProvider(argv[index + 1]);
      if (provider) options.providers.push(provider);
      index += 1;
    } else if (arg.startsWith("--provider=")) {
      const provider = normalizeProvider(arg.split("=").slice(1).join("="));
      if (provider) options.providers.push(provider);
    } else if (arg === "--limit") {
      options.limit = toPositiveInt(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--limit=")) {
      options.limit = toPositiveInt(arg.split("=").slice(1).join("="));
    } else if (arg === "--keyword") {
      options.keyword = String(argv[index + 1] || "").trim();
      index += 1;
    } else if (arg.startsWith("--keyword=")) {
      options.keyword = String(arg.split("=").slice(1).join("=") || "").trim();
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--force") {
      options.force = true;
    }
  }

  options.providers = [...new Set(options.providers)];
  return options;
}

function dedupeSources(sources) {
  const byKey = new Map();
  for (const source of sources) {
    const key = String(source?.key || "").trim();
    if (!key || byKey.has(key)) {
      continue;
    }
    byKey.set(key, source);
  }
  return [...byKey.values()];
}

function selectSources(sources, cacheSnapshot, options) {
  const providerSet = new Set(options.providers);
  const filtered = providerSet.size > 0
    ? sources.filter((source) => providerSet.has(normalizeProvider(source.provider)))
    : sources;
  const ranked = rankSelectedSources(filtered, cacheSnapshot, options.keyword);
  return options.limit > 0 ? ranked.slice(0, options.limit) : ranked;
}

function rankSelectedSources(sources, cacheSnapshot, keyword) {
  const keywordRanks = keyword
    ? new Map(rankSourcesForKeyword(sources, cacheSnapshot, keyword).map((item, index) => [item.sourceKey, index]))
    : new Map();

  return [...sources].sort((left, right) => {
    const leftRank = keywordRanks.has(left.key) ? keywordRanks.get(left.key) : Number.MAX_SAFE_INTEGER;
    const rightRank = keywordRanks.has(right.key) ? keywordRanks.get(right.key) : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;

    const leftCache = cacheSnapshot.bySourceKey.get(left.key);
    const rightCache = cacheSnapshot.bySourceKey.get(right.key);
    const leftCached = Number(leftCache?.cachedJobs || 0) > 0 ? 1 : 0;
    const rightCached = Number(rightCache?.cachedJobs || 0) > 0 ? 1 : 0;
    if (leftCached !== rightCached) return leftCached - rightCached;

    return String(left.provider || "").localeCompare(String(right.provider || ""))
      || String(left.key || "").localeCompare(String(right.key || ""));
  });
}

function readCacheSnapshot() {
  const dbPath = getCacheDbPath();
  if (!existsSync(dbPath)) {
    return {
      sources: [],
      bySourceKey: new Map(),
      keywordRows: [],
    };
  }

  const db = new DatabaseSync(dbPath, { readonly: true });
  const now = Date.now();
  const sourceRows = db.prepare(`
    SELECT
      state.source_key AS sourceKey,
      state.provider AS provider,
      state.company AS company,
      state.last_synced_at AS lastSyncedAt,
      state.last_job_count AS lastJobCount,
      state.last_error AS lastError,
      COUNT(postings.id) AS cachedJobs,
      MAX(COALESCE(postings.posted_at, postings.updated_at, '')) AS latestCachedDate
    FROM source_cache_state AS state
    LEFT JOIN cached_postings AS postings
      ON postings.source_key = state.source_key
      AND postings.expires_at > ?
    GROUP BY state.source_key, state.provider, state.company, state.last_synced_at, state.last_job_count, state.last_error
  `).all(now).map(normalizeCacheRow);

  const postingRows = db.prepare(`
    SELECT source_key AS sourceKey, provider, title, company, posted_at AS postedAt, updated_at AS updatedAt
    FROM cached_postings
    WHERE expires_at > ?
  `).all(now);

  return {
    sources: sourceRows,
    bySourceKey: new Map(sourceRows.map((row) => [row.sourceKey, row])),
    keywordRows: postingRows.map((row) => ({
      sourceKey: String(row.sourceKey || ""),
      provider: String(row.provider || ""),
      company: String(row.company || ""),
      title: String(row.title || ""),
      postedAt: row.postedAt || null,
      updatedAt: row.updatedAt || null,
    })),
  };
}

function normalizeCacheRow(row) {
  return {
    sourceKey: String(row?.sourceKey || ""),
    provider: String(row?.provider || ""),
    company: String(row?.company || ""),
    lastSyncedAt: Number(row?.lastSyncedAt || 0) || null,
    lastJobCount: Number(row?.lastJobCount || 0),
    lastError: row?.lastError || null,
    cachedJobs: Number(row?.cachedJobs || 0),
    latestCachedDate: row?.latestCachedDate || null,
  };
}

function rankSourcesForKeyword(sources, cacheSnapshot, keyword) {
  const sourceSet = new Set(sources.map((source) => source.key));
  const phrases = expandKeywordQueriesForSearch(keyword)
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (phrases.length === 0) {
    return [];
  }

  const scores = new Map();
  for (const row of cacheSnapshot.keywordRows) {
    if (!sourceSet.has(row.sourceKey)) {
      continue;
    }
    const title = row.title.toLowerCase();
    const matchedPhrase = phrases.find((phrase) => title.includes(phrase));
    if (!matchedPhrase) {
      continue;
    }
    const existing = scores.get(row.sourceKey) || {
      sourceKey: row.sourceKey,
      provider: row.provider,
      company: row.company,
      matchedCachedTitles: 0,
      sampleTitles: [],
      latestDate: "",
    };
    existing.matchedCachedTitles += 1;
    if (existing.sampleTitles.length < 5 && !existing.sampleTitles.includes(row.title)) {
      existing.sampleTitles.push(row.title);
    }
    existing.latestDate = maxDateString(existing.latestDate, row.postedAt || row.updatedAt || "");
    scores.set(row.sourceKey, existing);
  }

  return [...scores.values()].sort((left, right) =>
    right.matchedCachedTitles - left.matchedCachedTitles
    || String(right.latestDate || "").localeCompare(String(left.latestDate || ""))
    || left.provider.localeCompare(right.provider)
    || left.sourceKey.localeCompare(right.sourceKey)
  );
}

function buildCoverageByProvider(sources, cacheSnapshot) {
  const grouped = new Map();
  for (const source of sources) {
    const provider = normalizeProvider(source.provider) || "unknown";
    const row = grouped.get(provider) || {
      configuredSources: 0,
      cachedSources: 0,
      recentlyCachedSources: 0,
      uncachedSources: 0,
      cachedJobs: 0,
      errorSources: 0,
    };
    const cacheRow = cacheSnapshot.bySourceKey.get(source.key);
    const cachedJobs = Number(cacheRow?.cachedJobs || 0);
    row.configuredSources += 1;
    row.cachedSources += cachedJobs > 0 ? 1 : 0;
    row.cachedJobs += cachedJobs;
    row.errorSources += cacheRow?.lastError ? 1 : 0;
    if (cacheRow?.lastSyncedAt && Number(cacheRow.lastSyncedAt) >= Date.now() - RECENT_CACHE_WINDOW_MS) {
      row.recentlyCachedSources += 1;
    }
    grouped.set(provider, row);
  }

  for (const row of grouped.values()) {
    row.uncachedSources = row.configuredSources - row.cachedSources;
  }

  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function countSourcesByProvider(sources) {
  const counts = new Map();
  for (const source of sources) {
    const provider = normalizeProvider(source.provider) || "unknown";
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function compareWarmOrder(left, right) {
  return left.priority - right.priority
    || Number(left.cachedJobs > 0) - Number(right.cachedJobs > 0)
    || String(left.provider || "").localeCompare(String(right.provider || ""))
    || String(left.sourceKey || "").localeCompare(String(right.sourceKey || ""));
}

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function maxDateString(left, right) {
  return String(right || "").localeCompare(String(left || "")) > 0 ? right : left;
}
