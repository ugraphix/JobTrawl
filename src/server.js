import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { appendFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PDFParse } from "pdf-parse";
import { loadLocationConfig, loadSourceConfig } from "./lib/config.js";
import { DISTANCE_OPTIONS, RECENCY_WINDOWS } from "./lib/filters.js";
import { PROVIDER_LABELS } from "./lib/adapters/index.js";
import { fetchJobsForSource } from "./lib/adapters/index.js";
import { searchJobs } from "./lib/search.js";
import {
  ensureSourcesCached,
  getCacheDbPath,
  getCachedSourceKeys,
  getCacheStatus,
  initCacheDb,
  loadGeneratedInventorySearchResult,
  loadSourceResultsForSearch,
} from "./lib/cache-db.js";
import {
  APPLICATION_STATUSES,
  createApplication,
  deleteApplication,
  getApplication,
  getApplicationTrackerPaths,
  getApplicationsCsvBuffer,
  getApplicationsWorkbookBuffer,
  listApplications,
  prepareApplicationsWorkbookOpenPath,
  updateApplication,
} from "./lib/application-tracker.js";
import {
  buildListingTextPdfBuffer,
  detectBlockedListing,
  extractHtmlTitle,
  extractStructuredListingText,
  extractVisibleHtmlText,
  mergeListingTextCandidates,
  normalizeUrlForSnapshot,
  shouldPreferTextListingSnapshot,
} from "./lib/listing-snapshot.js";
import { enrichJobsWithWebRepostSignals, isWebRepostLookupConfigured } from "./lib/repost-enrichment.js";

