import { fetchJobsForSource } from "./adapters/index.js";
import { deriveEmployerCompany, deriveLocationMetadata, fetchDescriptionFallback, hasUsableDescriptionText } from "./adapters/shared.js";
import {
  calculateJobDistanceMiles,
  buildJobContentSignature,
  buildJobDuplicateSignature,
  buildJobListingKey,
  extractCanonicalJobId,
  hasSpecifiedLocation,
  hasExplicitNonUsLocation,
  inferWorkArrangement,
  isExpiredJob,
  isLikelyJobPosting,
  evaluateRecency,
  evaluateKeywordMatch,
  evaluateLegacyKeywordMatch,
  matchesKeyword,
  matchesLocationGroups,
  matchesRecency,
  matchesUnitedStates,
  normalizeText,
  normalizeWorkArrangement,
  uniqueBy,
} from "./filters.js";

const DESCRIPTION_ENRICH_CONCURRENCY = 8;
const MAX_DESCRIPTION_ENRICH_JOBS = 60;
const MAX_BROAD_SEARCH_DESCRIPTION_ENRICH_JOBS = 12;
const DESCRIPTION_ENRICH_TIMEOUT_MS = 3500;

export async function searchJobs({ sources, filters, sourceResultsOverride, skipDescriptionEnrichment = false }) {
  const timings = {};
  const markTiming = (name, startedAt) => {
    timings[name] = Date.now() - startedAt;
  };
  let stepStartedAt = Date.now();
  const sourceResults = sourceResultsOverride || await Promise.all(
    sources.map(async (source) => {
      try {
        const jobs = await fetchJobsForSource(source, filters);
        return { source, jobs, error: null };
      } catch (error) {
        return { source, jobs: [], error: error.message };
      }
    })
  );
  markTiming("sourceResultsMs", stepStartedAt);

  const includedCompanies = new Set((filters.includedCompanies || []).map((name) => normalizeText(name)));
  const excludedCompanies = new Set((filters.excludedCompanies || []).map((name) => name.toLowerCase()));
  const selectedArrangements = new Set((filters.arrangements || []).map((value) => normalizeWorkArrangement(value)));
  const maxDistanceMiles = Number(filters.distanceMiles);
  const useDistanceFilter = Number.isFinite(maxDistanceMiles) && maxDistanceMiles > 0 && filters.userCoordinates;
  const hasManualLocationFilter = hasActiveLocationGroups(filters.locationGroups);
  const matchedCounts = new Map(sourceResults.map((result) => [result.source.key, { matchedCount: 0, datedCount: 0, unknownDateCount: 0 }]));

  const jobs = [];
  const unknownDateMatches = [];
  const unknownLocationMatches = [];
  const nonUsDroppedJobs = [];

  stepStartedAt = Date.now();
  for (const result of sourceResults) {
    for (const job of result.jobs) {
      const arrangement = normalizeWorkArrangement(job.workArrangement);
      const enriched = {
        ...job,
        workArrangement: arrangement,
        distanceMiles: null,
        locationMatched: false,
        locationUnknown: false,
        usLocationUnknown: false,
        arrangementUnknown: false,
      };
      const derivedLocation = deriveLocationMetadata(enriched);

      if ((!enriched.locationLabel || enriched.locationLabel === "Unspecified" || /^united states$/i.test(String(enriched.locationLabel || "").trim()))
        && derivedLocation.locationLabel) {
        enriched.locationLabel = derivedLocation.locationLabel;
      }
      if (!enriched.city && derivedLocation.city) {
        enriched.city = derivedLocation.city;
      }
      if (!enriched.region && derivedLocation.region) {
        enriched.region = derivedLocation.region;
      }
      if (!enriched.country && derivedLocation.country) {
        enriched.country = derivedLocation.country;
      }
      if ((!enriched.rawLocationText || enriched.rawLocationText === "Unspecified") && derivedLocation.rawLocationText) {
        enriched.rawLocationText = derivedLocation.rawLocationText;
      }

      if (!matchesIncludedCompanies(enriched, includedCompanies)) {
        continue;
      }

      if (excludedCompanies.has(enriched.company.toLowerCase())) {
        continue;
      }

      if (!isLikelyJobPosting(enriched)) {
        continue;
      }

      if (!matchesKeyword(enriched, filters.keyword, filters.keywordScope, filters.keywordMode)) {
        continue;
      }

      if (isExpiredJob(enriched)) {
        continue;
      }

      applyResolvedRecency(enriched);
      const hasKnownDate = Boolean(enriched.parsedRecencyDate);
      const hasKnownLocation = hasSpecifiedLocation(enriched);
      const recencyEvaluation = evaluateRecency(enriched, filters.recency);
      if (!recencyEvaluation.matches) {
        continue;
      }

      if (filters.usOnly) {
        if (matchesUnitedStates(enriched)) {
          enriched.locationUnknown = false;
          enriched.usLocationUnknown = false;
        } else if (!hasExplicitNonUsLocation(enriched)) {
          enriched.locationUnknown = true;
          enriched.usLocationUnknown = true;
          unknownLocationMatches.push(enriched);
          continue;
        } else {
          nonUsDroppedJobs.push(enriched);
          continue;
        }
      }

      if (selectedArrangements.size > 0) {
        if (arrangement === "unknown") {
          enriched.arrangementUnknown = true;
        } else if (!selectedArrangements.has(arrangement)) {
          continue;
        }
      }

      if (useDistanceFilter) {
        const distanceMiles = calculateJobDistanceMiles(enriched, filters.userCoordinates);
        if (!Number.isFinite(distanceMiles)) {
          if (!hasKnownLocation) {
            enriched.locationUnknown = true;
          } else {
            continue;
          }
        } else if (distanceMiles > maxDistanceMiles) {
          continue;
        } else {
          enriched.distanceMiles = distanceMiles;
          enriched.locationMatched = true;
        }
      } else {
        const shouldApplyManualLocationFilter = needsLocationFilter(arrangement, filters);
        const manualLocationMatched = matchesLocationGroups(enriched, filters.locationGroups);
        if (shouldApplyManualLocationFilter && !manualLocationMatched) {
          if (hasManualLocationFilter && !hasKnownLocation) {
            enriched.locationUnknown = true;
          } else {
            continue;
          }
        } else {
          enriched.locationMatched = manualLocationMatched;
        }
      }

      jobs.push(enriched);
      const counts = matchedCounts.get(result.source.key);
      counts.matchedCount += 1;
      if (enriched.parsedRecencyDate) {
        counts.datedCount += 1;
      } else {
        counts.unknownDateCount += 1;
      }
    }
  }
  markTiming("initialFilterMs", stepStartedAt);

  stepStartedAt = Date.now();
  if (!skipDescriptionEnrichment) {
    await enrichMissingDescriptions(jobs, filters);
    await enrichMissingDescriptions(unknownDateMatches, filters);
    await enrichMissingDescriptions(unknownLocationMatches, filters);
  }
  markTiming("descriptionEnrichmentMs", stepStartedAt);

  stepStartedAt = Date.now();
  reconcileUnknownDateMatches(jobs, unknownDateMatches, filters);
  removeExpiredJobs(jobs);
  removeExpiredJobs(unknownDateMatches);
  removeExpiredJobs(unknownLocationMatches);
  refreshDerivedJobMetadata(jobs);
  refreshDerivedJobMetadata(unknownDateMatches);
  refreshDerivedJobMetadata(unknownLocationMatches);
  backfillCompensation(jobs);
  backfillCompensation(unknownDateMatches);
  backfillCompensation(unknownLocationMatches);
  filterUnknownDateMatches(unknownDateMatches, filters);
  filterUnknownLocationMatches(unknownLocationMatches, filters);
  markTiming("metadataRefreshMs", stepStartedAt);

  stepStartedAt = Date.now();
  const annotated = annotatePossibleDuplicates(jobs);
  const annotatedUnknownDate = annotatePossibleDuplicates(unknownDateMatches);
  const annotatedUnknownLocation = annotatePossibleDuplicates(unknownLocationMatches);
  const aggregated = aggregateJobsByListingKey(annotated);
  const aggregatedUnknownDate = aggregateJobsByListingKey(annotatedUnknownDate);
  const aggregatedUnknownLocation = aggregateJobsByListingKey(annotatedUnknownLocation);
  const deduped = uniqueBy(
    aggregated.sort(sortJobs),
    buildSearchDedupKey
  );
  const dedupedUnknownDate = uniqueBy(
    aggregatedUnknownDate.sort(sortJobs),
    buildSearchDedupKey
  ).filter((job) => !deduped.some((datedJob) => buildSearchDedupKey(datedJob) === buildSearchDedupKey(job)));
  const knownResultKeys = new Set([
    ...deduped.map(buildSearchDedupKey),
    ...dedupedUnknownDate.map(buildSearchDedupKey),
  ]);
  const dedupedUnknownLocation = uniqueBy(
    aggregatedUnknownLocation.sort(sortJobs),
    buildSearchDedupKey
  ).filter((job) => !knownResultKeys.has(buildSearchDedupKey(job)));
  markTiming("dedupeAndAggregateMs", stepStartedAt);

  return {
    jobs: deduped,
    unknownDateJobs: dedupedUnknownDate,
    unknownLocationJobs: dedupedUnknownLocation,
    confirmedUsJobs: filters.usOnly ? deduped : [],
    nonUsDroppedJobs: nonUsDroppedJobs.slice(0, 50),
    confirmedUsCount: filters.usOnly ? deduped.length : 0,
    unknownLocationCount: dedupedUnknownLocation.length,
    nonUsDroppedCount: nonUsDroppedJobs.length,
    headlineCount: filters.usOnly ? deduped.length : deduped.length,
    sources: sourceResults.map((result) => ({
      key: result.source.key,
      company: result.source.company,
      provider: result.source.provider,
      jobCount: matchedCounts.get(result.source.key)?.matchedCount || 0,
      rawJobCount: result.jobs.length,
      datedCount: matchedCounts.get(result.source.key)?.datedCount || 0,
      unknownDateCount: matchedCounts.get(result.source.key)?.unknownDateCount || 0,
      error: result.error,
    })),
    meta: {
      searchedSources: sourceResults.length,
      successfulSources: sourceResults.filter((result) => !result.error).length,
      failedSources: sourceResults.filter((result) => result.error).length,
      activeLocations: filters.locationGroups || [],
      selectedArrangements: [...selectedArrangements],
      distanceFilterApplied: Boolean(useDistanceFilter),
      headlineCount: filters.usOnly ? deduped.length : deduped.length,
      confirmedUsCount: filters.usOnly ? deduped.length : 0,
      unknownLocationCount: dedupedUnknownLocation.length,
      nonUsDroppedCount: nonUsDroppedJobs.length,
      searchTimings: timings,
    },
  };
}

