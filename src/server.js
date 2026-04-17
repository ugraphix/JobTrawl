import { createServer } from "node:http";
import { promises as fs } from "node:fs";
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
      });
    }

    if (request.method === "GET" && request.url === "/api/cache/status") {
      return sendJson(response, 200, getCacheStatus());
    }

    if (request.method === "POST" && request.url === "/api/cache/sync") {
      const body = await readJson(request);
      const allSources = await loadSourceConfig();
      const selectedSources = filterSources(allSources, body);
      await ensureSourcesCached(selectedSources);
      return sendJson(response, 200, {
        ok: true,
        syncedSources: selectedSources.length,
        cacheStatus: getCacheStatus(),
      });
    }

    if (request.method === "POST" && request.url === "/api/search") {
      const body = await readJson(request);
      const allSources = await loadSourceConfig();
      const sources = filterSources(allSources, body);
      const filters = {
        keyword: body.keyword || "",
        keywordScope: "title_and_description",
        recency: body.recency || "",
        arrangements: body.arrangements || [],
        locationGroups: sanitizeLocationGroups(body.locationGroups),
        distanceMiles: body.distanceMiles || null,
        userCoordinates: sanitizeCoordinates(body.userCoordinates),
        excludedCompanies: body.excludedCompanies || [],
      };
      const sourceResultsOverride = await loadSourceResultsForSearch(sources, filters, { allowSync: false });
      const result = await searchJobs({
        sources,
        filters,
        sourceResultsOverride,
      });
      return sendJson(response, 200, result);
    }

    if (request.method === "GET") {
      return serveStaticFile(request.url || "/", response);
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Unexpected error" });
  }
});

server.listen(port, () => {
  console.log(`ATS job aggregator running at http://localhost:${port}`);
  console.log(`Local cache database: ${getCacheDbPath()}`);
});

initCacheDb();

function filterSources(sources, sourceKeys) {
  const selectionMode = sourceKeys?.sourceSelectionMode || "all";

  if (selectionMode !== "custom") {
    return sources;
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

  return [...new Map(selectedSources.map((source) => [source.key, source])).values()];
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

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  response.end(JSON.stringify(payload));
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
