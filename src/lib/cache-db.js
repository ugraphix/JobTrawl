import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fetchJobsForSource } from "./adapters/index.js";
import {
  deriveEmployerCompany,
  deriveLocationMetadata,
  extractApplicationDeadlineFromText,
  extractPostedDateFromHtml,
  isGenericLocationLabel,
  normalizeDescriptionFetchUrl,
} from "./adapters/shared.js";
import { expandKeywordQueriesForSearch, inferWorkArrangement, RECENCY_WINDOWS } from "./filters.js";

const CACHE_DIR = path.join(process.cwd(), "data");
const CACHE_DB_PATH = path.join(CACHE_DIR, "jobs-cache.sqlite");
const JSON_CACHE_PATH = path.join(CACHE_DIR, "jobs-cache.json");
const DEFAULT_SYNC_INTERVAL_MS = Number(process.env.CACHE_SYNC_INTERVAL_MS || 30 * 60 * 1000);
const DEFAULT_SOURCE_MAX_AGE_MS = Number(process.env.CACHE_SOURCE_MAX_AGE_MS || 6 * 60 * 60 * 1000);
const DEFAULT_TTL_MS = Number(process.env.CACHE_POSTING_TTL_MS || 45 * 24 * 60 * 60 * 1000);
const DEFAULT_SYNC_CONCURRENCY = Math.max(1, Number(process.env.CACHE_SYNC_CONCURRENCY || 4));
const DEFAULT_SEARCH_CONCURRENCY = Math.max(1, Number(process.env.CACHE_SEARCH_CONCURRENCY || 20));
const DEFAULT_SOURCE_SEARCH_TIMEOUT_MS = Math.max(1000, Number(process.env.CACHE_SOURCE_SEARCH_TIMEOUT_MS || 4500));
const DEFAULT_SOURCE_SYNC_TIMEOUT_MS = Math.max(DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, Number(process.env.CACHE_SOURCE_SYNC_TIMEOUT_MS || 15000));
const DEFAULT_SEARCH_MAX_DURATION_MS = Math.max(DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, Number(process.env.CACHE_SEARCH_MAX_DURATION_MS || 30000));
const GENERATED_INVENTORY_WARM_BATCH_SIZE = Math.max(1, Number(process.env.GENERATED_INVENTORY_WARM_BATCH_SIZE || 60));
const REPOST_POSTED_GAP_MS = 24 * 60 * 60 * 1000;
const BULK_CACHE_ALL_SOURCES_THRESHOLD = 1000;
const BULK_UNKNOWN_DATE_LIMIT = 250;
const BULK_DATED_RESULT_LIMIT = Math.max(500, Number(process.env.BULK_DATED_RESULT_LIMIT || 4000));

let database = null;
let cacheBackend = "sqlite";
let jsonCache = {
  postings: [],
  sourceState: {},
  postingHistory: {},
};
let backgroundSyncTimer = null;
const sourceSyncPromises = new Map();

const syncStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  syncedSources: 0,
  totalSources: 0,
  totalCachedJobs: 0,
};