const publicDir = path.join(process.cwd(), "public");
const dataDir = path.join(process.cwd(), "data");
const jobsDataDir = path.join(dataDir, "jobs");
const serverLogPath = path.join(dataDir, "server.log");
const port = process.env.PORT || 3001;
const execFileAsync = promisify(execFile);
const SEARCH_STATUS_TTL_MS = 2 * 60 * 1000;
const activeSearches = new Map();
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
  const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  try {
    if (request.method === "GET" && request.url === "/api/bootstrap") {
      const [sources, states] = await Promise.all([loadSourceConfig(), loadLocationConfig()]);
      const defaultSources = getDefaultSearchSources(sources);
      const atsProviders = buildCustomAtsProviders(sources);
      const trackerPaths = getApplicationTrackerPaths();
      return sendJson(response, 200, {
        providers: PROVIDER_LABELS,
        recencyOptions: Object.keys(RECENCY_WINDOWS),
        distanceOptions: DISTANCE_OPTIONS,
        companies: [...new Set([...DEFAULT_COMPANIES, ...defaultSources.map((source) => source.company)])].sort(),
        atsProviders,
        states,
        arrangements: ["remote", "hybrid", "onsite"],
        cacheStatus: safeGetCacheStatus(),
        applicationStatuses: APPLICATION_STATUSES,
        applicationTrackerPaths: trackerPaths,
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

    if (request.method === "GET" && requestUrl.pathname === "/api/applications") {
      const applications = await listApplications();
      pruneJobStorageDirectories(applications).catch(() => {});
      return sendJson(response, 200, {
        applications,
        statuses: APPLICATION_STATUSES,
        paths: getApplicationTrackerPaths(),
      }, {
        method: request.method,
        url: request.url,
        startedAt,
        meta: {
          applications: applications.length,
        },
      });
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/applications") {
      const body = await readJson(request);
      const result = await createApplication(body);
        const listingSnapshot = await shouldCaptureListingSnapshot(result.application, body)
          ? await captureListingPdfSnapshot(result.application, body).catch((error) => ({
            ok: false,
            error: error?.message || String(error),
          }))
        : null;
      const refreshedApplication = listingSnapshot?.application || result.application;
      return sendJson(response, 201, {
        ...result,
        application: refreshedApplication,
        listingSnapshot,
        statuses: APPLICATION_STATUSES,
        paths: getApplicationTrackerPaths(),
      }, {
        method: request.method,
        url: request.url,
        startedAt,
        meta: {
          created: result.created,
          id: result.application.id,
          listingSnapshotOk: Boolean(listingSnapshot?.ok),
          listingSnapshotFile: listingSnapshot?.filename || "",
          listingSnapshotError: listingSnapshot?.ok === false ? (listingSnapshot.error || "") : "",
        },
      });
    }

    if (request.method === "PUT" && requestUrl.pathname.startsWith("/api/applications/")) {
      const applicationId = decodeURIComponent(requestUrl.pathname.replace("/api/applications/", ""));
      const body = await readJson(request);
      const application = await updateApplication(applicationId, body);
      return sendJson(response, 200, {
        application,
        statuses: APPLICATION_STATUSES,
      }, {
        method: request.method,
        url: request.url,
        startedAt,
        meta: {
          id: applicationId,
        },
      });
    }

    if (request.method === "POST" && requestUrl.pathname.startsWith("/api/applications/") && requestUrl.pathname.endsWith("/upload")) {
      const applicationId = decodeURIComponent(requestUrl.pathname.replace("/api/applications/", "").replace("/upload", ""));
      const body = await readJson(request);
      const field = body?.field === "coverLetter" ? "coverLetter" : "resumeProvided";
      const upload = await saveApplicationDocument(applicationId, field, body);
      return sendJson(response, 200, upload, {
        method: request.method,
        url: request.url,
        startedAt,
        meta: {
          id: applicationId,
          field,
          filename: upload.filename,
        },
      });
    }

    if (request.method === "POST" && requestUrl.pathname.startsWith("/api/applications/") && requestUrl.pathname.endsWith("/regenerate-pdf")) {
      const applicationId = decodeURIComponent(requestUrl.pathname.replace("/api/applications/", "").replace("/regenerate-pdf", ""));
      const application = await getApplication(applicationId);
      if (!application) {
        return sendJson(response, 404, { error: "Application not found" }, {
          method: request.method,
          url: request.url,
          startedAt,
        });
      }

      const enrichedApplication = await enrichApplicationFromSource(application);
      const listingSnapshot = await captureListingPdfSnapshot(enrichedApplication, enrichedApplication);
      return sendJson(response, 200, {
        ok: true,
        application: listingSnapshot.application,
        listingSnapshot,
      }, {
        method: request.method,
        url: request.url,
        startedAt,
        meta: {
          id: applicationId,
          listingSnapshotOk: Boolean(listingSnapshot?.ok),
          listingSnapshotFile: listingSnapshot?.filename || "",
        },
      });
    }

    if (request.method === "DELETE" && requestUrl.pathname.startsWith("/api/applications/")) {
      const applicationId = decodeURIComponent(requestUrl.pathname.replace("/api/applications/", ""));
      const existingApplication = await getApplication(applicationId);
      await deleteApplication(applicationId);
      if (existingApplication) {
        const storagePaths = buildApplicationStoragePaths(existingApplication);
        await removeDirectoryWithRetry(storagePaths.applicationDir);
        await removeDirectoryIfEmpty(storagePaths.companyDir);
      }
      const remainingApplications = await listApplications();
      pruneJobStorageDirectories(remainingApplications).catch(() => {});
      return sendJson(response, 200, { ok: true }, {
        method: request.method,
        url: request.url,
        startedAt,
        meta: {
          id: applicationId,
        },
      });
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/applications/export.csv") {
      const buffer = await getApplicationsCsvBuffer();
      return sendBinary(response, 200, buffer, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="job-applications.csv"',
      });
    }

    if (request.method === "GET" && (requestUrl.pathname === "/api/applications/export.xlsx" || requestUrl.pathname === "/api/applications/open.xlsx")) {
        const buffer = await getApplicationsWorkbookBuffer();
        return sendBinary(response, 200, buffer, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `${requestUrl.pathname.endsWith("/open.xlsx") ? "inline" : "attachment"}; filename="job-applications.xlsx"`,
        });
      }

      if (
        request.method === "POST"
        && (requestUrl.pathname === "/api/applications/open-excel" || requestUrl.pathname === "/api/applications/open-csv")
      ) {
        const trackerPaths = getApplicationTrackerPaths();
        await getApplicationsWorkbookBuffer();
        return sendJson(response, 200, {
          ok: true,
          opened: false,
          path: trackerPaths.xlsxPath,
          openPath: "",
          downloadUrl: "/api/applications/open.xlsx",
          error: "",
        }, {
          method: request.method,
          url: request.url,
          startedAt,
          meta: {
            path: trackerPaths.xlsxPath,
            openPath: "",
            opened: false,
          },
        });
      }

    if (request.method === "GET" && requestUrl.pathname.startsWith("/api/applications/") && requestUrl.pathname.includes("/files/")) {
      const segments = requestUrl.pathname.split("/").filter(Boolean);
      const applicationId = decodeURIComponent(segments[2] || "");
      const filename = decodeURIComponent(segments.slice(4).join("/"));
      return serveApplicationFile(applicationId, filename, response);
    }

    if (request.method === "GET" && request.url?.startsWith("/api/search/status")) {
      const requestUrl = new URL(request.url, `http://127.0.0.1:${port}`);
      const searchRequestId = String(requestUrl.searchParams.get("id") || "").trim();
      const status = searchRequestId ? activeSearches.get(searchRequestId) : null;

      if (!status) {
        return sendJson(response, 404, { error: "Search status not found" }, {
          method: request.method,
          url: request.url,
          startedAt,
        });
      }

      return sendJson(response, 200, status, {
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
      const curatedSources = sources.filter((source) => !isGeneratedAtsSource(source));
      const generatedInventorySources = sources.filter((source) => isGeneratedAtsSource(source));
      const effectiveSearchSourceCount = curatedSources.length + (generatedInventorySources.length > 0 ? 1 : 0);
      const filters = buildSearchFilters(body);
      const searchRequestId = typeof body.searchRequestId === "string" && body.searchRequestId.trim()
        ? body.searchRequestId.trim()
        : "";

      if (searchRequestId) {
        beginTrackedSearch(searchRequestId, effectiveSearchSourceCount);
        updateTrackedSearch(searchRequestId, {
          stage: "loading_sources",
          message: effectiveSearchSourceCount > 0
            ? `Checking cache and loading ${effectiveSearchSourceCount} source groups`
            : "Checking cache and loading sources",
          detail: effectiveSearchSourceCount > 0
            ? generatedInventorySources.length > 0
              ? "JobTrawl is checking live boards and cached ATS inventory together."
              : "This can take a bit if several employer job boards are slow to respond."
            : "Preparing your search.",
          totalSources: effectiveSearchSourceCount,
        });
      }

        const shouldAllowLiveSync = curatedSources.length <= 25 || body.sourceSelectionMode === "custom";
        let completedSources = 0;
        let failedSources = 0;
        let cachedSources = 0;
        let liveSources = 0;
        let fallbackSources = 0;
        const liveSourceResults = await loadSourceResultsForSearch(curatedSources, filters, {
            allowSync: shouldAllowLiveSync,
            maxDurationMs: shouldAllowLiveSync ? 15000 : 6000,
            onSourceComplete: ({ result }) => {
          completedSources += 1;
          if (result?.error) {
            failedSources += 1;
          }

          const progressMode = String(result?.progressMeta?.mode || "");
          if (["fresh_cache", "cache_only", "generated_cache"].includes(progressMode)) {
            cachedSources += 1;
          } else if (["live_sync", "live_direct"].includes(progressMode)) {
            liveSources += 1;
          } else if (progressMode === "stale_cache_fallback") {
            fallbackSources += 1;
          }

          if (!searchRequestId) {
            return;
          }

          const rawProgress = effectiveSearchSourceCount > 0 ? completedSources / effectiveSearchSourceCount : 0;
          const visibleProgress = effectiveSearchSourceCount > 0
            ? 18 + Math.round(Math.sqrt(Math.max(0, rawProgress)) * 74)
            : 32;
          const percent = Math.min(92, visibleProgress);
          const remainingSources = Math.max(0, effectiveSearchSourceCount - completedSources);
          const earlyPhase = completedSources <= Math.max(3, Math.floor(effectiveSearchSourceCount * 0.12));
          const nearingFinish = completedSources >= Math.max(4, Math.floor(effectiveSearchSourceCount * 0.82));
          const detail = failedSources > 0
            ? `${failedSources} source${failedSources === 1 ? "" : "s"} failed or timed out, but the search will keep going.`
            : nearingFinish
              ? `Most sources are done. ${remainingSources > 0 ? `${remainingSources} still running in the background.` : "Wrapping up the source checks now."}`
              : liveSources > cachedSources
                ? "More live employer boards are being queried now, so this phase can take a little longer."
                : earlyPhase
                  ? "JobTrawl is checking cache first, then reaching out to employer job boards when fresh data is needed."
                  : "JobTrawl is mixing cached matches with live ATS and career-page checks behind the scenes.";
          const message = completedSources >= effectiveSearchSourceCount
            ? "Wrapping up the last source checks"
            : earlyPhase
              ? "Checking cache and starting source checks"
              : nearingFinish
                ? `Almost done loading sources (${remainingSources} left)`
                : liveSources > cachedSources
                  ? `Querying live ATS feeds and career pages (${completedSources}/${effectiveSearchSourceCount})`
                  : `Loading results from cache and live boards (${completedSources}/${effectiveSearchSourceCount})`;
          updateTrackedSearch(searchRequestId, {
            stage: "loading_sources",
            message,
            detail,
            completedSources,
            failedSources,
            cachedSources,
            liveSources,
            fallbackSources,
              percent,
            });
          },
        });
          if (!shouldAllowLiveSync && curatedSources.length > 0) {
            void ensureSourcesCached(curatedSources, filters).catch(() => {});
          }
          const generatedInventoryResult = generatedInventorySources.length > 0
            ? loadGeneratedInventorySearchResult(generatedInventorySources, filters)
            : null;

      if (generatedInventoryResult) {
        completedSources += 1;
        cachedSources += 1;
        if (searchRequestId) {
          updateTrackedSearch(searchRequestId, {
            stage: "loading_sources",
            message: "Loading generated ATS inventory",
            detail: `Cached ATS inventory contributed ${generatedInventoryResult.jobs.length} posting${generatedInventoryResult.jobs.length === 1 ? "" : "s"}.`,
            completedSources,
            failedSources,
            cachedSources,
            liveSources,
            fallbackSources,
            totalSources: effectiveSearchSourceCount,
            percent: Math.min(92, effectiveSearchSourceCount > 0
              ? 18 + Math.round(Math.sqrt(Math.max(0, completedSources / effectiveSearchSourceCount)) * 74)
              : 32),
          });
        }
      }

      const sourceResultsOverride = generatedInventoryResult
        ? [...liveSourceResults, generatedInventoryResult]
        : liveSourceResults;

      if (searchRequestId) {
        updateTrackedSearch(searchRequestId, {
          stage: "filtering",
          message: "Filtering, deduplicating, and sorting matches",
          detail: "Almost there. JobTrawl is cleaning up the combined results before showing them.",
          completedSources,
          failedSources,
          cachedSources,
          liveSources,
          fallbackSources,
          percent: 96,
        });
      }

      const result = await searchJobs({
        sources,
        filters,
        sourceResultsOverride,
      });

      if (isWebRepostLookupConfigured()) {
        await enrichJobsWithWebRepostSignals(result.jobs);
      }

      if (searchRequestId) {
        completeTrackedSearch(searchRequestId, {
          message: result.jobs.length > 0
            ? `Found ${result.jobs.length} matching job${result.jobs.length === 1 ? "" : "s"}`
            : "Search finished",
          detail: result.jobs.length > 0
            ? "Your results are ready."
            : "No jobs matched the current filters, but the search completed successfully.",
          completedSources,
          failedSources: result.meta.failedSources,
          cachedSources,
          liveSources,
          fallbackSources,
          totalSources: effectiveSearchSourceCount,
          percent: 100,
        });
      }

      return sendJson(response, 200, result, {
        method: request.method,
        url: request.url,
        startedAt,
        body,
        meta: {
          selectedSources: sources.length,
          jobs: result.jobs.length,
          failedSources: result.meta.failedSources,
          searchRequestId,
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
    tryMarkSearchFailed(request, error);
    const status = error?.code === "APPLICATION_NOT_FOUND" ? 404 : 500;
    sendJson(response, status, { error: error.message || "Unexpected error" }, {
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

function beginTrackedSearch(searchRequestId, totalSources = 0) {
  activeSearches.set(searchRequestId, {
    id: searchRequestId,
    stage: "queued",
    message: "Preparing your search",
    detail: "JobTrawl is setting up the source list.",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalSources,
    completedSources: 0,
    failedSources: 0,
    percent: 2,
  });
}

function updateTrackedSearch(searchRequestId, updates) {
  const existing = activeSearches.get(searchRequestId);
  if (!existing) {
    return;
  }

  activeSearches.set(searchRequestId, {
    ...existing,
    ...updates,
  });
}

function completeTrackedSearch(searchRequestId, updates = {}) {
  const existing = activeSearches.get(searchRequestId);
  if (!existing) {
    return;
  }

  activeSearches.set(searchRequestId, {
    ...existing,
    ...updates,
    stage: "completed",
    finishedAt: new Date().toISOString(),
    percent: 100,
  });
  scheduleTrackedSearchCleanup(searchRequestId);
}

function failTrackedSearch(searchRequestId, error) {
  const existing = activeSearches.get(searchRequestId);
  if (!existing) {
    return;
  }

  activeSearches.set(searchRequestId, {
    ...existing,
    stage: "error",
    message: "Search failed",
    detail: error?.message || String(error),
    finishedAt: new Date().toISOString(),
    percent: existing.percent || 0,
  });
  scheduleTrackedSearchCleanup(searchRequestId);
}

function scheduleTrackedSearchCleanup(searchRequestId) {
  setTimeout(() => {
    activeSearches.delete(searchRequestId);
  }, SEARCH_STATUS_TTL_MS).unref?.();
}

function tryMarkSearchFailed(request, error) {
  if (!request || request.method !== "POST" || request.url !== "/api/search") {
    return;
  }

  const searchRequestId = request.searchRequestIdForTracking;
  if (!searchRequestId) {
    return;
  }

  failTrackedSearch(searchRequestId, error);
}

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
  const selectedSources = customizationMode === "companies"
    ? sources.filter((source) => includedCompanies.has(normalizeCompanyKey(source.company)))
    : [
      ...(selectedAtsProviderKeys.size > 0
        ? atsSources.filter((source) => selectedAtsProviderKeys.has(String(source?.provider || "").toLowerCase()))
        : atsSources),
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
  return Array.isArray(sources) ? sources : [];
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
    if (source.generatedInventory || source.inventorySource === "generated_ats") {
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

  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (request?.url === "/api/search" && request?.method === "POST") {
    request.searchRequestIdForTracking = typeof parsed?.searchRequestId === "string" ? parsed.searchRequestId.trim() : "";
  }
  return parsed;
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

function sendBinary(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    ...headers,
  });
  response.end(payload);
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
  if (filePath.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (filePath.endsWith(".doc")) {
    return "application/msword";
  }
  if (filePath.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (filePath.endsWith(".rtf")) {
    return "application/rtf";
  }
  return "text/plain; charset=utf-8";
}

async function saveApplicationDocument(applicationId, field, body = {}) {
  const filename = sanitizeUploadFilename(body.filename || `${field}.bin`);
  const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64 : "";

  if (!applicationId || !filename || !contentBase64) {
    const error = new Error("Missing upload data");
    error.code = "INVALID_UPLOAD";
    throw error;
  }

  const buffer = Buffer.from(contentBase64, "base64");
  const applicationRecord = await getApplication(applicationId);
  if (!applicationRecord) {
    const error = new Error("Application not found");
    error.code = "APPLICATION_NOT_FOUND";
    throw error;
  }

  const applicationDir = buildApplicationStoragePaths(applicationRecord).applicationDir;
  await fs.mkdir(applicationDir, { recursive: true });
  const storedFilename = `${field}-${Date.now()}-${filename}`;
  const filePath = path.join(applicationDir, storedFilename);
  await fs.writeFile(filePath, buffer);

  const fileUrl = `/api/applications/${encodeURIComponent(applicationId)}/files/${encodeURIComponent(storedFilename)}`;
  const application = await updateApplication(applicationId, {
    [field]: fileUrl,
  });

  return {
    application,
    field,
    fileUrl,
    filename: storedFilename,
  };
}

async function serveApplicationFile(applicationId, filename, response) {
  const applicationRecord = await getApplication(applicationId);
  if (!applicationRecord) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const applicationDir = buildApplicationStoragePaths(applicationRecord).applicationDir;
  const safeFilename = sanitizeUploadFilename(filename);
  const filePath = path.join(applicationDir, safeFilename);

  const resolvedDir = path.resolve(applicationDir);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedDir)) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid file path");
    return;
  }

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

function sanitizeUploadFilename(filename) {
  const base = path.basename(String(filename || "").trim());
  return base.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function sanitizePathSegment(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function buildApplicationStoragePaths(application = {}) {
  const companySegment = formatFolderSegment(application.storageCompanySegment || application.company || "Uncategorized");
  const roleSegment = formatFolderSegment(application.storageRoleSegment || application.position || application.jobId || "application");
  return {
    companyDir: path.join(jobsDataDir, companySegment),
    applicationDir: path.join(jobsDataDir, companySegment, roleSegment),
  };
}

function formatFolderSegment(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "item";
}

async function removeDirectoryWithRetry(targetDir) {
  if (!targetDir) {
    return;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") {
        return;
      }

      await wait(120 * (attempt + 1));
    }
  }

  await removeDirectoryWithPowerShell(targetDir).catch(() => {});
}

async function removeDirectoryIfEmpty(targetDir) {
  if (!targetDir) {
    return;
  }

  try {
    const entries = await fs.readdir(targetDir);
    if (entries.length === 0) {
      await fs.rmdir(targetDir).catch(() => {});
    }
  } catch {
    // ignore best-effort cleanup errors
  }
}

async function pruneJobStorageDirectories(applications = []) {
  const validCompanyDirs = new Set();
  const validApplicationDirs = new Set();

  for (const application of applications) {
    const storagePaths = buildApplicationStoragePaths(application);
    validCompanyDirs.add(path.resolve(storagePaths.companyDir));
    validApplicationDirs.add(path.resolve(storagePaths.applicationDir));
  }

  let companyEntries = [];
  try {
    companyEntries = await fs.readdir(jobsDataDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const companyEntry of companyEntries) {
    if (!companyEntry.isDirectory()) {
      continue;
    }

    const companyDir = path.resolve(path.join(jobsDataDir, companyEntry.name));
    if (!validCompanyDirs.has(companyDir)) {
      await removeDirectoryWithRetry(companyDir);
      continue;
    }

    let applicationEntries = [];
    try {
      applicationEntries = await fs.readdir(companyDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const applicationEntry of applicationEntries) {
      if (!applicationEntry.isDirectory()) {
        continue;
      }

      const applicationDir = path.resolve(path.join(companyDir, applicationEntry.name));
      if (!validApplicationDirs.has(applicationDir)) {
        await removeDirectoryWithRetry(applicationDir);
      }
    }

    await removeDirectoryIfEmpty(companyDir);
  }
}

async function openLocalFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Start-Process -FilePath '${escapePowerShellLiteral(resolvedPath)}'`,
  ], {
    timeout: 10000,
    windowsHide: true,
  });
}

async function removeDirectoryWithPowerShell(targetDir) {
  const resolvedPath = path.resolve(targetDir);
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Remove-Item -LiteralPath '${escapePowerShellLiteral(resolvedPath)}' -Recurse -Force -ErrorAction Stop`,
  ], {
    timeout: 15000,
    windowsHide: true,
  });
}

async function shouldCaptureListingSnapshot(application, body = {}) {
  const normalizedUrl = normalizeUrlForSnapshot(body.jobUrl || application?.jobUrl);
  if (!normalizedUrl) {
    return false;
  }

  const existingFileUrl = String(application?.pdfCopyOfListing || "").trim();
  if (!existingFileUrl) {
    return true;
  }

  return !(await isExistingListingSnapshotUsable(application, existingFileUrl));
}

async function isExistingListingSnapshotUsable(application, fileUrl) {
  const filename = decodeURIComponent(String(fileUrl || "").split("/files/")[1] || "").trim();
  if (!filename) {
    return false;
  }

  const filePath = path.join(buildApplicationStoragePaths(application).applicationDir, filename);
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return false;
  }

  if (!stats.isFile() || stats.size < 1200) {
    return false;
  }

  try {
    const parser = new PDFParse({ data: await fs.readFile(filePath) });
    try {
      const parsed = await parser.getText();
      const text = String(parsed?.text || "").replace(/\s+/g, " ").trim();
      const normalizedText = text.toLowerCase();
      const title = String(application?.position || "").toLowerCase();
      const company = String(application?.company || "").toLowerCase();

      if (text.length < 160) {
        return false;
      }

      if (normalizedText.includes("search jobs") || normalizedText.includes("pretty-print")) {
        return false;
      }

      if (/^\s*\{?"id":/i.test(text) || normalizedText.includes('{"id":')) {
        return false;
      }

      return Boolean(
        (title && normalizedText.includes(title.slice(0, Math.min(title.length, 24))))
        || (company && normalizedText.includes(company))
        || normalizedText.includes("company:")
        || normalizedText.includes("position:")
      );
    } finally {
      parser.destroy().catch(() => {});
    }
  } catch {
    return false;
  }
}

async function captureListingPdfSnapshot(application, sourceData = {}) {
  const jobUrl = normalizeUrlForSnapshot(application?.jobUrl);
  if (!jobUrl) {
    return { ok: false, error: "Missing job listing URL" };
  }

  const applicationDir = buildApplicationStoragePaths(application).applicationDir;
  await fs.mkdir(applicationDir, { recursive: true });
  const pdfFilename = sanitizeUploadFilename(`listing-${Date.now()}.pdf`);
  const pdfPath = path.join(applicationDir, pdfFilename);
  let domHtml = "";
  let captureError = "";

  try {
    const browserPath = await findHeadlessBrowserPath();
    const profileDir = path.join(
      os.tmpdir(),
      "jobtrawl-browser-profiles",
      `${sanitizePathSegment(application.id || "application")}-${Date.now()}`
    );

      try {
        await fs.mkdir(profileDir, { recursive: true });
        domHtml = await dumpPageDomWithBrowser(browserPath, jobUrl, profileDir);
        const blockReason = detectBlockedListing(domHtml);
        if (blockReason) {
          throw new Error(blockReason);
        }

        if (shouldPreferTextListingSnapshot(jobUrl)) {
          throw new Error("Using text snapshot for higher-fidelity listing capture");
        }

        await printPageToPdfWithBrowser(browserPath, jobUrl, pdfPath, profileDir);

        const stats = await fs.stat(pdfPath).catch(() => null);
        if (!stats || stats.size < 1200) {
          throw new Error("Listing PDF was blank or too small to trust");
        }
    } finally {
      await removeDirectoryWithRetry(profileDir);
    }
  } catch (error) {
    captureError = error?.message || String(error);
    const fetchedHtml = await fetchListingHtml(jobUrl).catch(() => "");
    const scrapedText = buildListingTextSnapshot(application, sourceData, {
      browserHtml: domHtml,
      fetchedHtml,
    });
    const pdfBuffer = buildListingTextPdfBuffer({
      title: application?.position || application?.company || "Job listing snapshot",
      sourceUrl: jobUrl,
      company: application?.company || "",
      position: application?.position || "",
      jobId: application?.jobId || "",
      compensation: application?.compensation || sourceData?.compensation || "",
      scrapedText,
      fallbackReason: captureError,
    });
    await fs.writeFile(pdfPath, pdfBuffer);
  }

  const fileUrl = `/api/applications/${encodeURIComponent(application.id)}/files/${encodeURIComponent(pdfFilename)}`;
  const updatedApplication = await updateApplication(application.id, {
    pdfCopyOfListing: fileUrl,
  });

  return {
    ok: true,
    application: updatedApplication,
    fileUrl,
    filename: pdfFilename,
    captureMode: captureError ? "text-fallback" : "webpage",
    fallbackReason: captureError,
  };
}

async function enrichApplicationFromSource(application) {
  const currentText = String(
    application?.listingTextSnapshot
    || application?.searchText
    || application?.descriptionSnippet
    || ""
  ).trim();
  if (currentText.length >= 2000) {
    return application;
  }

  const sources = await loadSourceConfig();
  const matchingSource = selectLikelySourceForApplication(application, sources);
  if (!matchingSource) {
    return application;
  }

  try {
    const jobs = await fetchJobsForSource(matchingSource, {});
    const matchedJob = findMatchingSourceJob(application, jobs);
    if (!matchedJob) {
      return application;
    }

    return await updateApplication(application.id, {
      jobId: application.jobId || matchedJob.id || "",
      compensation: application.compensation || matchedJob.compensation || "",
      listingTextSnapshot: String(matchedJob.searchText || matchedJob.descriptionSnippet || application.listingTextSnapshot || "").trim(),
      descriptionSnippet: String(matchedJob.descriptionSnippet || application.descriptionSnippet || "").trim(),
      searchText: String(matchedJob.searchText || matchedJob.descriptionSnippet || application.searchText || "").trim(),
    });
  } catch {
    return application;
  }
}

function selectLikelySourceForApplication(application, sources = []) {
  const appCompany = normalizeComparableValue(application?.company);
  const appProvider = inferProviderFromJobUrl(application?.jobUrl);
  const candidates = sources.filter((source) => {
    const sourceCompany = normalizeComparableValue(source.company);
    const sameCompany = appCompany && sourceCompany === appCompany;
    const sameProvider = appProvider && source.provider === appProvider;
    return sameCompany || (sameCompany && sameProvider) || sameProvider;
  });

  if (appCompany && appProvider) {
    return candidates.find((source) => normalizeComparableValue(source.company) === appCompany && source.provider === appProvider) || candidates[0] || null;
  }

  return candidates[0] || null;
}

function findMatchingSourceJob(application, jobs = []) {
  const appUrl = normalizeComparableUrl(application?.jobUrl);
  const appJobId = normalizeComparableValue(application?.jobId);
  const appPosition = normalizeComparableValue(application?.position);

  return jobs.find((job) => {
    const jobUrl = normalizeComparableUrl(job.applyUrl);
    const jobId = normalizeComparableValue(job.id || job.jobId);
    const position = normalizeComparableValue(job.title);
    return (appUrl && jobUrl && appUrl === jobUrl)
      || (appJobId && jobId && appJobId === jobId)
      || (appPosition && position && appPosition === position);
  }) || null;
}

function inferProviderFromJobUrl(jobUrl) {
  try {
    const parsed = new URL(String(jobUrl || ""));
    const host = parsed.hostname.toLowerCase();
    if (host.includes("ashbyhq.com")) return "ashby";
    if (host.includes("greenhouse.io")) return "greenhouse";
    if (host.includes("lever.co")) return "lever";
    if (host.includes("smartrecruiters.com")) return "smartrecruiters";
    if (host.includes("myworkdayjobs.com") || host.includes(".wd")) return "workday";
    if (host.includes("careers.microsoft.com") || host.includes("apply.careers.microsoft.com")) return "pcsx";
    if (host.includes("expediagroup.com")) return "careerpage";
    if (host.includes("jobvite.com")) return "jobvite";
    if (host.includes("applytojob.com")) return "applytojob";
    if (host.includes("applicantpro.com")) return "applicantpro";
    if (host.includes("icims.com")) return "icims";
    if (host.includes("ultipro.com") || host.includes("ukg.com")) return "ultipro";
    if (host.includes("taleo.net")) return "taleo";
    if (host.includes("breezy.hr")) return "breezy";
    if (host.includes("careerplug.com")) return "careerplug";
    if (host.includes("teamtailor.com")) return "teamtailor";
    if (host.includes("talentreef.com")) return "talentreef";
    if (host.includes("manatal.com")) return "manatal";
    if (host.includes("join.com")) return "join";
    if (host.includes("zoho.com")) return "zoho";
    if (host.includes("bamboohr.com")) return "bamboohr";
    if (host.includes("getro.com")) return "getro";
  } catch {}
  return "";
}

function normalizeComparableValue(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeComparableUrl(value) {
  try {
    return new URL(String(value || "").trim()).toString().toLowerCase();
  } catch {
    return "";
  }
}

function isGeneratedAtsSource(source) {
  return Boolean(
    source?.generatedInventory
    || source?.inventorySource === "generated_ats"
  );
}

async function findHeadlessBrowserPath() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }

  throw new Error("No supported headless browser found for listing capture");
}

async function dumpPageDomWithBrowser(browserPath, jobUrl, profileDir) {
  const { stdout } = await execFileAsync(browserPath, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-crash-reporter",
    "--disable-features=Crashpad",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=18000",
    `--user-data-dir=${profileDir}`,
    "--dump-dom",
    jobUrl,
  ], {
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });

  return String(stdout || "");
}

async function printPageToPdfWithBrowser(browserPath, jobUrl, pdfPath, profileDir) {
  await execFileAsync(browserPath, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-crash-reporter",
    "--disable-features=Crashpad",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=18000",
    `--user-data-dir=${profileDir}`,
    "--print-to-pdf-no-header",
    `--print-to-pdf=${pdfPath}`,
    jobUrl,
  ], {
    timeout: 40000,
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
  });
}

async function fetchListingHtml(jobUrl) {
  const response = await fetch(jobUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Listing fetch failed (${response.status})`);
  }

  return await response.text();
}

function buildListingTextSnapshot(application, sourceData = {}, html = "") {
  const browserHtml = typeof html === "object" && html !== null ? String(html.browserHtml || "") : String(html || "");
  const fetchedHtml = typeof html === "object" && html !== null ? String(html.fetchedHtml || "") : "";

  const browserBlockReason = detectBlockedListing(browserHtml);
  const fetchedBlockReason = detectBlockedListing(fetchedHtml);
  const browserStructuredText = extractStructuredListingText(browserHtml);
  const fetchedStructuredText = extractStructuredListingText(fetchedHtml);
  const preferredHtml = fetchedHtml && (!fetchedBlockReason || fetchedStructuredText)
    ? fetchedHtml
    : browserHtml;
  const preferredBlockReason = detectBlockedListing(preferredHtml);
  const structuredHtmlText = extractStructuredListingText(preferredHtml);
  const visibleHtmlText = preferredBlockReason ? "" : extractVisibleHtmlText(preferredHtml);
  return mergeListingTextCandidates(
    structuredHtmlText,
    sourceData.listingTextSnapshot,
    sourceData.searchText,
    sourceData.descriptionSnippet,
    visibleHtmlText,
    browserStructuredText,
    fetchedStructuredText,
    browserBlockReason && fetchedHtml && (!fetchedBlockReason || fetchedStructuredText) ? extractVisibleHtmlText(fetchedHtml) : ""
  ).trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapePowerShellLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}
