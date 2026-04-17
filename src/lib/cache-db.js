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
const DEFAULT_SEARCH_CONCURRENCY = Math.max(1, Number(process.env.CACHE_SEARCH_CONCURRENCY || 8));
const DEFAULT_SOURCE_SEARCH_TIMEOUT_MS = Math.max(1000, Number(process.env.CACHE_SOURCE_SEARCH_TIMEOUT_MS || 12000));
const DEFAULT_SOURCE_SYNC_TIMEOUT_MS = Math.max(DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, Number(process.env.CACHE_SOURCE_SYNC_TIMEOUT_MS || 60000));

let database = null;
let cacheBackend = "sqlite";
let jsonCache = {
  postings: [],
  sourceState: {},
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
    const stats = database.prepare(`
      SELECT
        COUNT(*) AS cachedJobs,
        COUNT(DISTINCT source_key) AS cachedSources
      FROM cached_postings
      WHERE expires_at > ?
    `).get(Date.now());
    cachedJobs = Number(stats?.cachedJobs || 0);
    cachedSources = Number(stats?.cachedSources || 0);
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
  const results = new Array(sources.length);

  await runWithConcurrency(sources, DEFAULT_SEARCH_CONCURRENCY, async (source, index) => {
    results[index] = await loadSingleSourceResult(source, filters, allowSync);
  });

  return results;
}

async function loadSingleSourceResult(source, filters, allowSync) {
  const existingJobs = readCachedJobsForSource(source.key);
  const hasFreshCache = !isSourceStale(source.key);

  if (hasFreshCache && existingJobs.length > 0) {
    return { source, jobs: existingJobs, error: null };
  }

  if (!allowSync) {
    if (existingJobs.length > 0) {
      return { source, jobs: existingJobs, error: null };
    }
    return { source, jobs: [], error: null };
  }

  try {
    await syncSourceToCache(source, filters, { timeoutMs: DEFAULT_SOURCE_SYNC_TIMEOUT_MS });
    return { source, jobs: readCachedJobsForSource(source.key), error: null };
  } catch (error) {
    const fallbackJobs = readCachedJobsForSource(source.key);
    return {
      source,
      jobs: fallbackJobs,
      error: fallbackJobs.length > 0 ? null : (error?.message || String(error)),
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

  if (cacheBackend === "json") {
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

function readCachedJobsForSource(sourceKey) {
  initCacheDb();

  if (cacheBackend === "sqlite") {
    const rows = database.prepare(`
      SELECT *
      FROM cached_postings
      WHERE source_key = ?
        AND expires_at > ?
      ORDER BY COALESCE(posted_at, updated_at, '') DESC
    `).all(sourceKey, Date.now());
    return rows.map(mapCachedRowToJob);
  }

  return jsonCache.postings
    .filter((posting) => posting.source_key === sourceKey && Number(posting.expires_at || 0) > Date.now())
    .sort((left, right) => {
      const leftTime = new Date(left.posted_at || left.updated_at || 0).getTime() || 0;
      const rightTime = new Date(right.posted_at || right.updated_at || 0).getTime() || 0;
      return rightTime - leftTime;
    })
    .map(mapCachedRowToJob);
}

function pruneExpiredCache() {
  initCacheDb();
  if (cacheBackend === "sqlite") {
    database.prepare("DELETE FROM cached_postings WHERE expires_at <= ?").run(Date.now());
    return;
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
      };
      return;
    }
  } catch {
    // Ignore malformed cache and rebuild from empty.
  }

  jsonCache = {
    postings: [],
    sourceState: {},
  };
}

function saveJsonCache() {
  if (cacheBackend !== "json") {
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(JSON_CACHE_PATH, JSON.stringify(jsonCache, null, 2), "utf8");
}

function mapCachedRowToJob(row) {
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
  };
}
