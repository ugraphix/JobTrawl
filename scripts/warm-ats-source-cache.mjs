import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadSourceConfig } from "../src/lib/config.js";
import { ensureSourcesCached, getCacheDbPath } from "../src/lib/cache-db.js";
import { expandKeywordQueriesForSearch } from "../src/lib/filters.js";

const REPORT_PATH = path.join(process.cwd(), "data", "cache-warm-report.json");
const PROGRESS_PATH = path.join(process.cwd(), "data", "cache-warm-progress.json");
const RECENT_CACHE_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_LIVE_RETRIES = 2;
const DEFAULT_LIVE_CONCURRENCY = 3;
const DEFAULT_LIVE_TIMEOUT_MS = 15_000;
const PROVIDER_SETTINGS = {
  applicantpro: { concurrency: 4, timeoutMs: 15_000 },
  applytojob: { concurrency: 4, timeoutMs: 15_000 },
  ashby: { concurrency: 8, timeoutMs: 10_000 },
  bamboohr: { concurrency: 5, timeoutMs: 10_000 },
  breezy: { concurrency: 3, timeoutMs: 15_000 },
  greenhouse: { concurrency: 8, timeoutMs: 10_000 },
  hrmdirect: { concurrency: 4, timeoutMs: 15_000 },
  icims: { concurrency: 2, timeoutMs: 20_000 },
  jobvite: { concurrency: 3, timeoutMs: 15_000 },
  join: { concurrency: 2, timeoutMs: 15_000 },
  lever: { concurrency: 8, timeoutMs: 10_000 },
  manatal: { concurrency: 2, timeoutMs: 20_000 },
  recruitee: { concurrency: 4, timeoutMs: 15_000 },
  teamtailor: { concurrency: 3, timeoutMs: 15_000 },
  workday: { concurrency: 2, timeoutMs: 20_000 },
  zoho: { concurrency: 3, timeoutMs: 15_000 },
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const allSources = dedupeSources(await loadSourceConfig());
  const beforeSnapshot = readCacheSnapshot();
  const selectedSources = selectSources(allSources, beforeSnapshot, options);

  if (!options.reportOnly) {
    validateLiveWarmOptions(options);
  }

  const liveSummary = options.reportOnly
    ? null
    : await runLiveWarm(selectedSources, beforeSnapshot, options);
  const cacheSnapshot = options.reportOnly ? beforeSnapshot : readCacheSnapshot();
  const report = buildReport({
    allSources,
    selectedSources,
    cacheSnapshot,
    options,
    beforeSnapshot,
    liveSummary,
  });

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    reportOnly: options.reportOnly,
    reportPath: report.reportPath,
    progressPath: liveSummary ? path.relative(process.cwd(), PROGRESS_PATH) : null,
    totals: report.totals,
    selectedSourcesByProvider: report.selectedSourcesByProvider,
    cacheCoverageByProvider: report.cacheCoverageByProvider,
    liveSummary: liveSummary ? summarizeLiveForConsole(liveSummary) : null,
    keywordPrioritySources: report.keywordPrioritySources.slice(0, 10),
    estimatedWarmOrder: report.estimatedWarmOrder.slice(0, 10),
  }, null, 2));
}

