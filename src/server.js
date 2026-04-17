import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadLocationConfig, loadSourceConfig } from "./lib/config.js";
import { DISTANCE_OPTIONS, RECENCY_WINDOWS } from "./lib/filters.js";
import { PROVIDER_LABELS } from "./lib/adapters/index.js";
import { searchJobs } from "./lib/search.js";
import {
  ensureSourcesCached,
  getCacheDbPath,
  getCacheStatus,
  initCacheDb,
  loadSourceResultsForSearch,
} from "./lib/cache-db.js";

const publicDir = path.join(process.cwd(), "public");
const dataDir = path.join(process.cwd(), "data");
const serverLogPath = path.join(dataDir, "server.log");
const port = process.env.PORT || 3000;
const DEFAULT_COMPANIES = [
  "Amazon",
  "Microsoft",
  "Expedia",
  "Meta",
  "Google",
  "OpenAI",
  "Stripe",
  "Vercel",
  "Palantir",
  "Netflix",
];

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  try {
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      const [sources, states] = await Promise.all([loadSourceConfig(), loadLocationConfig()]);
      const atsSources = sources.filter((source) => !source.importedFrom && !source.collectionKey);
      const websiteCollections = buildWebsiteCollections(sources.filter((source) => source.importedFrom || source.collectionKey));
      return sendJson(response, 200, {
        providers: PROVIDER_LABELS,
        recencyOptions: Object.keys(RECENCY_WINDOWS),
        distanceOptions: DISTANCE_OPTIONS,
        companies: [...new Set([...DEFAULT_COMPANIES, ...sources.map((source) => source.company)])].sort(),
        sources,
        atsSources,
        websiteCollections,
        states,
        arrangements: ["remote", "hybrid", "onsite"],
        cacheStatus: getCacheStatus(),
      }, {
        method: request.method,
        url: request.url,
        startedAt,
      });
    }

    if (request.method === "GET" && request.url === "/api/cache/status") {
      return sendJson(response, 200, getCacheStatus(), {
        method: request.method,
        url: request.url,
        startedAt,
      });
    }

    if (request.method === "POST" && request.url === "/api/cache/sync") {
      const body = await readJson(request);
      const allSources = await loadSourceConfig();
      const selectedSources = filterSources(allSources, body);
      const filters = buildSearchFilters(body);
      const syncResult = await ensureSourcesCached(selectedSources, filters, { forceSync: true });
      const payload = {
        ok: true,
        syncedSources: syncResult.syncedSources,
        failedSources: syncResult.failedSources,
        attemptedSources: syncResult.attemptedSources,
        cacheStatus: syncResult,
        errors: syncResult.errors,
      };
      return sendJson(response, 200, payload, {
        method: request.method,
        url: request.url,
        startedAt,
        body,
        meta: {
          selectedSources: selectedSources.length,
          attemptedSources: payload.attemptedSources,
          syncedSources: payload.syncedSources,
          failedSources: payload.failedSources,
        },
      });
    }

    if (request.method === "POST" && request.url === "/api/search") {
      const body = await readJson(request);
      const allSources = await loadSourceConfig();
      const sources = filterSources(allSources, body);
      const filters = buildSearchFilters(body);
      const sourceResultsOverride = await loadSourceResultsForSearch(sources, filters, { allowSync: false });
      const result = await searchJobs({
        sources,
        filters,
        sourceResultsOverride,
      });
      return sendJson(response, 200, result, {
        method: request.method,
        url: request.url,
        startedAt,
        body,
        meta: {
          selectedSources: sources.length,
          jobs: result.jobs.length,
          failedSources: result.meta.failedSources,
        },
      });
    }

    if (request.method === "GET") {
      return serveStaticFile(request.url || "/", response);
    }

    sendJson(response, 404, { error: "Not found" }, {
      method: request.method,
      url: request.url,
      startedAt,
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Unexpected error" }, {
      method: request.method,
      url: request.url,
      startedAt,
      error,
    });
  }
});

server.listen(port, () => {
  console.log(`ATS job aggregator running at http://localhost:${port}`);
  console.log(`Local cache database: ${getCacheDbPath()}`);
});

initCacheDb();

