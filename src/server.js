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
  getCachedSourceKeys,
  getCacheStatus,
  initCacheDb,
  loadSourceResultsForSearch,
} from "./lib/cache-db.js";

const publicDir = path.join(process.cwd(), "public");
const dataDir = path.join(process.cwd(), "data");
const serverLogPath = path.join(dataDir, "server.log");
const port = process.env.PORT || 3001;
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
const CUSTOM_ATS_PROVIDER_OPTIONS = [
  { key: "workday", label: "Workday" },
  { key: "ashby", label: "Ashby" },
  { key: "greenhouse", label: "Greenhouse" },
  { key: "lever", label: "Lever" },
  { key: "jobvite", label: "Jobvite" },
  { key: "applicantpro", label: "Applicantpro" },
  { key: "applytojob", label: "Applytojob" },
  { key: "theapplicantmanager", label: "Theapplicantmanager" },
  { key: "icims", label: "Icims" },
  { key: "recruitee", label: "Recruitee" },
  { key: "ultipro", label: "Ultipro" },
  { key: "taleo", label: "Taleo" },
  { key: "breezy", label: "BreezyHR" },
  { key: "applicantai", label: "ApplicantAI" },
  { key: "careerplug", label: "Career Plug" },
  { key: "careerpuck", label: "Career Puck" },
  { key: "fountain", label: "Fountain" },
  { key: "getro", label: "Getro" },
  { key: "hrmdirect", label: "HRM Direct" },
  { key: "talentlyft", label: "Talent Lyft" },
  { key: "talexio", label: "Talexio" },
  { key: "teamtailor", label: "Team Tailor" },
  { key: "talentreef", label: "Talent Reef" },
  { key: "manatal", label: "Manatal" },
  { key: "zoho", label: "Zoho" },
  { key: "bamboohr", label: "BambooHR" },
  { key: "gem", label: "Gem" },
  { key: "jobaps", label: "Jobaps" },
  { key: "join", label: "Join" },
  { key: "saphrcloud", label: "Saphrcloud" },
];
const CUSTOM_ATS_PROVIDER_KEYS = new Set(CUSTOM_ATS_PROVIDER_OPTIONS.map((option) => option.key));
const ATS_PROVIDER_KEYS = new Set([
  "ashby",
  "greenhouse",
  "lever",
  "workday",
  "jobvite",
  "applytojob",
  "applicantpro",
  "applicantai",
  "bamboohr",
  "icims",
  "ultipro",
  "taleo",
  "recruitee",
  "gem",
  "jobaps",
  "join",
  "workable",
  "theapplicantmanager",
  "breezy",
  "careerplug",
  "careerpuck",
  "fountain",
  "getro",
  "hrmdirect",
  "talentlyft",
  "talexio",
  "talentreef",
  "teamtailor",
  "manatal",
  "saphrcloud",
  "zoho",
  "smartrecruiters",
]);

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  try {
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      const [sources, states] = await Promise.all([loadSourceConfig(), loadLocationConfig()]);
      const defaultSources = getDefaultSearchSources(sources);
      const atsProviders = buildCustomAtsProviders(sources);
      return sendJson(response, 200, {
        providers: PROVIDER_LABELS,
        recencyOptions: Object.keys(RECENCY_WINDOWS),
        distanceOptions: DISTANCE_OPTIONS,
        companies: [...new Set([...DEFAULT_COMPANIES, ...defaultSources.map((source) => source.company)])].sort(),
        atsProviders,
        states,
        arrangements: ["remote", "hybrid", "onsite"],
        cacheStatus: safeGetCacheStatus(),
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
      const sourceResultsOverride = await loadSourceResultsForSearch(sources, filters, { allowSync: true });
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
  const customizationMode = sourceKeys?.sourceCustomizationMode === "companies" ? "companies" : "ats";
  const requestedSyncKeys = new Set(Array.isArray(sourceKeys?.syncSourceKeys) ? sourceKeys.syncSourceKeys : []);

  if (selectionMode !== "custom") {
    const defaultSources = getDefaultSearchSources(sources);
    return requestedSyncKeys.size > 0
      ? defaultSources.filter((source) => requestedSyncKeys.has(source.key))
      : defaultSources;
  }

  const selectedAtsProviderKeys = new Set(
    Array.isArray(sourceKeys?.selectedAtsProviderKeys)
      ? sourceKeys.selectedAtsProviderKeys
        .map((value) => String(value || "").trim().toLowerCase())
        .filter((value) => CUSTOM_ATS_PROVIDER_KEYS.has(value))
      : []
  );
  const includedCompanies = new Set(
    Array.isArray(sourceKeys?.includedCompanies)
      ? sourceKeys.includedCompanies
        .map((value) => normalizeCompanyKey(value))
        .filter(Boolean)
      : []
  );
  const atsSources = sources.filter((source) => isAtsSource(source) && CUSTOM_ATS_PROVIDER_KEYS.has(String(source?.provider || "").toLowerCase()));
  const additionalSources = getAdditionalSources(sources);
  const selectedSources = customizationMode === "companies"
    ? sources.filter((source) => includedCompanies.has(normalizeCompanyKey(source.company)))
    : [
      ...(selectedAtsProviderKeys.size > 0
        ? atsSources.filter((source) => selectedAtsProviderKeys.has(String(source?.provider || "").toLowerCase()))
        : atsSources),
      ...additionalSources,
    ];

  const deduped = [...new Map(selectedSources.map((source) => [source.key, source])).values()];
  if (requestedSyncKeys.size === 0) {
    return deduped;
  }

  return deduped.filter((source) => requestedSyncKeys.has(source.key));
}

function isAtsSource(source) {
  return ATS_PROVIDER_KEYS.has(String(source?.provider || "").toLowerCase());
}

function getDefaultSearchSources(sources) {
  const cachedSourceKeys = safeGetCachedSourceKeys();
  return sources.filter((source) => {
    const isGenerated = Boolean(source?.generatedInventory || source?.inventorySource === "openpostings");
    if (!isGenerated) {
      return true;
    }

    return cachedSourceKeys.has(String(source?.key || ""));
  });
}

function getAdditionalSources(sources) {
  const atsCompanies = new Set(
    sources
      .filter(isAtsSource)
      .map((source) => normalizeCompanyKey(source.company))
      .filter(Boolean)
  );

  return sources.filter((source) => {
    if (isAtsSource(source)) {
      return false;
    }

    if (!(source.importedFrom || source.collectionKey)) {
      return false;
    }

    return !atsCompanies.has(normalizeCompanyKey(source.company));
  });
}

function buildCustomAtsProviders(sources) {
  const counts = new Map();

  for (const source of sources) {
    const providerKey = String(source?.provider || "").toLowerCase();
    if (!CUSTOM_ATS_PROVIDER_KEYS.has(providerKey)) {
      continue;
    }

    const existing = counts.get(providerKey) || { sourceCount: 0, importedCount: 0, curatedCount: 0 };
    existing.sourceCount += 1;
    if (source.generatedInventory || source.inventorySource === "openpostings") {
      existing.importedCount += 1;
    } else {
      existing.curatedCount += 1;
    }
    counts.set(providerKey, existing);
  }

  return CUSTOM_ATS_PROVIDER_OPTIONS.map((option) => ({
    key: option.key,
    label: option.label,
    sourceCount: counts.get(option.key)?.sourceCount || 0,
    importedCount: counts.get(option.key)?.importedCount || 0,
    curatedCount: counts.get(option.key)?.curatedCount || 0,
  }));
}

function safeGetCacheStatus() {
  try {
    return getCacheStatus();
  } catch (error) {
    return {
      running: false,
      startedAt: null,
      finishedAt: null,
      lastError: error?.message || String(error),
      syncedSources: 0,
      totalSources: 0,
      totalCachedJobs: 0,
      cachedJobs: 0,
      cachedSources: 0,
      dbPath: getCacheDbPath(),
      backend: "sqlite",
    };
  }
}

function safeGetCachedSourceKeys() {
  try {
    return getCachedSourceKeys();
  } catch {
    return new Set();
  }
}

function normalizeCompanyKey(value) {
  return String(value || "").trim().toLowerCase();
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
    keywordMode: typeof body.keywordMode === "string" ? body.keywordMode : "strict",
    recency: typeof body.recency === "string" ? body.recency : "",
    arrangements: Array.isArray(body.arrangements) ? body.arrangements : [],
    usOnly: Boolean(body.usOnly),
    locationGroups: Array.isArray(body.locationGroups) ? body.locationGroups : [],
    distanceMiles: body.distanceMiles ?? null,
    sourceSelectionMode: typeof body.sourceSelectionMode === "string" ? body.sourceSelectionMode : "",
    sourceCustomizationMode: typeof body.sourceCustomizationMode === "string" ? body.sourceCustomizationMode : "",
    selectedAtsProviderKeys: Array.isArray(body.selectedAtsProviderKeys) ? body.selectedAtsProviderKeys.length : 0,
    includedCompanies: Array.isArray(body.includedCompanies) ? body.includedCompanies.length : 0,
    excludedCompanies: Array.isArray(body.excludedCompanies) ? body.excludedCompanies.length : 0,
    meta: requestMeta.meta || {},
    error: requestMeta.error ? (requestMeta.error.message || String(requestMeta.error)) : null,
    responseError: payload?.error || null,
  };

  appendFileSync(serverLogPath, `${JSON.stringify(summary)}\n`, "utf8");
}

function buildSearchFilters(body) {
  return {
    keyword: body.keyword || "",
    keywordMode: body.keywordMode === "loose" ? "loose" : "strict",
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
  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}