export function initCacheDb() {
  if (database || cacheBackend === "json") {
    return database;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    database = new DatabaseSync(CACHE_DB_PATH);
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS cached_postings (
        id INTEGER PRIMARY KEY,
        source_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        company TEXT NOT NULL,
        source_name TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        team TEXT,
        department TEXT,
        location_label TEXT,
        city TEXT,
        region TEXT,
        country TEXT,
        work_arrangement TEXT,
        posted_at TEXT,
        updated_at TEXT,
        date_status TEXT,
        apply_url TEXT NOT NULL,
        description_snippet TEXT,
        search_text TEXT,
        employment_type TEXT,
        compensation TEXT,
        raw_location_text TEXT,
        cached_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE(source_key, external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_cached_postings_source_key ON cached_postings(source_key);
      CREATE INDEX IF NOT EXISTS idx_cached_postings_company ON cached_postings(company);
      CREATE INDEX IF NOT EXISTS idx_cached_postings_posted_at ON cached_postings(posted_at);
      CREATE INDEX IF NOT EXISTS idx_cached_postings_expires_at ON cached_postings(expires_at);

      CREATE TABLE IF NOT EXISTS source_cache_state (
        source_key TEXT PRIMARY KEY,
        company TEXT NOT NULL,
        provider TEXT NOT NULL,
        last_synced_at INTEGER,
        last_job_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS posting_history (
        source_key TEXT NOT NULL,
        external_id TEXT NOT NULL,
        company TEXT NOT NULL,
        title TEXT NOT NULL,
        apply_url TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        missing_since INTEGER,
        first_posted_at TEXT,
        last_posted_at TEXT,
        last_reappeared_at INTEGER,
        reappearance_count INTEGER NOT NULL DEFAULT 0,
        last_date_refresh_at INTEGER,
        date_refresh_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_key, external_id)
      );
    `);
    cacheBackend = "sqlite";
  } catch (error) {
    database = null;
    cacheBackend = "json";
    syncStatus.lastError = `SQLite unavailable, using JSON cache fallback: ${error?.message || error}`;
    loadJsonCache();
  }

  pruneExpiredCache();
  return database;
}

export function getCacheDbPath() {
  return CACHE_DB_PATH;
}

export function getCacheStatus() {
  initCacheDb();

  let cachedJobs = 0;
  let cachedSources = 0;

  if (cacheBackend === "sqlite") {
    try {
      const stats = database.prepare(`
        SELECT
          COUNT(*) AS cachedJobs,
          COUNT(DISTINCT source_key) AS cachedSources
        FROM cached_postings
        WHERE expires_at > ?
      `).get(Date.now());
      cachedJobs = Number(stats?.cachedJobs || 0);
      cachedSources = Number(stats?.cachedSources || 0);
    } catch (error) {
      recoverToJsonCache(error);
      cachedJobs = jsonCache.postings.length;
      cachedSources = new Set(jsonCache.postings.map((posting) => posting.source_key)).size;
    }
  } else {
    cachedJobs = jsonCache.postings.length;
    cachedSources = new Set(jsonCache.postings.map((posting) => posting.source_key)).size;
  }

  return {
    ...syncStatus,
    cachedJobs,
    cachedSources,
    dbPath: cacheBackend === "sqlite" ? CACHE_DB_PATH : JSON_CACHE_PATH,
    backend: cacheBackend,
  };
}

export function getCachedSourceKeys() {
  initCacheDb();

  if (cacheBackend === "sqlite") {
    try {
      const rows = database.prepare(`
        SELECT DISTINCT source_key
        FROM cached_postings
        WHERE expires_at > ?
      `).all(Date.now());
      return new Set(rows.map((row) => String(row?.source_key || "")).filter(Boolean));
    } catch (error) {
      recoverToJsonCache(error);
    }
  }

  return new Set(
    jsonCache.postings
      .filter((posting) => Number(posting.expires_at || 0) > Date.now())
      .map((posting) => String(posting.source_key || ""))
      .filter(Boolean)
  );
}

export function startBackgroundCacheSync(loadSources) {
  // Background syncing is intentionally disabled. Syncing is manual-only.
  void loadSources;
  if (backgroundSyncTimer) {
    clearInterval(backgroundSyncTimer);
    backgroundSyncTimer = null;
  }
}

export async function ensureSourcesCached(sources, filters = {}, options = {}) {
  initCacheDb();
  pruneExpiredCache();

  const staleSources = options.forceSync ? sources : sources.filter((source) => isSourceStale(source.key));
  const concurrency = Number(options.concurrency) > 0
    ? Number(options.concurrency)
    : DEFAULT_SYNC_CONCURRENCY;
  const timeoutMs = Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : null;
  let syncedSources = 0;
  let failedSources = 0;
  const errors = [];

  await runWithConcurrency(staleSources, concurrency, async (source) => {
    try {
      await syncSourceToCache(source, filters, {
        timeoutMs: timeoutMs
          ? Math.max(timeoutMs, getSourceSearchTimeoutMs(source))
          : Math.max(DEFAULT_SOURCE_SYNC_TIMEOUT_MS, getSourceSearchTimeoutMs(source)),
      });
      syncedSources += 1;
    } catch (error) {
      failedSources += 1;
      errors.push({
        sourceKey: source.key,
        company: source.company,
        error: error?.message || String(error),
      });
    }
  });

  return {
    ...getCacheStatus(),
    requestedSources: sources.length,
    attemptedSources: staleSources.length,
    syncedSources,
    failedSources,
    errors,
  };
}

export async function loadSourceResultsForSearch(sources, filters = {}, options = {}) {
  initCacheDb();
  pruneExpiredCache();

  const allowSync = Boolean(options.allowSync);
  const onSourceComplete = typeof options.onSourceComplete === "function" ? options.onSourceComplete : null;
  const maxDurationMs = Number(options.maxDurationMs) > 0 ? Number(options.maxDurationMs) : DEFAULT_SEARCH_MAX_DURATION_MS;
  const deadlineAt = Date.now() + maxDurationMs;
  const results = new Array(sources.length);

  await runWithConcurrency(sources, DEFAULT_SEARCH_CONCURRENCY, async (source, index) => {
    const result = Date.now() >= deadlineAt
      ? buildSearchTimeBudgetResult(source)
      : await loadSingleSourceResult(source, filters, allowSync);
    results[index] = result;
    if (onSourceComplete) {
      onSourceComplete({ source, index, result });
    }
  });

  return results;
}

export function loadCachedSourceResultsForSearch(sources, filters = {}, options = {}) {
  initCacheDb();
  pruneExpiredCache();

  const normalizedSources = Array.isArray(sources) ? sources : [];
  if (normalizedSources.length === 0) {
    return [];
  }

  const jobs = readCachedJobsForSourceKeys(
    normalizedSources.map((source) => source.key),
    filters
  );
  const jobsBySourceKey = new Map();

  for (const job of jobs) {
    const sourceKey = String(job?.sourceKey || "").trim();
    if (!sourceKey) {
      continue;
    }
    if (!jobsBySourceKey.has(sourceKey)) {
      jobsBySourceKey.set(sourceKey, []);
    }
    jobsBySourceKey.get(sourceKey).push(job);
  }

  const includeEmptySources = options.includeEmptySources !== false;
  const sourceList = includeEmptySources
    ? normalizedSources
    : normalizedSources.filter((source) => jobsBySourceKey.has(source.key));

  return sourceList.map((source) => ({
    source,
    jobs: jobsBySourceKey.get(source.key) || [],
    error: null,
    progressMeta: {
      mode: "cache_only",
      jobs: (jobsBySourceKey.get(source.key) || []).length,
    },
  }));
}

export function loadGeneratedInventorySearchResult(sources, filters = {}) {
  initCacheDb();
  pruneExpiredCache();

  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }

  const jobs = readCachedJobsForSourceKeys(
    sources.map((source) => source.key),
    filters
  );
  void warmGeneratedInventorySources(sources).catch(() => {});
  return {
    source: {
      key: "generated-ats-inventory",
      company: "Generated ATS Inventory",
      provider: "generated-ats",
    },
    jobs,
    error: null,
    progressMeta: {
      mode: "generated_inventory",
      jobs: jobs.length,
      sourceCount: sources.length,
    },
  };
}

export async function warmGeneratedInventorySources(sources, options = {}) {
  initCacheDb();
  pruneExpiredCache();

  const batchSize = Number(options.batchSize) > 0
    ? Number(options.batchSize)
    : GENERATED_INVENTORY_WARM_BATCH_SIZE;
  const staleSources = (Array.isArray(sources) ? sources : [])
    .filter((source) => isGeneratedInventorySource(source))
    .filter((source) => !safeIsSourceFresh(source.key));
  if (staleSources.length === 0) {
    return {
      attemptedSources: 0,
      syncedSources: 0,
      failedSources: 0,
      errors: [],
    };
  }

  const selected = selectGeneratedInventoryWarmBatch(staleSources, batchSize);
  return ensureSourcesCached(selected, {}, { forceSync: true });
}

function buildSearchTimeBudgetResult(source) {
  const cachedJobs = safeReadCachedJobsForSource(source.key);
  if (cachedJobs.length > 0) {
    return {
      source,
      jobs: cachedJobs,
      error: null,
      progressMeta: {
        mode: "time_budget_fallback",
        jobs: cachedJobs.length,
      },
    };
  }

  return {
    source,
    jobs: [],
    error: "Search time budget exceeded",
    progressMeta: {
      mode: "time_budget_exceeded",
      jobs: 0,
    },
  };
}

async function loadSingleSourceResult(source, filters, allowSync) {
  const requiresBatchCaching = isGeneratedInventorySource(source);
  const existingJobs = safeReadCachedJobsForSource(source.key);

  if (requiresBatchCaching) {
    return {
      source,
      jobs: existingJobs,
      error: null,
      progressMeta: {
        mode: "generated_cache",
        jobs: existingJobs.length,
      },
    };
  }

  const hasFreshCache = safeIsSourceFresh(source.key);

  if (hasFreshCache && existingJobs.length > 0) {
    return {
      source,
      jobs: existingJobs,
      error: null,
      progressMeta: {
        mode: "fresh_cache",
        jobs: existingJobs.length,
      },
    };
  }

  if (!allowSync) {
    if (existingJobs.length > 0) {
      return {
        source,
        jobs: existingJobs,
        error: null,
        progressMeta: {
          mode: "cache_only",
          jobs: existingJobs.length,
        },
      };
    }
    return {
      source,
      jobs: [],
      error: null,
      progressMeta: {
        mode: "empty_cache",
        jobs: 0,
      },
    };
  }

  try {
    await syncSourceToCache(source, filters, { timeoutMs: getSourceSearchTimeoutMs(source) });
    const syncedJobs = safeReadCachedJobsForSource(source.key);
    return {
      source,
      jobs: syncedJobs,
      error: null,
      progressMeta: {
        mode: "live_sync",
        jobs: syncedJobs.length,
      },
    };
  } catch (error) {
    const fallbackJobs = safeReadCachedJobsForSource(source.key);
    if (fallbackJobs.length === 0) {
      try {
        const liveJobs = await fetchJobsForSourceWithTimeout(source, filters, getSourceSearchTimeoutMs(source));
        return {
          source,
          jobs: liveJobs,
          error: null,
          progressMeta: {
            mode: "live_direct",
            jobs: liveJobs.length,
          },
        };
      } catch (liveError) {
        return {
          source,
          jobs: [],
          error: liveError?.message || error?.message || String(liveError || error),
          progressMeta: {
            mode: "failed",
            jobs: 0,
          },
        };
      }
    }
    return {
      source,
      jobs: fallbackJobs,
      error: fallbackJobs.length > 0 ? null : (error?.message || String(error)),
      progressMeta: {
        mode: "stale_cache_fallback",
        jobs: fallbackJobs.length,
      },
    };
  }
}

async function runBackgroundCacheSync(loadSources) {
  syncStatus.running = true;
  syncStatus.startedAt = new Date().toISOString();
  syncStatus.lastError = null;
  syncStatus.syncedSources = 0;

  try {
    const sources = await loadSources();
    syncStatus.totalSources = sources.length;

    await runWithConcurrency(sources, DEFAULT_SYNC_CONCURRENCY, async (source) => {
      await syncSourceToCache(source);
      syncStatus.syncedSources += 1;
    });

    syncStatus.totalCachedJobs = getCacheStatus().cachedJobs;
    syncStatus.finishedAt = new Date().toISOString();
  } catch (error) {
    syncStatus.lastError = error?.message || String(error);
  } finally {
    syncStatus.running = false;
  }
}

async function syncSourceToCache(source, filters = {}, options = {}) {
  if (sourceSyncPromises.has(source.key)) {
    return sourceSyncPromises.get(source.key);
  }

  const promise = (async () => {
    const db = initCacheDb();
    const now = Date.now();

    try {
      const jobs = await fetchJobsForSourceWithTimeout(
        source,
        filters,
        Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_SOURCE_SYNC_TIMEOUT_MS
      );
      replaceSourceJobs(db, source, jobs, now);
      recordSourceState(db, source, {
        lastSyncedAt: now,
        lastJobCount: jobs.length,
        lastError: null,
      });
      return jobs.length;
    } catch (error) {
      recordSourceState(db, source, {
        lastSyncedAt: now,
        lastJobCount: 0,
        lastError: error?.message || String(error),
      });
      throw error;
    }
  })().finally(() => {
    sourceSyncPromises.delete(source.key);
  });

  sourceSyncPromises.set(source.key, promise);
  return promise;
}

function replaceSourceJobs(db, source, jobs, now) {
  const dedupedJobs = dedupeJobsForCache(source, jobs);
  const previousExternalIds = new Set(safeReadCachedJobsForSource(source.key).map((job) => String(job.externalId || "")));

  if (cacheBackend === "json") {
    updateJsonPostingHistory(source, dedupedJobs, now, previousExternalIds);
    jsonCache.postings = jsonCache.postings.filter((posting) => posting.source_key !== source.key);
    const mapped = dedupedJobs.map((job) => ({
      source_key: source.key,
      provider: source.provider,
      company: job.company || source.company,
      source_name: job.sourceName || source.company,
      external_id: String(job.externalId || job.id || job.applyUrl || `${source.key}-${Math.random()}`),
      title: job.title || "Untitled role",
      team: job.team || null,
      department: job.department || null,
      location_label: job.locationLabel || "Unspecified",
      city: job.city || null,
      region: job.region || null,
      country: job.country || null,
      work_arrangement: job.workArrangement || null,
      posted_at: job.postedDate || job.postedAt || null,
      updated_at: job.updatedDate || job.updatedAt || null,
      date_status: job.dateStatus || null,
      apply_url: job.applyUrl,
      description_snippet: job.descriptionSnippet || null,
      search_text: job.searchText || job.descriptionSnippet || null,
      employment_type: job.employmentType || null,
      compensation: job.compensation || null,
      raw_location_text: job.rawLocationText || null,
      cached_at: now,
      expires_at: now + DEFAULT_TTL_MS,
    }));
    jsonCache.postings.push(...mapped);
    saveJsonCache();
    return;
  }

  db.exec("BEGIN");
  try {
    updateSqlitePostingHistory(db, source, dedupedJobs, now, previousExternalIds);
    db.prepare("DELETE FROM cached_postings WHERE source_key = ?").run(source.key);

    const statement = db.prepare(`
      INSERT INTO cached_postings (
        source_key, provider, company, source_name, external_id, title, team, department,
        location_label, city, region, country, work_arrangement, posted_at, updated_at,
        date_status, apply_url, description_snippet, search_text, employment_type,
        compensation, raw_location_text, cached_at, expires_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    for (const job of dedupedJobs) {
      statement.run(
        source.key,
        source.provider,
        job.company || source.company,
        job.sourceName || source.company,
        String(job.externalId || job.id || job.applyUrl || `${source.key}-${Math.random()}`),
        job.title || "Untitled role",
        job.team || null,
        job.department || null,
        job.locationLabel || "Unspecified",
        job.city || null,
        job.region || null,
        job.country || null,
        job.workArrangement || null,
        job.postedDate || job.postedAt || null,
        job.updatedDate || job.updatedAt || null,
        job.dateStatus || null,
        job.applyUrl,
        job.descriptionSnippet || null,
        job.searchText || job.descriptionSnippet || null,
        job.employmentType || null,
        job.compensation || null,
        job.rawLocationText || null,
        now,
        now + DEFAULT_TTL_MS
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function dedupeJobsForCache(source, jobs) {
  const seen = new Set();
  const deduped = [];

  for (const job of jobs) {
    const externalId = String(job.externalId || job.id || job.applyUrl || "");
    const fallbackKey = `${source.key}|${job.title || ""}|${job.applyUrl || ""}`;
    const dedupeKey = externalId || fallbackKey;

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    deduped.push(job);
  }

  return deduped;
}

function recordSourceState(db, source, state) {
  if (cacheBackend === "json") {
    jsonCache.sourceState[source.key] = {
      company: source.company,
      provider: source.provider,
      last_synced_at: state.lastSyncedAt || null,
      last_job_count: state.lastJobCount || 0,
      last_error: state.lastError || null,
    };
    saveJsonCache();
    return;
  }

  db.prepare(`
    INSERT INTO source_cache_state (source_key, company, provider, last_synced_at, last_job_count, last_error)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      company = excluded.company,
      provider = excluded.provider,
      last_synced_at = excluded.last_synced_at,
      last_job_count = excluded.last_job_count,
      last_error = excluded.last_error
  `).run(
    source.key,
    source.company,
    source.provider,
    state.lastSyncedAt || null,
    state.lastJobCount || 0,
    state.lastError || null
  );
}

function isSourceStale(sourceKey) {
  initCacheDb();

  let lastSyncedAt = 0;
  if (cacheBackend === "sqlite") {
    const row = database.prepare(`
      SELECT last_synced_at
      FROM source_cache_state
      WHERE source_key = ?
      LIMIT 1
    `).get(sourceKey);
    lastSyncedAt = Number(row?.last_synced_at || 0);
  } else {
    lastSyncedAt = Number(jsonCache.sourceState?.[sourceKey]?.last_synced_at || 0);
  }

  if (!lastSyncedAt) {
    return true;
  }

  return Date.now() - lastSyncedAt > DEFAULT_SOURCE_MAX_AGE_MS;
}

function updateSqlitePostingHistory(db, source, jobs, now, previousExternalIds) {
  const existingRows = db.prepare(`
    SELECT *
    FROM posting_history
    WHERE source_key = ?
  `).all(source.key);
  const existingById = new Map(existingRows.map((row) => [String(row.external_id || ""), row]));
  const activeExternalIds = new Set(jobs.map((job) => String(job.externalId || job.id || job.applyUrl || "")));

  const upsertStatement = db.prepare(`
    INSERT INTO posting_history (
      source_key, external_id, company, title, apply_url,
      first_seen_at, last_seen_at, missing_since,
      first_posted_at, last_posted_at,
      last_reappeared_at, reappearance_count,
      last_date_refresh_at, date_refresh_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, external_id) DO UPDATE SET
      company = excluded.company,
      title = excluded.title,
      apply_url = excluded.apply_url,
      last_seen_at = excluded.last_seen_at,
      missing_since = excluded.missing_since,
      last_posted_at = excluded.last_posted_at,
      last_reappeared_at = excluded.last_reappeared_at,
      reappearance_count = excluded.reappearance_count,
      last_date_refresh_at = excluded.last_date_refresh_at,
      date_refresh_count = excluded.date_refresh_count
  `);
  const markMissingStatement = db.prepare(`
    UPDATE posting_history
    SET missing_since = COALESCE(missing_since, ?)
    WHERE source_key = ? AND external_id = ?
  `);

  for (const previousExternalId of previousExternalIds) {
    if (!previousExternalId || activeExternalIds.has(previousExternalId)) {
      continue;
    }
    markMissingStatement.run(now, source.key, previousExternalId);
  }

  for (const job of jobs) {
    const externalId = String(job.externalId || job.id || job.applyUrl || "");
    if (!externalId) {
      continue;
    }

    const existing = existingById.get(externalId);
    const currentPostedAt = normalizeHistoryDate(job.postedAt || job.updatedAt);
    const firstSeenAt = Number(existing?.first_seen_at || now);
    const wasMissing = Number(existing?.missing_since || 0) > 0;
    const previousPostedAt = normalizeHistoryDate(existing?.last_posted_at || existing?.first_posted_at);
    const dateRefreshed = hasMeaningfulPostedDateRefresh(previousPostedAt, currentPostedAt);

    upsertStatement.run(
      source.key,
      externalId,
      job.company || source.company,
      job.title || "Untitled role",
      job.applyUrl || "",
      firstSeenAt,
      now,
      null,
      normalizeHistoryDate(existing?.first_posted_at || currentPostedAt),
      currentPostedAt || previousPostedAt,
      wasMissing ? now : Number(existing?.last_reappeared_at || 0) || null,
      Number(existing?.reappearance_count || 0) + (wasMissing ? 1 : 0),
      dateRefreshed ? now : Number(existing?.last_date_refresh_at || 0) || null,
      Number(existing?.date_refresh_count || 0) + (dateRefreshed ? 1 : 0)
    );
  }
}

function updateJsonPostingHistory(source, jobs, now, previousExternalIds) {
  const sourceHistory = jsonCache.postingHistory?.[source.key] || {};
  const activeExternalIds = new Set();

  for (const previousExternalId of previousExternalIds) {
    if (!previousExternalId) {
      continue;
    }
    const existing = sourceHistory[previousExternalId];
    if (existing && !jobs.some((job) => String(job.externalId || job.id || job.applyUrl || "") === previousExternalId)) {
      existing.missing_since = existing.missing_since || now;
    }
  }

  for (const job of jobs) {
    const externalId = String(job.externalId || job.id || job.applyUrl || "");
    if (!externalId) {
      continue;
    }
    activeExternalIds.add(externalId);
    const existing = sourceHistory[externalId] || {};
    const currentPostedAt = normalizeHistoryDate(job.postedAt || job.updatedAt);
    const previousPostedAt = normalizeHistoryDate(existing.last_posted_at || existing.first_posted_at);
    const wasMissing = Number(existing.missing_since || 0) > 0;
    const dateRefreshed = hasMeaningfulPostedDateRefresh(previousPostedAt, currentPostedAt);

    sourceHistory[externalId] = {
      source_key: source.key,
      external_id: externalId,
      company: job.company || source.company,
      title: job.title || "Untitled role",
      apply_url: job.applyUrl || "",
      first_seen_at: Number(existing.first_seen_at || now),
      last_seen_at: now,
      missing_since: null,
      first_posted_at: normalizeHistoryDate(existing.first_posted_at || currentPostedAt),
      last_posted_at: currentPostedAt || previousPostedAt,
      last_reappeared_at: wasMissing ? now : Number(existing.last_reappeared_at || 0) || null,
      reappearance_count: Number(existing.reappearance_count || 0) + (wasMissing ? 1 : 0),
      last_date_refresh_at: dateRefreshed ? now : Number(existing.last_date_refresh_at || 0) || null,
      date_refresh_count: Number(existing.date_refresh_count || 0) + (dateRefreshed ? 1 : 0),
    };
  }

  jsonCache.postingHistory[source.key] = sourceHistory;
}

function safeIsSourceFresh(sourceKey) {
  try {
    return !isSourceStale(sourceKey);
  } catch {
    return false;
  }
}

function readCachedJobsForSource(sourceKey) {
  initCacheDb();

  if (cacheBackend === "sqlite") {
    try {
      const rows = database.prepare(`
        SELECT
          postings.*,
          history.first_seen_at,
          history.last_seen_at,
          history.missing_since,
          history.first_posted_at,
          history.last_posted_at AS history_last_posted_at,
          history.last_reappeared_at,
          history.reappearance_count,
          history.last_date_refresh_at,
          history.date_refresh_count
        FROM cached_postings AS postings
        LEFT JOIN posting_history AS history
          ON history.source_key = postings.source_key
         AND history.external_id = postings.external_id
          WHERE postings.source_key = ?
            AND expires_at > ?
          ORDER BY COALESCE(postings.posted_at, postings.updated_at, '') DESC
        `).all(sourceKey, Date.now());
        return rows.map(mapCachedRowToJob);
      } catch (error) {
        recoverToJsonCache(error);
      }
    }

  const jsonRows = readJsonCachedRowsForSourceKeys([sourceKey]);
  return jsonRows.map(mapCachedRowToJob);
}

function readCachedJobsForSourceKeys(sourceKeys, filters = {}) {
  initCacheDb();

  const normalizedKeys = [...new Set(
    (Array.isArray(sourceKeys) ? sourceKeys : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  if (normalizedKeys.length === 0) {
    return [];
  }

  const keywordPrefilter = buildGeneratedInventoryKeywordPrefilter(filters);
  const recencyPrefilter = buildCachedRecencyPrefilter(filters);

  if (cacheBackend === "sqlite") {
    try {
      if (normalizedKeys.length >= BULK_CACHE_ALL_SOURCES_THRESHOLD) {
        const sourceChunks = buildSourceKeyChunks(normalizedKeys);

        if (recencyPrefilter) {
          const datedRows = [];
          const unknownRows = [];
          for (const chunk of sourceChunks) {
            const placeholders = chunk.map(() => "?").join(", ");
            const datedStatement = database.prepare(`
              SELECT
                postings.*,
                history.first_seen_at,
                history.last_seen_at,
                history.missing_since,
                history.first_posted_at,
                history.last_posted_at AS history_last_posted_at,
                history.last_reappeared_at,
                history.reappearance_count,
                history.last_date_refresh_at,
                history.date_refresh_count
              FROM cached_postings AS postings
              LEFT JOIN posting_history AS history
                ON history.source_key = postings.source_key
               AND history.external_id = postings.external_id
              WHERE postings.source_key IN (${placeholders})
                AND expires_at > ?
                AND COALESCE(postings.posted_at, postings.updated_at) >= ?
              ORDER BY COALESCE(postings.posted_at, postings.updated_at, '') DESC
              LIMIT ${BULK_DATED_RESULT_LIMIT}
            `);
            const unknownStatement = database.prepare(`
              SELECT
                postings.*,
                history.first_seen_at,
                history.last_seen_at,
                history.missing_since,
                history.first_posted_at,
                history.last_posted_at AS history_last_posted_at,
                history.last_reappeared_at,
                history.reappearance_count,
                history.last_date_refresh_at,
                history.date_refresh_count
              FROM cached_postings AS postings
              LEFT JOIN posting_history AS history
                ON history.source_key = postings.source_key
               AND history.external_id = postings.external_id
              WHERE postings.source_key IN (${placeholders})
                AND expires_at > ?
                AND postings.posted_at IS NULL
                AND postings.updated_at IS NULL
              ORDER BY postings.cached_at DESC
              LIMIT ${BULK_UNKNOWN_DATE_LIMIT}
            `);
            datedRows.push(...datedStatement.all(
              ...chunk,
              Date.now(),
              ...buildCachedRecencySqlParams(recencyPrefilter)
            ));
            unknownRows.push(...unknownStatement.all(...chunk, Date.now()));
          }
          return [...datedRows, ...unknownRows]
            .map(mapCachedRowToJob)
            .sort(sortCachedJobsForDisplay)
            .slice(0, BULK_DATED_RESULT_LIMIT + BULK_UNKNOWN_DATE_LIMIT)
            .filter((job) => matchesGeneratedInventoryKeywordPrefilter(job, keywordPrefilter));
        }

        const keywordSqlConfig = buildKeywordSqlConfig({
          keywordPrefilter,
          broadSearch: true,
        });
        const keywordClause = keywordPrefilter
          ? ` AND (${buildGeneratedInventoryKeywordSqlClause(keywordSqlConfig)})`
          : "";
        const rows = [];
        for (const chunk of sourceChunks) {
          const placeholders = chunk.map(() => "?").join(", ");
          const statement = database.prepare(`
            SELECT
              postings.*,
              history.first_seen_at,
              history.last_seen_at,
              history.missing_since,
              history.first_posted_at,
              history.last_posted_at AS history_last_posted_at,
              history.last_reappeared_at,
              history.reappearance_count,
              history.last_date_refresh_at,
              history.date_refresh_count
            FROM cached_postings AS postings
            LEFT JOIN posting_history AS history
              ON history.source_key = postings.source_key
             AND history.external_id = postings.external_id
            WHERE postings.source_key IN (${placeholders})
              AND expires_at > ?
              ${keywordClause}
            ORDER BY COALESCE(postings.posted_at, postings.updated_at, '') DESC
            LIMIT ${BULK_DATED_RESULT_LIMIT}
          `);
          rows.push(...statement.all(
            ...chunk,
            Date.now(),
            ...buildGeneratedInventoryKeywordSqlParams(keywordSqlConfig)
          ));
        }
        return rows
          .map(mapCachedRowToJob)
          .sort(sortCachedJobsForDisplay)
          .slice(0, BULK_DATED_RESULT_LIMIT);
      }

      const allRows = [];
      const chunkSize = 400;
      for (let index = 0; index < normalizedKeys.length; index += chunkSize) {
        const chunk = normalizedKeys.slice(index, index + chunkSize);
        const placeholders = chunk.map(() => "?").join(", ");
        const keywordSqlConfig = buildKeywordSqlConfig({
          keywordPrefilter,
          broadSearch: false,
        });
        const keywordClause = keywordPrefilter
          ? ` AND (${buildGeneratedInventoryKeywordSqlClause(keywordSqlConfig)})`
          : "";
        const recencyClause = recencyPrefilter
          ? " AND ((COALESCE(postings.posted_at, postings.updated_at) >= ?) OR (postings.posted_at IS NULL AND postings.updated_at IS NULL))"
          : "";
        const statement = database.prepare(`
          SELECT
            postings.*,
            history.first_seen_at,
            history.last_seen_at,
            history.missing_since,
            history.first_posted_at,
            history.last_posted_at AS history_last_posted_at,
            history.last_reappeared_at,
            history.reappearance_count,
            history.last_date_refresh_at,
            history.date_refresh_count
          FROM cached_postings AS postings
            LEFT JOIN posting_history AS history
              ON history.source_key = postings.source_key
             AND history.external_id = postings.external_id
            WHERE postings.source_key IN (${placeholders})
              AND expires_at > ?
              ${keywordClause}
              ${recencyClause}
            ORDER BY COALESCE(postings.posted_at, postings.updated_at, '') DESC
          `);
            const rows = statement.all(
              ...chunk,
              Date.now(),
              ...buildGeneratedInventoryKeywordSqlParams(keywordSqlConfig),
              ...buildCachedRecencySqlParams(recencyPrefilter)
            );
            allRows.push(...rows);
          }
              return allRows.map(mapCachedRowToJob);
          } catch (error) {
          recoverToJsonCache(error);
        }
      }

  const jsonRows = readJsonCachedRowsForSourceKeys(normalizedKeys, keywordPrefilter, recencyPrefilter);
  return jsonRows.map(mapCachedRowToJob);
}

function buildCachedRecencyPrefilter(filters = {}) {
  const recency = String(filters?.recency || "").trim();
  const windowMs = RECENCY_WINDOWS[recency];
  if (!windowMs) {
    return null;
  }

  const cutoff = new Date(Date.now() - windowMs).toISOString();
  return { cutoff };
}

function buildCachedRecencySqlParams(prefilter) {
  return prefilter?.cutoff ? [prefilter.cutoff] : [];
}

function buildSourceKeyChunks(sourceKeys) {
  const chunkSize = 400;
  const chunks = [];
  for (let index = 0; index < sourceKeys.length; index += chunkSize) {
    chunks.push(sourceKeys.slice(index, index + chunkSize));
  }
  return chunks;
}

function sortCachedJobsForDisplay(left, right) {
  const leftTime = new Date(left?.postedAt || left?.updatedAt || left?.postedDate || left?.updatedDate || 0).getTime() || 0;
  const rightTime = new Date(right?.postedAt || right?.updatedAt || right?.postedDate || right?.updatedDate || 0).getTime() || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return String(left?.title || "").localeCompare(String(right?.title || ""));
}

function pruneExpiredCache() {
  initCacheDb();
  if (cacheBackend === "sqlite") {
    try {
      database.prepare("DELETE FROM cached_postings WHERE expires_at <= ?").run(Date.now());
      return;
    } catch (error) {
      recoverToJsonCache(error);
    }
  }

  jsonCache.postings = jsonCache.postings.filter((posting) => Number(posting.expires_at || 0) > Date.now());
  saveJsonCache();
}

async function fetchJobsForSourceWithTimeout(source, filters, timeoutMs) {
  return withTimeout(
    fetchJobsForSource(source, filters),
    timeoutMs,
    `${source.company} timed out after ${Math.ceil(timeoutMs / 1000)}s`
  );
}

function getSourceSearchTimeoutMs(source) {
  const sourceKey = String(source?.key || "").toLowerCase();
  const provider = String(source?.provider || "").toLowerCase();
  if (sourceKey === "zillow-careerpage") {
    return Math.max(DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, 60000);
  }
  if (sourceKey === "microsoft-careerpage") {
    return Math.max(DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, 120000);
  }
  if (provider === "pcsx") {
    return Math.max(DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, 30000);
  }
  if (provider === "workday" || provider === "ashby" || provider === "greenhouse") {
    return Math.max(DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, 7000);
  }
  if (sourceKey === "workday-careerpage") {
    return Math.max(DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, 12000);
  }
  if (provider === "slalom") {
    return Math.max(DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, 10000);
  }
  return DEFAULT_SOURCE_SEARCH_TIMEOUT_MS;
}

export function safeReadCachedJobsForSource(sourceKey) {
  try {
    return readCachedJobsForSource(sourceKey);
  } catch {
    return [];
  }
}

export function getPrioritySourceKeysForKeyword(keyword, options = {}) {
  initCacheDb();
  pruneExpiredCache();

  const phrases = expandKeywordQueriesForSearch(keyword)
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (phrases.length === 0) {
    return [];
  }

  const providerFilter = Array.isArray(options.providers)
    ? [...new Set(options.providers.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))]
    : [];
  const limit = Math.max(1, Number(options.limit) || 250);
  const historyLookbackDays = Math.max(1, Number(options.historyLookbackDays) || 180);
  const historyCutoffMs = Date.now() - (historyLookbackDays * 24 * 60 * 60 * 1000);

  if (cacheBackend === "sqlite") {
    try {
      const titleWhereClause = phrases.map(() => "LOWER(title) LIKE ?").join(" OR ");
      const activeProviderClause = providerFilter.length > 0
        ? ` AND provider IN (${providerFilter.map(() => "?").join(", ")})`
        : "";
      const historyProviderClause = providerFilter.length > 0
        ? ` AND state.provider IN (${providerFilter.map(() => "?").join(", ")})`
        : "";
      const sql = `
        WITH active_hits AS (
          SELECT
            source_key,
            provider,
            COUNT(*) AS active_hit_count,
            MAX(COALESCE(posted_at, updated_at, '')) AS active_last_date,
            0 AS history_hit_count,
            0 AS history_last_seen_at
          FROM cached_postings
          WHERE expires_at > ?
            ${activeProviderClause}
            AND (${titleWhereClause})
          GROUP BY source_key, provider
        ),
        history_hits AS (
          SELECT
            history.source_key AS source_key,
            state.provider AS provider,
            0 AS active_hit_count,
            '' AS active_last_date,
            COUNT(*) AS history_hit_count,
            MAX(history.last_seen_at) AS history_last_seen_at
          FROM posting_history AS history
          INNER JOIN source_cache_state AS state
            ON state.source_key = history.source_key
          WHERE history.last_seen_at >= ?
            ${historyProviderClause}
            AND (${titleWhereClause})
          GROUP BY history.source_key, state.provider
        )
        SELECT
          source_key,
          provider,
          SUM(active_hit_count) AS active_hit_count,
          MAX(active_last_date) AS active_last_date,
          SUM(history_hit_count) AS history_hit_count,
          MAX(history_last_seen_at) AS history_last_seen_at
        FROM (
          SELECT * FROM active_hits
          UNION ALL
          SELECT * FROM history_hits
        )
        GROUP BY source_key, provider
        ORDER BY
          (SUM(active_hit_count) * 20 + SUM(history_hit_count) * 5) DESC,
          MAX(history_last_seen_at) DESC,
          MAX(active_last_date) DESC,
          source_key ASC
        LIMIT ?
      `;
      const params = [
        Date.now(),
        ...providerFilter,
        ...phrases.map((phrase) => `%${phrase}%`),
        historyCutoffMs,
        ...providerFilter,
        ...phrases.map((phrase) => `%${phrase}%`),
        limit,
      ];
      const rows = database.prepare(sql).all(...params);
      return rows
        .map((row) => String(row?.source_key || "").trim())
        .filter(Boolean);
    } catch (error) {
      recoverToJsonCache(error);
    }
  }

  const scoreBySourceKey = new Map();
  const providerSet = providerFilter.length > 0 ? new Set(providerFilter) : null;
  const addScore = (sourceKey, score, freshness = 0) => {
    const key = String(sourceKey || "").trim();
    if (!key) {
      return;
    }
    const existing = scoreBySourceKey.get(key) || { score: 0, freshness: 0 };
    existing.score += score;
    existing.freshness = Math.max(existing.freshness, freshness);
    scoreBySourceKey.set(key, existing);
  };
  const titleMatches = (title) => {
    const haystack = String(title || "").trim().toLowerCase();
    return haystack && phrases.some((phrase) => haystack.includes(phrase));
  };

  for (const posting of Array.isArray(jsonCache.postings) ? jsonCache.postings : []) {
    if (Number(posting?.expires_at || 0) <= Date.now()) {
      continue;
    }
    const provider = String(posting?.provider || "").trim().toLowerCase();
    if (providerSet && !providerSet.has(provider)) {
      continue;
    }
    if (!titleMatches(posting?.title)) {
      continue;
    }
    const freshness = new Date(posting?.posted_at || posting?.updated_at || 0).getTime() || 0;
    addScore(posting?.source_key, 20, freshness);
  }

  const historyEntries = jsonCache.postingHistory && typeof jsonCache.postingHistory === "object"
    ? Object.entries(jsonCache.postingHistory)
    : [];
  for (const [historyKey, history] of historyEntries) {
    const sourceKey = String(history?.source_key || historyKey.split("::")[0] || "").trim();
    if (!sourceKey || !titleMatches(history?.title)) {
      continue;
    }
    const provider = String(jsonCache.sourceState?.[sourceKey]?.provider || "").trim().toLowerCase();
    if (providerSet && !providerSet.has(provider)) {
      continue;
    }
    const freshness = Number(history?.last_seen_at || 0);
    if (freshness < historyCutoffMs) {
      continue;
    }
    addScore(sourceKey, 5, freshness);
  }

  return [...scoreBySourceKey.entries()]
    .sort((left, right) => {
      const scoreDelta = (right[1]?.score || 0) - (left[1]?.score || 0);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const freshnessDelta = (right[1]?.freshness || 0) - (left[1]?.freshness || 0);
      if (freshnessDelta !== 0) {
        return freshnessDelta;
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([sourceKey]) => sourceKey);
}

function selectGeneratedInventoryWarmBatch(sources, limit) {
  const grouped = new Map();
  for (const source of sources) {
    const provider = String(source?.provider || "").toLowerCase() || "unknown";
    if (!grouped.has(provider)) {
      grouped.set(provider, []);
    }
    grouped.get(provider).push(source);
  }

  const providers = [...grouped.keys()].sort();
  const selected = [];
  while (selected.length < limit && providers.length > 0) {
    let progress = false;
    for (let index = providers.length - 1; index >= 0; index -= 1) {
      const provider = providers[index];
      const bucket = grouped.get(provider) || [];
      if (bucket.length === 0) {
        providers.splice(index, 1);
        continue;
      }
      selected.push(bucket.shift());
      progress = true;
      if (bucket.length === 0) {
        providers.splice(index, 1);
      }
      if (selected.length >= limit) {
        break;
      }
    }
    if (!progress) {
      break;
    }
  }

  return selected;
}

function recoverToJsonCache(error) {
  database = null;
  cacheBackend = "json";
  syncStatus.lastError = `SQLite unavailable, using JSON cache fallback: ${error?.message || error}`;
  loadJsonCache();
}

function isGeneratedInventorySource(source) {
  return Boolean(
    source?.generatedInventory
    || source?.inventorySource === "generated_ats"
  );
}

async function runWithConcurrency(items, concurrency, worker) {
  let index = 0;

  async function consume() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => consume());
  await Promise.all(workers);
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(message);
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function loadJsonCache() {
  try {
    if (existsSync(JSON_CACHE_PATH)) {
      const parsed = parseJsonCachePayload(readFileSync(JSON_CACHE_PATH, "utf8"));
      jsonCache = {
        postings: Array.isArray(parsed?.postings) ? parsed.postings : [],
        sourceState: parsed?.sourceState && typeof parsed.sourceState === "object" ? parsed.sourceState : {},
        postingHistory: parsed?.postingHistory && typeof parsed.postingHistory === "object" ? parsed.postingHistory : {},
      };
      return;
    }
  } catch (error) {
    if (error?.code === "EBUSY" || error?.code === "EPERM") {
      return;
    }
    // Ignore malformed cache and rebuild from empty.
  }

  jsonCache = {
    postings: [],
    sourceState: {},
    postingHistory: {},
  };
}

function saveJsonCache() {
  if (cacheBackend !== "json") {
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    const payload = JSON.stringify(jsonCache, null, 2);
    const tempPath = `${JSON_CACHE_PATH}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tempPath, payload, "utf8");
    try {
      renameSync(tempPath, JSON_CACHE_PATH);
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") {
        throw error;
      }
      writeFileSync(JSON_CACHE_PATH, payload, "utf8");
      try {
        unlinkSync(tempPath);
      } catch {}
    }
  } catch (error) {
    if (error?.code === "EBUSY" || error?.code === "EPERM") {
      return;
    }
    throw error;
  }
}

function readJsonCachedRowsForSourceKeys(sourceKeys, keywordPrefilter = null, recencyPrefilter = null) {
  loadJsonCache();
  const keySet = new Set(
    (Array.isArray(sourceKeys) ? sourceKeys : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  if (keySet.size === 0) {
    return [];
  }

  return jsonCache.postings
    .filter((posting) => keySet.has(String(posting.source_key || "")) && Number(posting.expires_at || 0) > Date.now())
    .filter((posting) => matchesGeneratedInventoryKeywordPrefilter(posting, keywordPrefilter))
    .filter((posting) => matchesJsonCachedRecencyPrefilter(posting, recencyPrefilter))
    .sort((left, right) => {
      const leftTime = new Date(left.posted_at || left.updated_at || 0).getTime() || 0;
      const rightTime = new Date(right.posted_at || right.updated_at || 0).getTime() || 0;
      return rightTime - leftTime;
    })
    .map((posting) => {
      const history = jsonCache.postingHistory?.[String(posting.source_key || "")]?.[String(posting.external_id || "")] || {};
      return { ...posting, ...history };
    });
}

function matchesJsonCachedRecencyPrefilter(posting, recencyPrefilter) {
  if (!recencyPrefilter?.cutoff) {
    return true;
  }

  const cutoffTime = Date.parse(recencyPrefilter.cutoff);
  if (!Number.isFinite(cutoffTime)) {
    return true;
  }

  const postedTime = Date.parse(posting?.posted_at || posting?.updated_at || "");
  if (!Number.isFinite(postedTime)) {
    return true;
  }

  return postedTime >= cutoffTime;
}

function parseJsonCachePayload(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const recovered = extractFirstJsonDocument(raw);
    if (!recovered) {
      throw error;
    }
    return JSON.parse(recovered);
  }
}

function extractFirstJsonDocument(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("{")) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, index + 1);
      }
    }
  }

  return null;
}

function buildGeneratedInventoryKeywordPrefilter(filters = {}) {
  const keyword = String(filters?.keyword || "").trim().toLowerCase();
  if (!keyword) {
    return null;
  }

  const words = [...new Set(
    keyword
      .split(/\s+/)
      .map((word) => word.replace(/[^a-z0-9.-]/gi, "").trim())
      .filter((word) => word.length >= 2)
  )];

  if (words.length === 0) {
    return null;
  }

  return {
    phrase: keyword,
    words,
    searchInDescription: filters?.keywordScope === "title_and_description" && words.length <= 1,
  };
}

function buildKeywordSqlConfig({ keywordPrefilter, broadSearch = false } = {}) {
  if (!keywordPrefilter) {
    return null;
  }

  if (broadSearch) {
    return {
      phraseExpression: "LOWER(COALESCE(postings.title, ''))",
      wordExpressions: [
        "LOWER(COALESCE(postings.title, ''))",
        "LOWER(COALESCE(postings.team, ''))",
        "LOWER(COALESCE(postings.department, ''))",
        "LOWER(COALESCE(postings.company, ''))",
      ],
      phrase: keywordPrefilter.phrase,
      words: keywordPrefilter.words,
    };
  }

  const titleExpressions = [
    "LOWER(COALESCE(postings.title, ''))",
    "LOWER(COALESCE(postings.team, ''))",
    "LOWER(COALESCE(postings.department, ''))",
  ];
  const textExpression = keywordPrefilter.searchInDescription
    ? "LOWER(COALESCE(postings.title, '') || ' ' || COALESCE(postings.team, '') || ' ' || COALESCE(postings.department, '') || ' ' || COALESCE(postings.search_text, '') || ' ' || COALESCE(postings.description_snippet, ''))"
    : "LOWER(COALESCE(postings.title, ''))";
  return {
    phraseExpression: textExpression,
    wordExpressions: keywordPrefilter.searchInDescription ? [textExpression] : titleExpressions,
    phrase: keywordPrefilter.phrase,
    words: keywordPrefilter.words,
  };
}

function buildGeneratedInventoryKeywordSqlClause(keywordSqlConfig) {
  if (!keywordSqlConfig) {
    return "1=1";
  }

  const phraseClause = `${keywordSqlConfig.phraseExpression} LIKE ?`;
  const wordClause = keywordSqlConfig.words
    .map(() => `(${keywordSqlConfig.wordExpressions.map((expression) => `${expression} LIKE ?`).join(" OR ")})`)
    .join(" AND ");
  return `(${phraseClause} OR (${wordClause}))`;
}

function buildGeneratedInventoryKeywordSqlParams(keywordSqlConfig) {
  if (!keywordSqlConfig) {
    return [];
  }

  const params = [`%${keywordSqlConfig.phrase}%`];
  for (const word of keywordSqlConfig.words) {
    for (let index = 0; index < keywordSqlConfig.wordExpressions.length; index += 1) {
      params.push(`%${word}%`);
    }
  }
  return params;
}

function matchesGeneratedInventoryKeywordPrefilter(posting, keywordPrefilter) {
  if (!keywordPrefilter) {
    return true;
  }

  const titleHaystack = String([
    posting?.title || "",
    posting?.team || "",
    posting?.department || "",
  ].join(" ")).toLowerCase();
  const extendedHaystack = String([
    posting?.title || "",
    posting?.team || "",
    posting?.department || "",
    posting?.search_text || "",
    posting?.description_snippet || "",
  ].join(" ")).toLowerCase();

  if (!titleHaystack.trim()) {
    return false;
  }

  if (titleHaystack.includes(keywordPrefilter.phrase)) {
    return true;
  }

  if (keywordPrefilter.words.every((word) => titleHaystack.includes(word))) {
    return true;
  }

  if (!keywordPrefilter.searchInDescription || !extendedHaystack.trim()) {
    return false;
  }

  if (extendedHaystack.includes(keywordPrefilter.phrase)) {
    return true;
  }

  return keywordPrefilter.words.every((word) => extendedHaystack.includes(word));
}

function mergeCachedJobRows(sqliteRows, jsonRows) {
  const merged = [];
  const seen = new Set();
  const jsonSources = new Set((Array.isArray(jsonRows) ? jsonRows : []).map((row) => String(row?.source_key || "")).filter(Boolean));

  for (const row of Array.isArray(jsonRows) ? jsonRows : []) {
    const key = buildCachedRowMergeKey(row);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(row);
  }

  for (const row of Array.isArray(sqliteRows) ? sqliteRows : []) {
    const sourceKey = String(row?.source_key || "");
    if (looksLikeApplicantProWrapperRow(row)) {
      continue;
    }
    const key = buildCachedRowMergeKey(row);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(row);
  }

  return merged.sort((left, right) => {
    const leftTime = new Date(left?.posted_at || left?.updated_at || 0).getTime() || 0;
    const rightTime = new Date(right?.posted_at || right?.updated_at || 0).getTime() || 0;
    return rightTime - leftTime;
  });
}

function buildCachedRowMergeKey(row) {
  const sourceKey = String(row?.source_key || "").trim();
  const externalId = String(row?.external_id || "").trim();
  const applyUrl = String(row?.apply_url || "").trim();
  const title = String(row?.title || "").trim();
  return [sourceKey, externalId || applyUrl || title].filter(Boolean).join("|");
}

function looksLikeApplicantProWrapperRow(row) {
  const provider = String(row?.provider || "").toLowerCase();
  const title = String(row?.title || "").trim().toLowerCase();
  const applyUrl = String(row?.apply_url || "").trim().toLowerCase();
  return provider === "applicantpro"
    && title === "jobs"
    && /\/jobs\/?$/.test(applyUrl);
}

function mapCachedRowToJob(row) {
  const repostInfo = buildRepostInfo(row);
  const normalizedApplyUrl = normalizeDescriptionFetchUrl(row.apply_url || "");
  const combinedText = [
    row.search_text || null,
    row.description_snippet || null,
    row.raw_location_text || null,
    row.location_label || null,
    row.title || null,
  ].filter(Boolean).join(" \n ");
  const providedLocationLabel = row.location_label || null;
  const derivedLocation = deriveLocationMetadata({
    title: row.title,
    locationLabel: providedLocationLabel,
    city: row.city || null,
    region: row.region || null,
    country: row.country || null,
    rawLocationText: row.raw_location_text || null,
    searchText: combinedText || null,
    descriptionSnippet: row.description_snippet || null,
  });
  const externalId = deriveCachedExternalId(row.external_id, normalizedApplyUrl, combinedText);
  const locationLabel = chooseCachedLocationLabel(providedLocationLabel, derivedLocation, combinedText);
  const workArrangement = row.work_arrangement && row.work_arrangement !== "unknown"
    ? row.work_arrangement
    : inferWorkArrangement([
      row.work_arrangement,
      locationLabel,
      row.raw_location_text || derivedLocation.rawLocationText || null,
      row.search_text || row.description_snippet || null,
      row.description_snippet || null,
    ].filter(Boolean).join(" \n "));
  const postedDate = row.posted_at || derivePostedAtFromCachedText(combinedText) || null;
  const updatedDate = row.updated_at || null;
  const firstSeenDate = Number(row.first_seen_at || 0) > 0
    ? new Date(Number(row.first_seen_at)).toISOString()
    : null;
  const parsedRecencyDate = postedDate || firstSeenDate || updatedDate || null;
  const dateStatus = postedDate
    ? "posted"
    : firstSeenDate
      ? (String(row.date_status || "").trim().toLowerCase() === "updated" ? "updated" : "first_seen")
      : updatedDate
        ? "updated"
        : "unknown";
  const compensation = row.compensation || deriveCompensationFromCachedText(combinedText) || null;
  const applicationDeadlineAt = extractApplicationDeadlineFromText(combinedText) || null;
  return {
    sourceKey: row.source_key,
    sourceName: row.source_name,
    provider: row.provider,
    company: deriveEmployerCompany({
      company: row.company,
      applyUrl: normalizedApplyUrl,
      searchText: row.search_text || null,
      descriptionSnippet: row.description_snippet || null,
      title: row.title,
    }, {
      company: row.company,
    }),
    externalId,
    title: row.title,
    team: row.team || null,
    department: row.department || null,
    locationLabel,
    city: row.city || derivedLocation.city || null,
    region: row.region || derivedLocation.region || null,
    country: row.country || derivedLocation.country || null,
    workArrangement,
    postedAt: postedDate,
    updatedAt: updatedDate,
    postedDate,
    updatedDate,
    firstSeenDate,
    parsedRecencyDate,
    dateStatus,
    applyUrl: normalizedApplyUrl,
    descriptionSnippet: row.description_snippet || null,
    searchText: row.search_text || row.description_snippet || null,
    employmentType: row.employment_type || null,
    compensation,
    applicationDeadlineAt,
    rawLocationText: row.raw_location_text || derivedLocation.rawLocationText || null,
    repostInfo,
    isPossibleRepost: repostInfo.isPossibleRepost,
  };
}

function deriveCachedExternalId(currentValue, applyUrl, text) {
  const explicit = normalizeCachedJobIdCandidate(currentValue);
  if (explicit) {
    return explicit;
  }

  const fromUrl = extractCachedJobIdFromUrl(applyUrl);
  if (fromUrl) {
    return fromUrl;
  }

  const fromText = extractCachedJobIdFromText(text);
  if (fromText) {
    return fromText;
  }

  return String(currentValue || applyUrl || "").trim();
}

function chooseCachedLocationLabel(providedLocationLabel, derivedLocation, combinedText) {
  const provided = String(providedLocationLabel || "").trim();
  const derivedLabel = String(derivedLocation?.locationLabel || "").trim();
  const derivedRaw = String(derivedLocation?.rawLocationText || "").trim();

  if (isGenericLocationLabel(provided)) {
    return derivedLabel || provided || "Unspecified";
  }

  if (/^(canada|united states|usa|us)$/i.test(provided)
    && /\b(remote|hybrid|onsite|in-?office)\b/i.test(String(combinedText || ""))) {
    return derivedRaw || derivedLabel || provided;
  }

  return provided || derivedLabel || "Unspecified";
}

function extractCachedJobIdFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    const queryCandidates = [
      url.searchParams.get("gh_jid"),
      url.searchParams.get("jobId"),
      url.searchParams.get("jobid"),
      url.searchParams.get("req"),
      url.searchParams.get("reqId"),
      url.searchParams.get("requisitionId"),
      url.searchParams.get("jid"),
      url.searchParams.get("job"),
    ];
    for (const candidate of queryCandidates) {
      const normalized = normalizeCachedJobIdCandidate(candidate);
      if (normalized) {
        return normalized;
      }
    }

    const pathMatches = [
      url.pathname.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i),
      url.pathname.match(/\/(R-\d+(?:-\d+)?)\/?$/i),
      url.pathname.match(/\/jobs\/(\d{4,})(?:\/|$)/i),
      url.pathname.match(/\/position\/(\d{4,})(?:\/|$)/i),
      url.pathname.match(/\/job\/([A-Z0-9]{6,12})(?:\/|$)/i),
      url.pathname.match(/\/job\/[^/]+\/[^/]+\/([A-Za-z]-?\d+(?:-\d+)?)\/?$/i),
      url.pathname.match(/\/job\/(\d{4,}-\d{4,})\/?$/i),
      url.pathname.match(/_([A-Za-z]\d+(?:-\d+)?)\/?$/i),
    ];
    for (const match of pathMatches) {
      const normalized = normalizeCachedJobIdCandidate(match?.[1] || "");
      if (normalized) {
        return normalized;
      }
    }
  } catch {}

  return "";
}

function extractCachedJobIdFromText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  const matches = [
    text.match(/\b(?:job\s*id|id\s*#|req(?:uisition)?\s*id|job\s*requisition\s*id)\s*[:#-]?\s*([A-Za-z]-?\d+(?:-\d+)?|[A-Za-z]\d+(?:-\d+)?|[A-Z0-9]{6,12}|\d{4,}-\d{4,}|\d{4,})\b/i),
    text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i),
    text.match(/\b(R-\d+(?:-\d+)?)\b/i),
    text.match(/\b([A-Z0-9]{6,12})\b/i),
    text.match(/\b(\d{4,}-\d{4,})\b/),
    text.match(/\/jobs\/(\d{4,})(?:\/|$)/i),
  ];

  for (const match of matches) {
    const normalized = normalizeCachedJobIdCandidate(match?.[1] || "");
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function normalizeCachedJobIdCandidate(value) {
  const raw = String(value || "").trim();
  if (!raw || /^https?:/i.test(raw) || raw === "undefined" || raw === "null") {
    return "";
  }

  if (/^[A-Za-z]+-\d+(?:-\d+)?$/i.test(raw)
    || /^[A-Za-z]\d+(?:-\d+)?$/i.test(raw)
    || (/^[A-Z0-9]{6,12}$/i.test(raw) && /[A-Z]/i.test(raw) && /\d/.test(raw))
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    || /^\d{4,}-\d{4,}$/.test(raw)
    || /^\d{4,}$/.test(raw)) {
    return /[a-z]/i.test(raw) && /[A-Z]/.test(raw) ? raw : raw.toUpperCase?.() ? raw.toUpperCase() : raw;
  }

  return "";
}

function derivePostedAtFromCachedText(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  return extractPostedDateFromHtml(text);
}

function deriveCompensationFromCachedText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }

  const labeledMatch = text.match(/\b(?:posted salary range|salary range|pay range|base salary range|compensation(?: range)?)\s*[:\-]?\s*([^.\n]{6,160})/i);
  const currencyMatch = text.match(/([$€£¥]\s?\d[\d,]*(?:\.\d+)?\s*(?:k|m)?\s*(?:-|–|to)\s*[$€£¥]?\s?\d[\d,]*(?:\.\d+)?\s*(?:k|m)?(?:\s*(?:USD|CAD|EUR|GBP|AUD|NZD|JPY))?(?:\s*\/\s*(?:hr|hour|yr|year))?)/i);
  const candidate = labeledMatch?.[1] || currencyMatch?.[1] || "";
  return cleanCachedCompensation(candidate);
}

function cleanCachedCompensation(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }

  text = text
    .replace(/^(salary|compensation|posted salary range|pay range|base salary range)\s*[:\-]?\s*/i, "")
    .replace(/\bwhere applicable\b.*$/i, "")
    .replace(/\bdepending on experience\b.*$/i, "")
    .trim();

  if (!/[$€£¥]|\b(?:USD|CAD|EUR|GBP|AUD|NZD|JPY)\b/i.test(text)) {
    return null;
  }

  return text || null;
}

function buildRepostInfo(row) {
  const reappearanceCount = Number(row.reappearance_count || 0);
  const dateRefreshCount = Number(row.date_refresh_count || 0);
  const firstSeenAt = Number(row.first_seen_at || 0) || null;
  const lastSeenAt = Number(row.last_seen_at || 0) || null;
  const lastReappearedAt = Number(row.last_reappeared_at || 0) || null;
  const lastDateRefreshAt = Number(row.last_date_refresh_at || 0) || null;
  const firstPostedAt = normalizeHistoryDate(row.first_posted_at || row.posted_at || row.updated_at);
  const latestPostedAt = normalizeHistoryDate(row.history_last_posted_at || row.last_posted_at || row.posted_at || row.updated_at);
  const hasMeaningfulDateRefresh = dateRefreshCount > 0 && hasMeaningfulPostedDateRefresh(firstPostedAt, latestPostedAt);
  const effectiveDateRefreshCount = hasMeaningfulDateRefresh ? dateRefreshCount : 0;
  const isPossibleRepost = reappearanceCount > 0 || hasMeaningfulDateRefresh;

  let label = "";
  if (hasMeaningfulDateRefresh) {
    label = "POSSIBLE REPOST";
  } else if (reappearanceCount > 0) {
    label = "REPOSTED";
  }

  const details = [];
  if (reappearanceCount > 0) {
    details.push("Seen before and reappeared");
  }
  if (hasMeaningfulDateRefresh) {
    details.push("Earlier cached sightings suggest this posting was refreshed");
  }

  return {
    isPossibleRepost,
    label,
    details,
    reappearanceCount,
    dateRefreshCount: effectiveDateRefreshCount,
    firstSeenAt,
    lastSeenAt,
    lastReappearedAt,
    lastDateRefreshAt,
    firstPostedAt,
    latestPostedAt,
  };
}

function hasMeaningfulPostedDateRefresh(previousPostedAt, currentPostedAt) {
  const previousTime = getHistoryTime(previousPostedAt);
  const currentTime = getHistoryTime(currentPostedAt);
  return previousTime > 0
    && currentTime > previousTime
    && currentTime - previousTime >= REPOST_POSTED_GAP_MS;
}

function normalizeHistoryDate(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const time = Date.parse(normalized);
  if (Number.isNaN(time)) {
    return "";
  }

  return new Date(time).toISOString();
}

function getHistoryTime(value) {
  if (!value) {
    return 0;
  }

  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}