function buildReport({ allSources, selectedSources, cacheSnapshot, options, beforeSnapshot = cacheSnapshot, liveSummary = null }) {
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

  return {
    mode: options.reportOnly ? "report-only" : "live",
    reportPath: path.relative(process.cwd(), REPORT_PATH),
    progressPath: liveSummary ? path.relative(process.cwd(), PROGRESS_PATH) : null,
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
    liveSummary,
    beforeAfterCacheCoverageByProvider: liveSummary
      ? buildBeforeAfterCoverageByProvider(selectedSources, beforeSnapshot, cacheSnapshot)
      : null,
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
}

function parseArgs(argv) {
  const options = {
    reportOnly: false,
    providers: [],
    limit: 0,
    keyword: "",
    resume: false,
    force: false,
    all: false,
    strategy: "uncached",
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
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--strategy") {
      options.strategy = normalizeStrategy(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--strategy=")) {
      options.strategy = normalizeStrategy(arg.split("=").slice(1).join("="));
    }
  }

  options.providers = [...new Set(options.providers)];
  return options;
}

function validateLiveWarmOptions(options) {
  if (!options.all && options.providers.length === 0) {
    throw new Error("Live warming requires --provider <provider> or --all. Use --report-only for a dry run.");
  }
  if (!options.all && options.limit <= 0) {
    throw new Error("Provider-limited live warming requires --limit <n> in this phase.");
  }
  if (options.all && options.limit <= 0) {
    throw new Error("Full 32k-source live warming is not enabled in this phase. Add --limit for a bounded live run.");
  }
}

async function runLiveWarm(selectedSources, beforeSnapshot, options) {
  const startedAt = Date.now();
  const selectedBeforeRows = new Set(selectedSources.map((source) => source.key));
  const beforeSelectedCacheRows = beforeSnapshot.sources.filter((row) => selectedBeforeRows.has(row.sourceKey));
  const beforeCachedSelectedSources = beforeSelectedCacheRows.filter((row) => row.cachedJobs > 0).length;
  const beforeCachedTotalSources = beforeSnapshot.sources.filter((row) => row.cachedJobs > 0).length;
  const state = {
    startedAt,
    updatedAt: startedAt,
    selectedSources: selectedSources.length,
    completedSources: 0,
    sourcesWarmed: 0,
    parsedJobsAdded: 0,
    classifications: initClassificationCounts(),
    results: [],
  };

  await mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  await writeProgress(state);

  const groups = groupSourcesByProvider(selectedSources);
  for (const [provider, sources] of groups) {
    const settings = getProviderSettings(provider);
    await runWithConcurrency(sources, settings.concurrency, async (source) => {
      const result = await warmSingleSource(source, settings, options);
      state.completedSources += 1;
      state.sourcesWarmed += result.synced ? 1 : 0;
      state.classifications[result.classification] = (state.classifications[result.classification] || 0) + 1;
      state.results.push(result);
      state.updatedAt = Date.now();
      await writeProgress(state);
    });
  }

  const afterSnapshot = readCacheSnapshot();
  const afterRowsBySource = afterSnapshot.bySourceKey;
  let parsedJobsAdded = 0;
  for (const source of selectedSources) {
    const beforeJobs = Number(beforeSnapshot.bySourceKey.get(source.key)?.cachedJobs || 0);
    const afterJobs = Number(afterRowsBySource.get(source.key)?.cachedJobs || 0);
    if (afterJobs > beforeJobs) {
      parsedJobsAdded += afterJobs - beforeJobs;
    }
  }
  state.parsedJobsAdded = parsedJobsAdded;
  state.elapsedMs = Date.now() - startedAt;
  state.afterCachedSelectedSources = selectedSources
    .filter((source) => Number(afterRowsBySource.get(source.key)?.cachedJobs || 0) > 0)
    .length;
  state.beforeCachedSelectedSources = beforeCachedSelectedSources;
  state.beforeCachedTotalSources = beforeCachedTotalSources;
  state.afterCachedTotalSources = afterSnapshot.sources.filter((row) => row.cachedJobs > 0).length;
  state.updatedAt = Date.now();
  await writeProgress(state);
  return state;
}

async function warmSingleSource(source, settings, options) {
  let lastError = null;
  const attempts = [];
  for (let attempt = 0; attempt <= MAX_LIVE_RETRIES; attempt += 1) {
    const startedAt = Date.now();
    const result = await ensureSourcesCached([source], {}, {
      forceSync: options.force,
      concurrency: 1,
      timeoutMs: settings.timeoutMs,
    });
    const error = result.errors?.[0]?.error || null;
    attempts.push({
      attempt: attempt + 1,
      elapsedMs: Date.now() - startedAt,
      syncedSources: Number(result.syncedSources || 0),
      failedSources: Number(result.failedSources || 0),
      error,
    });

    if (!error && Number(result.failedSources || 0) === 0) {
      const row = readCacheSnapshot().bySourceKey.get(source.key);
      return {
        sourceKey: source.key,
        provider: normalizeProvider(source.provider),
        company: source.company || source.name || "",
        synced: Number(result.syncedSources || 0) > 0,
        classification: Number(row?.cachedJobs || 0) > 0 ? "active_with_jobs" : "valid_empty",
        cachedJobs: Number(row?.cachedJobs || 0),
        lastJobCount: Number(row?.lastJobCount || 0),
        attempts,
      };
    }

    lastError = error || "Unknown cache warming failure";
    if (!shouldRetryError(lastError) || attempt >= MAX_LIVE_RETRIES) {
      break;
    }
    await sleep(getRetryDelayMs(attempt));
  }

  const row = readCacheSnapshot().bySourceKey.get(source.key);
  return {
    sourceKey: source.key,
    provider: normalizeProvider(source.provider),
    company: source.company || source.name || "",
    synced: false,
    classification: classifyError(lastError, row),
    cachedJobs: Number(row?.cachedJobs || 0),
    lastJobCount: Number(row?.lastJobCount || 0),
    error: lastError,
    attempts,
  };
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
  if (options.strategy === "stratified") {
    return selectStratifiedSources(filtered, options.limit);
  }
  if (options.strategy === "active-history") {
    return selectActiveHistorySources(filtered, cacheSnapshot, options.limit);
  }
  const ranked = rankSelectedSources(filtered, cacheSnapshot, options.keyword);
  return options.limit > 0 ? ranked.slice(0, options.limit) : ranked;
}

function selectStratifiedSources(sources, limit) {
  const sorted = [...sources].sort(compareSourceIdentity);
  if (limit <= 0 || sorted.length <= limit) {
    return sorted;
  }
  if (limit === 1) {
    return [sorted[0]];
  }

  const selected = [];
  const seen = new Set();
  const step = (sorted.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) {
    const source = sorted[Math.round(index * step)];
    if (source && !seen.has(source.key)) {
      selected.push(source);
      seen.add(source.key);
    }
  }

  for (const source of sorted) {
    if (selected.length >= limit) {
      break;
    }
    if (!seen.has(source.key)) {
      selected.push(source);
      seen.add(source.key);
    }
  }
  return selected;
}

function selectActiveHistorySources(sources, cacheSnapshot, limit) {
  const ranked = [...sources].sort((left, right) => {
    const leftCache = cacheSnapshot.bySourceKey.get(left.key);
    const rightCache = cacheSnapshot.bySourceKey.get(right.key);
    const leftJobs = Number(leftCache?.cachedJobs || leftCache?.lastJobCount || 0);
    const rightJobs = Number(rightCache?.cachedJobs || rightCache?.lastJobCount || 0);
    return rightJobs - leftJobs || compareSourceIdentity(left, right);
  });
  return limit > 0 ? ranked.slice(0, limit) : ranked;
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

function buildBeforeAfterCoverageByProvider(sources, beforeSnapshot, afterSnapshot) {
  const providers = new Set(sources.map((source) => normalizeProvider(source.provider) || "unknown"));
  const before = buildCoverageByProvider(sources, beforeSnapshot);
  const after = buildCoverageByProvider(sources, afterSnapshot);
  const rows = {};
  for (const provider of [...providers].sort()) {
    rows[provider] = {
      before: before[provider] || emptyCoverageRow(),
      after: after[provider] || emptyCoverageRow(),
      delta: {
        cachedSources: Number(after[provider]?.cachedSources || 0) - Number(before[provider]?.cachedSources || 0),
        cachedJobs: Number(after[provider]?.cachedJobs || 0) - Number(before[provider]?.cachedJobs || 0),
        errorSources: Number(after[provider]?.errorSources || 0) - Number(before[provider]?.errorSources || 0),
      },
    };
  }
  return rows;
}

function emptyCoverageRow() {
  return {
    configuredSources: 0,
    cachedSources: 0,
    recentlyCachedSources: 0,
    uncachedSources: 0,
    cachedJobs: 0,
    errorSources: 0,
  };
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

function compareSourceIdentity(left, right) {
  return String(left.provider || "").localeCompare(String(right.provider || ""))
    || String(left.key || "").localeCompare(String(right.key || ""));
}

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStrategy(value) {
  const strategy = String(value || "").trim().toLowerCase();
  return ["uncached", "stratified", "keyword-priority", "active-history"].includes(strategy)
    ? strategy
    : "uncached";
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function maxDateString(left, right) {
  return String(right || "").localeCompare(String(left || "")) > 0 ? right : left;
}

function initClassificationCounts() {
  return {
    active_with_jobs: 0,
    valid_empty: 0,
    invalid_endpoint: 0,
    parser_gap: 0,
    blocked: 0,
    rate_limited: 0,
    timeout: 0,
    failed: 0,
  };
}

function groupSourcesByProvider(sources) {
  const groups = new Map();
  for (const source of sources) {
    const provider = normalizeProvider(source.provider) || "unknown";
    if (!groups.has(provider)) {
      groups.set(provider, []);
    }
    groups.get(provider).push(source);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function getProviderSettings(provider) {
  return PROVIDER_SETTINGS[normalizeProvider(provider)] || {
    concurrency: DEFAULT_LIVE_CONCURRENCY,
    timeoutMs: DEFAULT_LIVE_TIMEOUT_MS,
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  const normalizedConcurrency = Math.max(1, Number(concurrency) || 1);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(normalizedConcurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function writeProgress(state) {
  await writeFile(PROGRESS_PATH, `${JSON.stringify({
    ...state,
    startedAt: new Date(state.startedAt).toISOString(),
    updatedAt: new Date(state.updatedAt).toISOString(),
    results: state.results.slice(-100),
  }, null, 2)}\n`, "utf8");
}

function shouldRetryError(error) {
  const text = String(error || "");
  if (/\b(?:400|401|403|404)\b|invalid url|malformed|not found/i.test(text)) {
    return false;
  }
  return /\b(?:408|429|502|503|504)\b|ECONNRESET|ETIMEDOUT|timeout|timed out|network reset|fetch failed|socket hang up/i.test(text);
}

function classifyError(error, cacheRow) {
  if (cacheRow && Number(cacheRow.cachedJobs || 0) > 0) {
    return "active_with_jobs";
  }
  const text = String(error || cacheRow?.lastError || "");
  if (/\b429\b|rate.?limit/i.test(text)) return "rate_limited";
  if (/\b408\b|timeout|timed out|ETIMEDOUT|AbortError/i.test(text)) return "timeout";
  if (/\b403\b|blocked|forbidden|captcha|cloudflare/i.test(text)) return "blocked";
  if (/\b(?:400|401|404)\b|invalid endpoint|invalid url|malformed|not found|ENOTFOUND/i.test(text)) {
    return "invalid_endpoint";
  }
  if (/parser|parse|unexpected token|job markers|shell|selector|structure/i.test(text)) {
    return "parser_gap";
  }
  return "failed";
}

function getRetryDelayMs(attempt) {
  return 1_000 * (attempt + 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeLiveForConsole(liveSummary) {
  return {
    selectedSources: liveSummary.selectedSources,
    completedSources: liveSummary.completedSources,
    sourcesWarmed: liveSummary.sourcesWarmed,
    parsedJobsAdded: liveSummary.parsedJobsAdded,
    beforeCachedSelectedSources: liveSummary.beforeCachedSelectedSources,
    afterCachedSelectedSources: liveSummary.afterCachedSelectedSources,
    beforeCachedTotalSources: liveSummary.beforeCachedTotalSources,
    afterCachedTotalSources: liveSummary.afterCachedTotalSources,
    classifications: liveSummary.classifications,
    elapsedMs: liveSummary.elapsedMs,
  };
}