export function analyzeSourceFilterFunnel(jobs, filters = {}) {
  const parsedJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const normalizedJobs = parsedJobs.map((job) => prepareJobForFiltering(job));
  const recencyEvaluations = normalizedJobs.map((job) => ({
    job,
    evaluation: evaluateRecency(job, filters.recency),
    within24h: evaluateRecency(job, "24h"),
    within7d: evaluateRecency(job, "7d"),
  }));
  const dateFilteredJobs = recencyEvaluations
    .filter((entry) => entry.evaluation.matches)
    .map((entry) => entry.job);
  const keywordEvaluations = dateFilteredJobs.map((job) => ({
    job,
    current: evaluateKeywordMatch(job, filters.keyword, filters.keywordScope, filters.keywordMode),
    strict: evaluateKeywordMatch(job, filters.keyword, filters.keywordScope, "strict"),
    loose: evaluateKeywordMatch(job, filters.keyword, filters.keywordScope, "loose"),
    legacyStrict: evaluateLegacyKeywordMatch(job, filters.keyword, filters.keywordScope, "strict"),
    legacyLoose: evaluateLegacyKeywordMatch(job, filters.keyword, filters.keywordScope, "loose"),
  }));
  const keywordFilteredJobs = keywordEvaluations
    .filter((entry) => entry.current.matches)
    .map((entry) => entry.job);
  const dedupedJobs = uniqueBy(
    aggregateJobsByListingKey(annotatePossibleDuplicates(keywordFilteredJobs))
      .filter(Boolean)
      .sort(sortJobs),
    buildSearchDedupKey
  );
  const finalJobs = dedupedJobs.filter((job) => passesFinalFilters(job, filters));

  const stageCounts = {
    parsed: parsedJobs.length,
    normalized: normalizedJobs.length,
    dateFiltered: dateFilteredJobs.length,
    keywordFiltered: keywordFilteredJobs.length,
    deduped: finalJobs.length < dedupedJobs.length ? dedupedJobs.length : dedupedJobs.length,
    final: finalJobs.length,
    within24h: recencyEvaluations.filter((entry) => entry.within24h.reason === "within_window" && entry.within24h.matches).length,
    within7d: recencyEvaluations.filter((entry) => entry.within7d.reason === "within_window" && entry.within7d.matches).length,
    unknownDate: recencyEvaluations.filter((entry) => entry.evaluation.reason === "unknown_date").length,
    droppedAsOld: recencyEvaluations.filter((entry) => entry.evaluation.reason === "old").length,
    droppedAsInvalidDate: recencyEvaluations.filter((entry) => entry.evaluation.reason === "invalid_date" && !entry.evaluation.matches).length,
  };

  const stageFlags = buildStageDropFlags({
    fetched: null,
    ...stageCounts,
  });

  return {
    stageCounts,
    stageFlags,
    keywordAudit: buildKeywordAudit(keywordEvaluations, filters),
  };
}

