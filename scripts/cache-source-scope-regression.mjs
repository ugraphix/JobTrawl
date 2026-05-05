import { DatabaseSync } from "node:sqlite";

import {
  getCacheDbPath,
  initCacheDb,
  loadCachedSourceResultsForSearch,
} from "../src/lib/cache-db.js";

initCacheDb();

const db = new DatabaseSync(getCacheDbPath());
const prefix = `scope-regression-${Date.now()}`;
const now = Date.now();
const expiresAt = now + 24 * 60 * 60 * 1000;
const recent = new Date(now).toISOString();
const old = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();

const insert = db.prepare(`
  INSERT INTO cached_postings (
    source_key, provider, company, source_name, external_id, title, team, department,
    location_label, city, region, country, work_arrangement, posted_at, updated_at,
    date_status, apply_url, description_snippet, search_text, employment_type,
    compensation, raw_location_text, cached_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function insertJob({ sourceKey, provider, index, postedAt, title = "Product Manager" }) {
  insert.run(
    sourceKey,
    provider,
    `${provider} company ${index}`,
    `${provider} source ${index}`,
    `${sourceKey}-job-${index}`,
    title,
    null,
    null,
    "Remote",
    null,
    null,
    null,
    "remote",
    postedAt,
    null,
    postedAt ? "posted" : "unknown",
    `https://example.com/${sourceKey}/job-${index}`,
    "Product manager role with enough description text to be usable and searchable",
    "Product manager role with enough description text to be usable and searchable",
    null,
    null,
    "Remote",
    now,
    expiresAt
  );
}

function flatten(results) {
  return results.flatMap((result) => Array.isArray(result.jobs) ? result.jobs : []);
}

function assertScoped(label, jobs, allowedKeys) {
  const leaked = jobs.filter((job) => !allowedKeys.has(job.sourceKey));
  if (leaked.length > 0) {
    throw new Error(`${label} leaked ${leaked.length} jobs outside selected sources; first leak: ${leaked[0].sourceKey}`);
  }
  if (jobs.length === 0) {
    throw new Error(`${label} returned no jobs, so source scoping was not meaningfully exercised`);
  }
}

try {
  const selectedSources = [];
  for (let index = 0; index < 1005; index += 1) {
    const sourceKey = `${prefix}-selected-${index}`;
    selectedSources.push({ key: sourceKey, provider: "applytojob", company: `selected ${index}` });
    insertJob({ sourceKey, provider: "applytojob", index, postedAt: index % 2 === 0 ? recent : null });
  }

  for (let index = 0; index < 50; index += 1) {
    insertJob({ sourceKey: `${prefix}-foreign-${index}`, provider: "greenhouse", index, postedAt: recent });
  }
  for (let index = 50; index < 100; index += 1) {
    insertJob({ sourceKey: `${prefix}-foreign-${index}`, provider: "greenhouse", index, postedAt: null });
  }
  for (let index = 100; index < 120; index += 1) {
    insertJob({ sourceKey: `${prefix}-foreign-${index}`, provider: "greenhouse", index, postedAt: old });
  }

  const selectedKeySet = new Set(selectedSources.map((source) => source.key));
  const recencyJobs = flatten(loadCachedSourceResultsForSearch(selectedSources, {
    keyword: "product manager",
    keywordScope: "title_and_description",
    recency: "24h",
  }));
  const allJobs = flatten(loadCachedSourceResultsForSearch(selectedSources, {
    keyword: "product manager",
    keywordScope: "title_and_description",
  }));
  const unknownDateJobs = recencyJobs.filter((job) => job.dateStatus === "unknown" || (!job.postedAt && !job.updatedAt));

  assertScoped("recency bulk cache read", recencyJobs, selectedKeySet);
  assertScoped("non-recency bulk cache read", allJobs, selectedKeySet);
  assertScoped("unknown-date bulk cache read", unknownDateJobs, selectedKeySet);

  console.log(JSON.stringify({
    selectedSources: selectedSources.length,
    recencyJobs: recencyJobs.length,
    allJobs: allJobs.length,
    unknownDateJobs: unknownDateJobs.length,
    passed: true,
  }, null, 2));
} finally {
  db.prepare("DELETE FROM cached_postings WHERE source_key LIKE ?").run(`${prefix}-%`);
  db.prepare("DELETE FROM source_cache_state WHERE source_key LIKE ?").run(`${prefix}-%`);
  db.prepare("DELETE FROM posting_history WHERE source_key LIKE ?").run(`${prefix}-%`);
  db.close();
}
