import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fetchJobsForSource } from "./adapters/index.js";

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
  let syncedSources = 0;
  let failedSources = 0;
  const errors = [];

  await runWithConcurrency(staleSources, DEFAULT_SYNC_CONCURRENCY, async (source) => {
    try {
      await syncSourceToCache(source, filters, { timeoutMs: DEFAULT_SOURCE_SYNC_TIMEOUT_MS });
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
      posted_at: job.postedAt || null,
      updated_at: job.updatedAt || null,
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
        job.postedAt || null,
        job.updatedAt || null,
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
    const dateRefreshed = Boolean(
      previousPostedAt
      && currentPostedAt
      && currentPostedAt !== previousPostedAt
      && getHistoryTime(currentPostedAt) > getHistoryTime(previousPostedAt)
    );

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
    const dateRefreshed = Boolean(
      previousPostedAt
      && currentPostedAt
      && currentPostedAt !== previousPostedAt
      && getHistoryTime(currentPostedAt) > getHistoryTime(previousPostedAt)
    );

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
  const jsonRows = readJsonCachedRowsForSourceKeys([sourceKey]);

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
      return mergeCachedJobRows(rows, jsonRows).map(mapCachedRowToJob);
    } catch (error) {
      recoverToJsonCache(error);
    }
  }

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
  const jsonRows = readJsonCachedRowsForSourceKeys(normalizedKeys, keywordPrefilter);

  if (cacheBackend === "sqlite") {
    try {
      const allRows = [];
      const chunkSize = 400;
      for (let index = 0; index < normalizedKeys.length; index += chunkSize) {
        const chunk = normalizedKeys.slice(index, index + chunkSize);
        const placeholders = chunk.map(() => "?").join(", ");
        const textExpression = "LOWER(COALESCE(postings.title, '') || ' ' || COALESCE(postings.search_text, '') || ' ' || COALESCE(postings.description_snippet, ''))";
        const keywordClause = keywordPrefilter
          ? ` AND (${buildGeneratedInventoryKeywordSqlClause(textExpression, keywordPrefilter)})`
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
          ORDER BY COALESCE(postings.posted_at, postings.updated_at, '') DESC
        `);
          const rows = statement.all(
            ...chunk,
            Date.now(),
            ...buildGeneratedInventoryKeywordSqlParams(keywordPrefilter)
          );
          allRows.push(...rows);
        }
          return mergeCachedJobRows(allRows, jsonRows).map(mapCachedRowToJob);
      } catch (error) {
        recoverToJsonCache(error);
      }
    }

  return jsonRows.map(mapCachedRowToJob);
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
  if (provider === "pcsx") {
    return Math.max(DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, 12000);
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

function safeReadCachedJobsForSource(sourceKey) {
  try {
    return readCachedJobsForSource(sourceKey);
  } catch {
    return [];
  }
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
      const parsed = JSON.parse(readFileSync(JSON_CACHE_PATH, "utf8"));
      jsonCache = {
        postings: Array.isArray(parsed?.postings) ? parsed.postings : [],
        sourceState: parsed?.sourceState && typeof parsed.sourceState === "object" ? parsed.sourceState : {},
        postingHistory: parsed?.postingHistory && typeof parsed.postingHistory === "object" ? parsed.postingHistory : {},
      };
      return;
    }
  } catch {
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
  writeFileSync(JSON_CACHE_PATH, JSON.stringify(jsonCache, null, 2), "utf8");
}

function readJsonCachedRowsForSourceKeys(sourceKeys, keywordPrefilter = null) {
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
  };
}

function buildGeneratedInventoryKeywordSqlClause(textExpression, keywordPrefilter) {
  if (!keywordPrefilter) {
    return "1=1";
  }

  const wordClause = keywordPrefilter.words.map(() => `${textExpression} LIKE ?`).join(" AND ");
  return `(${textExpression} LIKE ? OR (${wordClause}))`;
}

function buildGeneratedInventoryKeywordSqlParams(keywordPrefilter) {
  if (!keywordPrefilter) {
    return [];
  }

  return [
    `%${keywordPrefilter.phrase}%`,
    ...keywordPrefilter.words.map((word) => `%${word}%`),
  ];
}

function matchesGeneratedInventoryKeywordPrefilter(posting, keywordPrefilter) {
  if (!keywordPrefilter) {
    return true;
  }

  const haystack = String([
    posting?.title || "",
    posting?.search_text || "",
    posting?.description_snippet || "",
  ].join(" ")).toLowerCase();

  if (!haystack.trim()) {
    return false;
  }

  if (haystack.includes(keywordPrefilter.phrase)) {
    return true;
  }

  return keywordPrefilter.words.every((word) => haystack.includes(word));
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
  return {
    sourceKey: row.source_key,
    sourceName: row.source_name,
    provider: row.provider,
    company: row.company,
    externalId: row.external_id,
    title: row.title,
    team: row.team || null,
    department: row.department || null,
    locationLabel: row.location_label || "Unspecified",
    city: row.city || null,
    region: row.region || null,
    country: row.country || null,
    workArrangement: row.work_arrangement || null,
    postedAt: row.posted_at || null,
    updatedAt: row.updated_at || null,
    dateStatus: row.date_status || null,
    applyUrl: row.apply_url,
    descriptionSnippet: row.description_snippet || null,
    searchText: row.search_text || row.description_snippet || null,
    employmentType: row.employment_type || null,
    compensation: row.compensation || null,
    rawLocationText: row.raw_location_text || null,
    repostInfo,
    isPossibleRepost: repostInfo.isPossibleRepost,
  };
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
  const isPossibleRepost = reappearanceCount > 0 || dateRefreshCount > 0;

  let label = "";
  if (reappearanceCount > 0 && dateRefreshCount > 0) {
    label = "POSSIBLE REPOST";
  } else if (reappearanceCount > 0) {
    label = "REPOSTED";
  } else if (dateRefreshCount > 0) {
    label = "POSSIBLE REPOST";
  }

  const details = [];
  if (reappearanceCount > 0) {
    details.push("Seen before and reappeared");
  }
  if (dateRefreshCount > 0) {
    details.push("Earlier cached sightings suggest this posting was refreshed");
  }

  return {
    isPossibleRepost,
    label,
    details,
    reappearanceCount,
    dateRefreshCount,
    firstSeenAt,
    lastSeenAt,
    lastReappearedAt,
    lastDateRefreshAt,
    firstPostedAt,
    latestPostedAt,
  };
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