function prepareJobForFiltering(job) {
  const arrangement = normalizeWorkArrangement(job?.workArrangement);
  const enriched = {
    ...job,
    workArrangement: arrangement,
    distanceMiles: null,
    locationMatched: false,
    locationUnknown: false,
    usLocationUnknown: false,
    arrangementUnknown: false,
  };
  const derivedLocation = deriveLocationMetadata(enriched);

  if ((!enriched.locationLabel || enriched.locationLabel === "Unspecified" || /^united states$/i.test(String(enriched.locationLabel || "").trim()))
    && derivedLocation.locationLabel) {
    enriched.locationLabel = derivedLocation.locationLabel;
  }
  if (!enriched.city && derivedLocation.city) {
    enriched.city = derivedLocation.city;
  }
  if (!enriched.region && derivedLocation.region) {
    enriched.region = derivedLocation.region;
  }
  if (!enriched.country && derivedLocation.country) {
    enriched.country = derivedLocation.country;
  }
  if ((!enriched.rawLocationText || enriched.rawLocationText === "Unspecified") && derivedLocation.rawLocationText) {
    enriched.rawLocationText = derivedLocation.rawLocationText;
  }

  applyResolvedRecency(enriched);

  return enriched;
}

function passesFinalFilters(job, filters = {}) {
  const includedCompanies = new Set((filters.includedCompanies || []).map((name) => normalizeText(name)));
  const excludedCompanies = new Set((filters.excludedCompanies || []).map((name) => String(name || "").toLowerCase()));
  const selectedArrangements = new Set((filters.arrangements || []).map((value) => normalizeWorkArrangement(value)));
  const maxDistanceMiles = Number(filters.distanceMiles);
  const useDistanceFilter = Number.isFinite(maxDistanceMiles) && maxDistanceMiles > 0 && filters.userCoordinates;
  const hasManualLocationFilter = hasActiveLocationGroups(filters.locationGroups);
  const arrangement = normalizeWorkArrangement(job?.workArrangement);
  const hasKnownLocation = hasSpecifiedLocation(job);

  if (!matchesIncludedCompanies(job, includedCompanies)) {
    return false;
  }
  if (excludedCompanies.has(String(job?.company || "").toLowerCase())) {
    return false;
  }
  if (!isLikelyJobPosting(job)) {
    return false;
  }
  if (isExpiredJob(job) || job?.invalidApplyPage || isUnrecoverableListing(job)) {
    return false;
  }

  if (filters.usOnly && !matchesUnitedStates(job) && hasKnownLocation) {
    return false;
  }

  if (selectedArrangements.size > 0 && arrangement !== "unknown" && !selectedArrangements.has(arrangement)) {
    return false;
  }

  if (useDistanceFilter) {
    const distanceMiles = calculateJobDistanceMiles(job, filters.userCoordinates);
    if (Number.isFinite(distanceMiles)) {
      return distanceMiles <= maxDistanceMiles;
    }
    return !hasKnownLocation;
  }

  const shouldApplyManualLocationFilter = needsLocationFilter(arrangement, filters);
  const manualLocationMatched = matchesLocationGroups(job, filters.locationGroups);
  if (shouldApplyManualLocationFilter && !manualLocationMatched && hasKnownLocation) {
    return false;
  }
  if (shouldApplyManualLocationFilter && !manualLocationMatched && hasManualLocationFilter) {
    return !hasKnownLocation;
  }

  return true;
}