function filterSources(sources, sourceKeys) {
  const selectionMode = sourceKeys?.sourceSelectionMode || "all";
  const requestedSyncKeys = new Set(Array.isArray(sourceKeys?.syncSourceKeys) ? sourceKeys.syncSourceKeys : []);

  if (selectionMode !== "custom") {
    return requestedSyncKeys.size > 0
      ? sources.filter((source) => requestedSyncKeys.has(source.key))
      : sources;
  }

  const searchAtsSources = Boolean(sourceKeys?.searchAtsSources);
  const searchAdditionalSources = Boolean(sourceKeys?.searchAdditionalSources);
  const selectedAtsSourceKeys = new Set(Array.isArray(sourceKeys?.selectedAtsSourceKeys) ? sourceKeys.selectedAtsSourceKeys : []);
  const selectedWebsiteSourceKeys = new Set(Array.isArray(sourceKeys?.selectedWebsiteSourceKeys) ? sourceKeys.selectedWebsiteSourceKeys : []);
  const websiteCollectionKey = typeof sourceKeys?.websiteCollectionKey === "string" ? sourceKeys.websiteCollectionKey : "";

  const selectedSources = [];

  if (searchAtsSources) {
    const atsSources = sources.filter((source) => !source.importedFrom && !source.collectionKey);
    selectedSources.push(
      ...(selectedAtsSourceKeys.size > 0
        ? atsSources.filter((source) => selectedAtsSourceKeys.has(source.key))
        : atsSources)
    );
  }

  if (searchAdditionalSources) {
    let additionalSources = sources.filter((source) => source.importedFrom || source.collectionKey);
    if (websiteCollectionKey) {
      additionalSources = additionalSources.filter((source) => source.collectionKey === websiteCollectionKey);
    }

    selectedSources.push(
      ...(selectedWebsiteSourceKeys.size > 0
        ? additionalSources.filter((source) => selectedWebsiteSourceKeys.has(source.key))
        : additionalSources)
    );
  }

  const deduped = [...new Map(selectedSources.map((source) => [source.key, source])).values()];
  if (requestedSyncKeys.size === 0) {
    return deduped;
  }

  return deduped.filter((source) => requestedSyncKeys.has(source.key));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStaticFile(requestUrl, response) {
  const url = requestUrl === "/" ? "/index.html" : requestUrl;
  const filePath = path.join(publicDir, normalizePublicPath(url));
  try {
    const buffer = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    response.end(buffer);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    throw error;
  }
}

function normalizePublicPath(url) {
  const clean = url.split("?")[0].replace(/^\/+/, "");
  return clean || "index.html";
}

function sendJson(response, status, payload, requestMeta = null) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  response.end(JSON.stringify(payload));
  logRequest(requestMeta, status, payload);
}

function logRequest(requestMeta, status, payload) {
  if (!requestMeta) {
    return;
  }

  mkdirSync(dataDir, { recursive: true });
  const elapsedMs = Date.now() - Number(requestMeta.startedAt || Date.now());
  const body = requestMeta.body || {};
  const summary = {
    timestamp: new Date().toISOString(),
    method: requestMeta.method || "",
    url: requestMeta.url || "",
    status,
    elapsedMs,
    keyword: typeof body.keyword === "string" ? body.keyword : "",
    recency: typeof body.recency === "string" ? body.recency : "",
    sourceSelectionMode: typeof body.sourceSelectionMode === "string" ? body.sourceSelectionMode : "",
    searchAtsSources: body.searchAtsSources,
    searchAdditionalSources: body.searchAdditionalSources,
    websiteCollectionKey: typeof body.websiteCollectionKey === "string" ? body.websiteCollectionKey : "",
    selectedAtsSourceKeys: Array.isArray(body.selectedAtsSourceKeys) ? body.selectedAtsSourceKeys.length : 0,
    selectedWebsiteSourceKeys: Array.isArray(body.selectedWebsiteSourceKeys) ? body.selectedWebsiteSourceKeys.length : 0,
    excludedCompanies: Array.isArray(body.excludedCompanies) ? body.excludedCompanies.length : 0,
    meta: requestMeta.meta || {},
    error: requestMeta.error ? (requestMeta.error.message || String(requestMeta.error)) : null,
    responseError: payload?.error || null,
  };

  appendFileSync(serverLogPath, `${JSON.stringify(summary)}\n`, "utf8");
}

function buildWebsiteCollections(sources) {
  const groups = new Map();

  for (const source of sources) {
    const key = source.collectionKey || "seattle-tech-sheet";
    const label = source.collectionLabel || "Seattle tech companies from spreadsheet";
    const description = source.collectionDescription || "Verified company career pages imported from your Seattle tech tracker.";

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label,
        description,
        sources: [],
      });
    }

    groups.get(key).sources.push({
      key: source.key,
      company: source.company,
      provider: source.provider,
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sources: [...group.sources].sort((left, right) => left.company.localeCompare(right.company, undefined, { sensitivity: "base" })),
    }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
}

function buildSearchFilters(body) {
  return {
    keyword: body.keyword || "",
    keywordScope: "title_and_description",
    recency: body.recency || "",
    arrangements: body.arrangements || [],
    usOnly: Boolean(body.usOnly),
    locationGroups: sanitizeLocationGroups(body.locationGroups),
    distanceMiles: body.distanceMiles || null,
    userCoordinates: sanitizeCoordinates(body.userCoordinates),
    excludedCompanies: body.excludedCompanies || [],
  };
}

function sanitizeLocationGroups(locationGroups) {
  if (!Array.isArray(locationGroups)) {
    return [];
  }

  return locationGroups
    .map((group) => ({
      stateCode: typeof group?.stateCode === "string" ? group.stateCode : "",
      areaNames: Array.isArray(group?.areaNames)
        ? group.areaNames.filter((value) => typeof value === "string" && value.trim())
        : [],
    }))
    .filter((group) => group.stateCode || group.areaNames.length > 0);
}

function sanitizeCoordinates(coordinates) {
  const latitude = Number(coordinates?.latitude);
  const longitude = Number(coordinates?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return { latitude, longitude };
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}