function buildStageDropFlags(stageCounts = {}) {
  const order = ["fetched", "parsed", "normalized", "dateFiltered", "keywordFiltered", "deduped", "final"];
  const flags = [];

  for (let index = 1; index < order.length; index += 1) {
    const previousKey = order[index - 1];
    const currentKey = order[index];
    const previousValue = Number(stageCounts?.[previousKey]);
    const currentValue = Number(stageCounts?.[currentKey]);
    if (!Number.isFinite(previousValue) || previousValue <= 0 || !Number.isFinite(currentValue)) {
      continue;
    }

    const dropCount = previousValue - currentValue;
    const dropRatio = dropCount / previousValue;
    if (dropRatio > 0.5) {
      flags.push({
        stage: currentKey,
        previousStage: previousKey,
        previousCount: previousValue,
        currentCount: currentValue,
        dropCount,
        dropRatio,
      });
    }
  }

  return flags;
}

function buildKeywordAudit(keywordEvaluations = [], filters = {}) {
  const evaluations = Array.isArray(keywordEvaluations) ? keywordEvaluations : [];
  const currentMode = filters.keywordMode || "strict";
  const currentPassed = evaluations.filter((entry) => entry.current?.matches);
  const currentRejected = evaluations.filter((entry) => !entry.current?.matches);

  return {
    keyword: filters.keyword || "",
    keywordScope: filters.keywordScope || "title_and_description",
    keywordMode: currentMode,
    enteringKeywordFilter: evaluations.length,
    passedKeywordFilter: currentPassed.length,
    rejectedKeywordFilter: currentRejected.length,
    sampleAcceptedTitles: buildKeywordTitleSamples(currentPassed, "current", 10),
    sampleRejectedTitles: buildKeywordTitleSamples(currentRejected, "current", 10),
    rejectionReasons: buildKeywordReasonCounts(currentRejected, "current"),
    modeComparison: {
      legacyStrict: buildKeywordModeSummary(evaluations, "legacyStrict"),
      legacyLoose: buildKeywordModeSummary(evaluations, "legacyLoose"),
      strict: buildKeywordModeSummary(evaluations, "strict"),
      loose: buildKeywordModeSummary(evaluations, "loose"),
    },
  };
}

function buildKeywordModeSummary(evaluations = [], modeKey) {
  const matched = evaluations.filter((entry) => entry?.[modeKey]?.matches);
  const rejected = evaluations.filter((entry) => !entry?.[modeKey]?.matches);
  return {
    passed: matched.length,
    rejected: rejected.length,
    sampleAcceptedTitles: buildKeywordTitleSamples(matched, modeKey, 6),
    sampleRejectedTitles: buildKeywordTitleSamples(rejected, modeKey, 6),
    rejectionReasons: buildKeywordReasonCounts(rejected, modeKey),
  };
}

function buildKeywordReasonCounts(entries = [], modeKey) {
  const counts = {};
  for (const entry of entries) {
    const reason = String(entry?.[modeKey]?.reason || "unknown");
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  );
}

function buildKeywordTitleSamples(entries = [], modeKey, limit = 10) {
  const samples = [];
  const seen = new Set();
  for (const entry of entries) {
    const job = entry?.job || {};
    const evaluation = entry?.[modeKey] || {};
    const title = String(job?.title || "").trim();
    if (!title) {
      continue;
    }
    const dedupeKey = `${title.toLowerCase()}|${String(evaluation.reason || "")}|${String(evaluation.matchedCandidate || "")}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    samples.push({
      title,
      company: job?.company || null,
      provider: job?.provider || null,
      reason: evaluation.reason || null,
      matchedCandidate: evaluation.matchedCandidate || null,
      matchedField: evaluation.matchedField || null,
    });
    if (samples.length >= limit) {
      break;
    }
  }
  return samples;
}

function matchesIncludedCompanies(job, includedCompanies) {
  if (!(includedCompanies instanceof Set) || includedCompanies.size === 0) {
    return true;
  }

  const normalizedCompany = normalizeText(job?.company);
  const normalizedSourceName = normalizeText(job?.sourceName);
  const normalizedSourceKey = normalizeText(job?.sourceKey).replace(/[-\s]+/g, "");
  const applyUrl = String(job?.applyUrl || "").trim().toLowerCase();
  const candidates = new Set([
    normalizedCompany,
    normalizedSourceName,
    normalizedCompany.replace(/[-\s]+/g, ""),
    normalizedSourceName.replace(/[-\s]+/g, ""),
    normalizedSourceKey,
  ].filter(Boolean));

  const applyUrlMatch = applyUrl.match(/https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/([^/]+)\//i)
    || applyUrl.match(/https?:\/\/jobs\.ashbyhq\.com\/([^/]+)/i)
    || applyUrl.match(/https?:\/\/(?:www\.)?careers-page\.com\/([^/]+)\/job\//i);
  if (applyUrlMatch?.[1]) {
    const alias = normalizeText(applyUrlMatch[1]);
    candidates.add(alias);
    candidates.add(alias.replace(/[-\s]+/g, ""));
  }

  for (const included of includedCompanies) {
    const normalizedIncluded = normalizeText(included);
    const collapsedIncluded = normalizedIncluded.replace(/[-\s]+/g, "");
    if (candidates.has(normalizedIncluded) || candidates.has(collapsedIncluded)) {
      return true;
    }
  }

  return false;
}

function hasActiveLocationGroups(locationGroups) {
  return Array.isArray(locationGroups)
    && locationGroups.some((group) => group?.stateCode || (Array.isArray(group?.areaNames) && group.areaNames.length > 0));
}

function filterUnknownDateMatches(jobs, filters) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return;
  }

  const selectedArrangements = new Set((filters.arrangements || []).map((value) => normalizeWorkArrangement(value)));
  const maxDistanceMiles = Number(filters.distanceMiles);
  const useDistanceFilter = Number.isFinite(maxDistanceMiles) && maxDistanceMiles > 0 && filters.userCoordinates;
  const hasManualLocationFilter = hasActiveLocationGroups(filters.locationGroups);

  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index];
    const arrangement = normalizeWorkArrangement(job?.workArrangement);
    const hasKnownLocation = hasSpecifiedLocation(job);

    if (filters.usOnly && !matchesUnitedStates(job) && hasKnownLocation) {
      jobs.splice(index, 1);
      continue;
    }

    if (selectedArrangements.size > 0 && arrangement !== "unknown" && !selectedArrangements.has(arrangement)) {
      jobs.splice(index, 1);
      continue;
    }

    if (useDistanceFilter) {
      const distanceMiles = calculateJobDistanceMiles(job, filters.userCoordinates);
      if (Number.isFinite(distanceMiles)) {
        if (distanceMiles > maxDistanceMiles) {
          jobs.splice(index, 1);
          continue;
        }
        job.distanceMiles = distanceMiles;
        job.locationMatched = true;
      } else {
        if (hasKnownLocation) {
          jobs.splice(index, 1);
          continue;
        }
        job.locationUnknown = !hasKnownLocation;
      }
      continue;
    }

    const shouldApplyManualLocationFilter = needsLocationFilter(arrangement, filters);
    const manualLocationMatched = matchesLocationGroups(job, filters.locationGroups);
    if (shouldApplyManualLocationFilter && !manualLocationMatched && hasKnownLocation) {
      jobs.splice(index, 1);
      continue;
    }

    job.locationMatched = manualLocationMatched;
    if (shouldApplyManualLocationFilter && !manualLocationMatched) {
      job.locationUnknown = !hasKnownLocation;
    }
  }
}

function filterUnknownLocationMatches(jobs, filters) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return;
  }

  const selectedArrangements = new Set((filters.arrangements || []).map((value) => normalizeWorkArrangement(value)));

  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index];
    const arrangement = normalizeWorkArrangement(job?.workArrangement);
    if (hasExplicitNonUsLocation(job) || matchesUnitedStates(job)) {
      jobs.splice(index, 1);
      continue;
    }

    if (selectedArrangements.size > 0 && arrangement !== "unknown" && !selectedArrangements.has(arrangement)) {
      jobs.splice(index, 1);
      continue;
    }

    job.locationUnknown = true;
    job.usLocationUnknown = true;
  }
}

function backfillCompensation(jobs) {
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job?.compensation && containsCurrencyMarker(job.compensation)) {
      job.compensation = cleanCompensationText(job.compensation);
      continue;
    }

    const extracted = extractCompensationFromJob(job);
    if (extracted) {
      job.compensation = extracted;
    }
  }
}

function removeExpiredJobs(jobs) {
  if (!Array.isArray(jobs)) {
    return;
  }

  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    if (isExpiredJob(jobs[index]) || jobs[index]?.invalidApplyPage || isUnrecoverableListing(jobs[index])) {
      jobs.splice(index, 1);
    }
  }
}

function reconcileUnknownDateMatches(jobs, unknownDateMatches, filters) {
  if (!Array.isArray(jobs) || !Array.isArray(unknownDateMatches)) {
    return;
  }

  for (let index = unknownDateMatches.length - 1; index >= 0; index -= 1) {
    const job = unknownDateMatches[index];
    const hasKnownDate = Boolean(job?.postedAt || job?.updatedAt);
    if (!hasKnownDate) {
      continue;
    }

    unknownDateMatches.splice(index, 1);
    if (matchesRecency(job, filters?.recency)) {
      jobs.push(job);
    }
  }
}

async function enrichMissingDescriptions(jobs, filters = {}) {
  const hasSpecificCompanyFocus = Array.isArray(filters?.includedCompanies) && filters.includedCompanies.length > 0;
  const maxJobsToEnrich = Array.isArray(jobs) && jobs.length > 250 && !hasSpecificCompanyFocus
    ? MAX_BROAD_SEARCH_DESCRIPTION_ENRICH_JOBS
    : MAX_DESCRIPTION_ENRICH_JOBS;
  const includedCompanies = new Set(
    (Array.isArray(filters?.includedCompanies) ? filters.includedCompanies : [])
      .map((value) => normalizeText(value))
      .filter(Boolean)
  );
  const jobsNeedingDescription = jobs
    .filter((job) => needsDescriptionRefresh(job) && job.applyUrl)
    .sort((left, right) => {
      const leftScore = buildDescriptionRefreshPriority(left, includedCompanies);
      const rightScore = buildDescriptionRefreshPriority(right, includedCompanies);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }

      const leftWorkday = isWorkdayHostedUrl(left?.applyUrl) ? 1 : 0;
      const rightWorkday = isWorkdayHostedUrl(right?.applyUrl) ? 1 : 0;
      if (leftWorkday !== rightWorkday) {
        return rightWorkday - leftWorkday;
      }

      const leftUnknown = normalizeWorkArrangement(left?.workArrangement) === "unknown" ? 1 : 0;
      const rightUnknown = normalizeWorkArrangement(right?.workArrangement) === "unknown" ? 1 : 0;
      if (leftUnknown !== rightUnknown) {
        return rightUnknown - leftUnknown;
      }
      return sortJobs(left, right);
    })
    .slice(0, maxJobsToEnrich);
  if (jobsNeedingDescription.length === 0) {
    return;
  }

  let currentIndex = 0;
  async function worker() {
      while (currentIndex < jobsNeedingDescription.length) {
        const index = currentIndex;
        currentIndex += 1;
        const job = jobsNeedingDescription[index];
        const fallback = await fetchDescriptionFallback(job.applyUrl, {
          signal: AbortSignal.timeout(DESCRIPTION_ENRICH_TIMEOUT_MS),
        });
        if (fallback.descriptionSnippet || fallback.searchText) {
          job.descriptionSnippet = fallback.descriptionSnippet || job.descriptionSnippet || null;
          job.searchText = fallback.searchText || fallback.descriptionSnippet || job.searchText || null;
        }
        if (!job.postedAt && fallback.postedAt) {
          job.postedAt = fallback.postedAt;
        }
        if (!job.applicationDeadlineAt && fallback.applicationDeadlineAt) {
          job.applicationDeadlineAt = fallback.applicationDeadlineAt;
        }
        if ((!job.compensation || !containsCurrencyMarker(job.compensation)) && fallback.compensation) {
          job.compensation = fallback.compensation;
        }
        if ((normalizeWorkArrangement(job.workArrangement) === "unknown" || !job.workArrangement) && fallback.workArrangement) {
          job.workArrangement = fallback.workArrangement;
        }
        if (shouldReplaceExternalId(job.externalId, fallback.jobId)) {
          job.externalId = fallback.jobId;
        }
        if (fallback.invalidApplyPage) {
          job.invalidApplyPage = true;
        }
        job.company = deriveEmployerCompany(job, { company: job.company });
      }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(DESCRIPTION_ENRICH_CONCURRENCY, jobsNeedingDescription.length)) },
    () => worker()
  );
  await Promise.all(workers);
}

function refreshDerivedJobMetadata(jobs) {
  for (const job of Array.isArray(jobs) ? jobs : []) {
    job.company = deriveEmployerCompany(job, { company: job.company });
    const derivedLocation = deriveLocationMetadata(job);
    const currentArrangement = normalizeWorkArrangement(job.workArrangement);
    const inferredArrangement = normalizeWorkArrangement(inferWorkArrangement([
      job.workArrangement,
      job.locationLabel,
      job.rawLocationText,
      job.searchText,
      job.descriptionSnippet,
      job.applyUrl,
    ].filter(Boolean).join(" \n ")));

    if ((!job.locationLabel || job.locationLabel === "Unspecified" || /^united states$/i.test(String(job.locationLabel || "").trim()))
      && derivedLocation.locationLabel) {
      job.locationLabel = derivedLocation.locationLabel;
    }
    if (!job.city && derivedLocation.city) {
      job.city = derivedLocation.city;
    }
    if (!job.region && derivedLocation.region) {
      job.region = derivedLocation.region;
    }
    if (!job.country && derivedLocation.country) {
      job.country = derivedLocation.country;
    }
    if ((!job.rawLocationText || job.rawLocationText === "Unspecified") && derivedLocation.rawLocationText) {
      job.rawLocationText = derivedLocation.rawLocationText;
    }
    applyResolvedRecency(job);
    if (hasSpecifiedLocation(job)) {
      job.locationUnknown = false;
    }
    if (job.usLocationUnknown && matchesUnitedStates(job)) {
      job.usLocationUnknown = false;
    }

    if ((currentArrangement === "unknown" || !job.workArrangement) && inferredArrangement !== "unknown") {
      job.workArrangement = inferredArrangement;
      job.arrangementUnknown = false;
    } else if (normalizeWorkArrangement(job.workArrangement) !== "unknown") {
      job.arrangementUnknown = false;
    }
  }
}

function applyResolvedRecency(job) {
  const recency = evaluateRecency(job, "");
  job.postedDate = recency.postedDate;
  job.updatedDate = recency.updatedDate;
  job.firstSeenDate = recency.firstSeenDate;
  job.parsedRecencyDate = recency.parsedRecencyDate;
  job.dateStatus = recency.dateStatus;
  return job;
}

function needsDescriptionRefresh(job) {
  if (!job?.postedAt && !job?.updatedAt) {
    return true;
  }

  if (!job?.compensation || !containsCurrencyMarker(job.compensation)) {
    return true;
  }

  if (!job?.externalId || /^https?:/i.test(String(job.externalId || "").trim())) {
    return true;
  }

  if (normalizeWorkArrangement(job?.workArrangement) === "unknown") {
    return true;
  }

  if (!hasUsableDescriptionText(job)) {
    return true;
  }

  const candidate = String(job.searchText || job.descriptionSnippet || "").trim().toLowerCase();
  if (!candidate) {
    return true;
  }

  return /^(the\s+)?(total\s+cash\s+range|cash\s+range|salary\s+range|pay\s+range|base\s+pay)/.test(candidate);
}

function isWorkdayHostedUrl(value) {
  const url = String(value || "").toLowerCase();
  return url.includes("myworkdayjobs.com") || url.includes(".wd");
}

function shouldReplaceExternalId(currentValue, nextValue) {
  const current = String(currentValue || "").trim();
  const next = String(nextValue || "").trim();
  if (!next) {
    return false;
  }
  if (!current || /^https?:/i.test(current)) {
    return true;
  }
  if (current === next) {
    return false;
  }
  if (/^\d{4,}$/.test(current) && /^[A-Za-z]+-\d+(?:-\d+)?$/i.test(next)) {
    return true;
  }
  if (/^\d{4,}$/.test(current) && /^[A-Za-z]\d+(?:-\d+)?$/i.test(next)) {
    return true;
  }
  if (current.length < next.length && next.includes(current)) {
    return true;
  }
  return false;
}

function buildDescriptionRefreshPriority(job = {}, includedCompanies = new Set()) {
  let score = 0;
  if (!job?.postedAt && !job?.updatedAt) {
    score += 5;
  }
  if (!job?.compensation || !containsCurrencyMarker(job.compensation)) {
    score += 4;
  }
  if (normalizeWorkArrangement(job?.workArrangement) === "unknown") {
    score += 4;
  }
  if (!hasSpecifiedLocation(job)) {
    score += 3;
  }
  if (!job?.externalId || /^https?:/i.test(String(job.externalId || "").trim())) {
    score += 3;
  }
  if (!hasUsableDescriptionText(job)) {
    score += 2;
  }

  const url = String(job?.applyUrl || "").toLowerCase();
  if (url.includes("job-boards.greenhouse.io") || url.includes("jobs.lever.co") || url.includes("icims.com")) {
    score += 1;
  }
  const normalizedCompany = normalizeText(job?.company || deriveEmployerCompany(job, { company: job?.company }) || "");
  if (normalizedCompany && includedCompanies.has(normalizedCompany)) {
    score += 10;
  }

  return score;
}

function isUnrecoverableListing(job = {}) {
  const candidate = String(job.searchText || job.descriptionSnippet || "").trim();
  const hasDescription = hasUsableDescriptionText(job);
  const hasDate = Boolean(job.postedAt || job.updatedAt);
  const hasCompensation = Boolean(job.compensation && containsCurrencyMarker(job.compensation));
  const hasDeadline = Boolean(job.applicationDeadlineAt);
  const identifier = String(job.externalId || "").trim();

  if (hasDescription || hasDate || hasCompensation || hasDeadline) {
    return false;
  }

  if (!candidate) {
    return true;
  }

  if (identifier && candidate === identifier) {
    return true;
  }

  return /^[A-Za-z]+-\d+(?:-\d+)?$/.test(candidate)
    || /^[A-Za-z]\d+(?:-\d+)?$/.test(candidate)
    || /^\d{4,}$/.test(candidate);
}

function extractCompensationFromJob(job = {}) {
  const explicit = normalizePreviewText(job.compensation || job.salary);
  if (explicit && containsCurrencyMarker(explicit)) {
    return cleanCompensationText(explicit);
  }

  const searchPool = [
    job.searchText,
    job.descriptionSnippet,
  ]
    .map((value) => normalizePreviewText(value))
    .filter(Boolean)
    .join(" \n ");

  if (!searchPool) {
    return "";
  }

  const normalized = searchPool.replace(/\s+/g, " ");
  const patterns = [
    /(?:compensation(?:\s+and\s+benefits)?|salary|base\s+salary|base\s+pay|pay|pay\s+for\s+this\s+role|salary\s+for\s+this\s+role|salary\s+for\s+this\s+position|compensation\s+for\s+this\s+role|compensation\s+for\s+this\s+position)[^.;|]{0,160}?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?(?:[^.;|]{0,80}?(?:-|to)\s*(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)?\s?\d[\d,]*(?:\.\d{2})?)?[^.;|]{0,40}(?:annual|yearly|per year|yr|hourly|per hour|hour)?/i,
    /(?:us\s+salary\s+range|salary\s+range|pay\s+range|base\s+pay\s+range|cash\s+range)[:\s-]*\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:-|to)\s*\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:usd|cad|eur|gbp|aud|nzd|jpy)?/i,
    /(?:total\s+cash\s+range|cash\s+range|pay\s+range|salary\s+range|base\s+pay(?:\s+range)?)[^.$]{0,80}?\bis\s+(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?\s*(?:-|to)\s*(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)?\s?\d[\d,]*(?:\.\d{2})?/i,
    /(?:(?:base\s+)?pay\s+range|salary\s+range|compensation(?:\s+and\s+benefits)?|base\s+pay|salary)[:\s-]*(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)[^.;|]{0,100}/i,
    /(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?\s*(?:-|to)\s*(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)?\s?\d[\d,]*(?:\.\d{2})?\s*(?:USD|CAD|EUR|GBP|AUD|NZD|JPY|annual|yearly|per year|yr|hourly|per hour|hour)?/i,
    /\$\s?\d[\d,]*(?:\.\d{2})?\s*-\s*\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:annual|yearly|per year|yr|hourly|per hour|hour)/i,
    /\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:annual|yearly|per year|yr)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[0]) {
      const candidate = cleanCompensationText(match[0]);
      if (containsCurrencyMarker(candidate)) {
        return candidate;
      }
    }
  }

  return "";
}

function normalizePreviewText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#34;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;|&ndash;/gi, "-")
    .replace(/&bull;/gi, " ")
    .replace(/\\u([\da-f]{4})/gi, (_, code) => {
      try {
        return String.fromCharCode(Number.parseInt(code, 16));
      } catch {
        return " ";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
}

function containsCurrencyMarker(value) {
  return /[$€£¥]|(?:\bUSD\b|\bCAD\b|\bEUR\b|\bGBP\b|\bAUD\b|\bNZD\b|\bJPY\b)/i.test(String(value || ""));
}

function cleanCompensationText(value) {
  let text = normalizePreviewText(value);
  if (!text) {
    return "";
  }

  text = text
    .replace(/^(salary|compensation|compensation and benefits|base salary|base pay|pay)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const stopPatterns = [
    /\bminimum education\b/i,
    /\brequired education\b/i,
    /\bpreferred education\b/i,
    /\blogistics\b/i,
    /\bqualifications\b/i,
    /\brequirements\b/i,
    /\bresponsibilities\b/i,
    /\bbenefits\b/i,
    /\bjob description\b/i,
    /\babout the role\b/i,
    /\bin this role\b/i,
    /\boverview\b/i,
    /\brole responsibilities\b/i,
  ];

  let stopIndex = -1;
  for (const pattern of stopPatterns) {
    const match = pattern.exec(text);
    if (match && (stopIndex === -1 || match.index < stopIndex)) {
      stopIndex = match.index;
    }
  }

  if (stopIndex > 0) {
    text = text.slice(0, stopIndex).trim();
  }

  return text.replace(/[;:,.\-–—\s]+$/g, "").trim();
}

function buildSearchDedupKey(job) {
  return buildJobListingKey(job);
}

function annotatePossibleDuplicates(jobs) {
  const grouped = new Map();

  for (const job of jobs) {
    const signature = buildJobDuplicateSignature(job);
    if (!grouped.has(signature)) {
      grouped.set(signature, {
        jobs: [],
        listingKeys: new Set(),
      });
    }

    const group = grouped.get(signature);
    group.jobs.push(job);
    group.listingKeys.add(buildJobListingKey(job));
  }

  return jobs.map((job) => {
    const group = grouped.get(buildJobDuplicateSignature(job));
    if (!group || group.listingKeys.size < 2) {
      return job;
    }

    const details = new Set(Array.isArray(job?.duplicateInfo?.details) ? job.duplicateInfo.details : []);
    details.add(`Same company, title, and description matched ${group.listingKeys.size} current results`);

    return {
      ...job,
      duplicateInfo: {
        ...(job.duplicateInfo || {}),
        isPossibleDuplicate: true,
        label: "POSSIBLE DUPLICATE",
        details: [...details],
        currentResultCount: group.listingKeys.size,
      },
    };
  });
}

function aggregateJobsByListingKey(jobs) {
  const grouped = new Map();

  for (const job of jobs) {
    const key = buildSearchDedupKey(job);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(job);
  }

  return [...grouped.values()].map(mergeJobGroup);
}

function mergeJobGroup(group) {
  if (!Array.isArray(group) || group.length <= 1) {
    return group?.[0] || null;
  }

  const sortedGroup = [...group].sort(sortJobs);
  const primary = { ...sortedGroup[0] };
  const locationVariants = [];
  const seenVariantKeys = new Set();

  for (const job of sortedGroup) {
    const variantKey = `${String(job.applyUrl || "").trim().toLowerCase()}|${String(job.locationLabel || "").trim().toLowerCase()}`;
    if (seenVariantKeys.has(variantKey)) {
      continue;
    }

    seenVariantKeys.add(variantKey);
    locationVariants.push({
      locationLabel: job.locationLabel || "Unspecified",
      applyUrl: job.applyUrl || "",
      externalId: job.externalId || "",
      canonicalJobId: extractCanonicalJobId(job),
      postedAt: job.postedAt || job.updatedAt || null,
    });
  }

  primary.locationVariants = locationVariants;
  primary.locationVariantCount = locationVariants.length;

  if (locationVariants.length > 1) {
    primary.duplicateInfo = null;
    primary.isPossibleDuplicate = false;
  }

  return primary;
}

function needsLocationFilter(arrangement, filters) {
  const hasLocation = Array.isArray(filters.locationGroups)
    && filters.locationGroups.some((group) => group.stateCode || (group.areaNames && group.areaNames.length > 0));
  if (!hasLocation) {
    return false;
  }

  if (filters.locationMode === "my_location") {
    return true;
  }

  return arrangement === "hybrid" || arrangement === "onsite" || arrangement === "unknown";
}

function sortJobs(left, right) {
  const leftTime = left.postedAt
    ? new Date(left.postedAt).getTime()
    : left.updatedAt
      ? new Date(left.updatedAt).getTime()
      : 0;
  const rightTime = right.postedAt
    ? new Date(right.postedAt).getTime()
    : right.updatedAt
      ? new Date(right.updatedAt).getTime()
      : 0;

  if (rightTime !== leftTime) {
    const leftDateKey = buildJobDateKey(left);
    const rightDateKey = buildJobDateKey(right);

    if (leftDateKey && rightDateKey && leftDateKey === rightDateKey) {
      const leftIsExpedia = isExpediaJob(left);
      const rightIsExpedia = isExpediaJob(right);
      if (leftIsExpedia !== rightIsExpedia) {
        return leftIsExpedia ? 1 : -1;
      }
    }

    return rightTime - leftTime;
  }

  const leftIsExpedia = isExpediaJob(left);
  const rightIsExpedia = isExpediaJob(right);
  if (leftIsExpedia !== rightIsExpedia) {
    return leftIsExpedia ? 1 : -1;
  }

  return 0;
}

function isExpediaJob(job) {
  const company = String(job?.company || "").toLowerCase();
  const sourceKey = String(job?.sourceKey || "").toLowerCase();
  const applyUrl = String(job?.applyUrl || "").toLowerCase();

  return company.includes("expedia")
    || sourceKey.includes("expedia")
    || applyUrl.includes("expediagroup.com")
    || applyUrl.includes("careers.expediagroup.com");
}

function buildJobDateKey(job) {
  const rawValue = job?.postedAt || job?.updatedAt;
  if (!rawValue) {
    return "";
  }

  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
