import { fetchJobsForSource } from "./adapters/index.js";
import {
  calculateJobDistanceMiles,
  hasSpecifiedLocation,
  isLikelyJobPosting,
  matchesKeyword,
  matchesLocationGroups,
  matchesRecency,
  matchesUnitedStates,
  normalizeText,
  normalizeWorkArrangement,
  uniqueBy,
} from "./filters.js";

export async function searchJobs({ sources, filters, sourceResultsOverride }) {
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

  const excludedCompanies = new Set((filters.excludedCompanies || []).map((name) => name.toLowerCase()));
  const selectedArrangements = new Set((filters.arrangements || []).map((value) => normalizeWorkArrangement(value)));
  const maxDistanceMiles = Number(filters.distanceMiles);
  const useDistanceFilter = Number.isFinite(maxDistanceMiles) && maxDistanceMiles > 0 && filters.userCoordinates;
  const matchedCounts = new Map(sourceResults.map((result) => [result.source.key, { matchedCount: 0, datedCount: 0, unknownDateCount: 0 }]));

  const jobs = [];

  for (const result of sourceResults) {
    for (const job of result.jobs) {
      const arrangement = normalizeWorkArrangement(job.workArrangement);
      const enriched = {
        ...job,
        workArrangement: arrangement,
        distanceMiles: null,
        locationMatched: false,
        usLocationUnknown: false,
        arrangementUnknown: false,
      };

      if (excludedCompanies.has(enriched.company.toLowerCase())) {
        continue;
      }

      if (!isLikelyJobPosting(enriched)) {
        continue;
      }

      if (!matchesKeyword(enriched, filters.keyword, filters.keywordScope, filters.keywordMode)) {
        continue;
      }

      if (!matchesRecency(enriched, filters.recency)) {
        continue;
      }

      if (filters.usOnly) {
        if (matchesUnitedStates(enriched)) {
          enriched.usLocationUnknown = false;
        } else if (!hasSpecifiedLocation(enriched)) {
          enriched.usLocationUnknown = true;
        } else {
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
        if (!Number.isFinite(distanceMiles) || distanceMiles > maxDistanceMiles) {
          continue;
        }

        enriched.distanceMiles = distanceMiles;
        enriched.locationMatched = true;
      } else if (needsLocationFilter(arrangement, filters) && !matchesLocationGroups(enriched, filters.locationGroups)) {
        continue;
      } else {
        enriched.locationMatched = matchesLocationGroups(enriched, filters.locationGroups);
      }

      jobs.push(enriched);
      const counts = matchedCounts.get(result.source.key);
      counts.matchedCount += 1;
      if (enriched.postedAt || enriched.updatedAt) {
        counts.datedCount += 1;
      } else {
        counts.unknownDateCount += 1;
      }
    }
  }

  const deduped = uniqueBy(
    jobs.sort(sortJobs),
    buildSearchDedupKey
  );

  return {
    jobs: deduped,
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
    },
  };
}

function buildSearchDedupKey(job) {
  const normalizedCompany = normalizeText(job.company);
  const normalizedTitle = normalizeText(job.title);
  const normalizedLocation = normalizeText(
    [
      job.locationLabel,
      job.city,
      job.region,
      job.country,
      job.rawLocationText,
    ]
      .filter(Boolean)
      .join(" ")
  ) || "unspecified";
  const normalizedArrangement = normalizeText(job.workArrangement) || "unknown";
  const normalizedSource = normalizeText(job.sourceKey || job.sourceName || job.provider);

  return [
    normalizedSource,
    normalizedCompany,
    normalizedTitle,
    normalizedLocation,
    normalizedArrangement,
  ].join("|");
}

function needsLocationFilter(arrangement, filters) {
  const hasLocation = Array.isArray(filters.locationGroups)
    && filters.locationGroups.some((group) => group.stateCode || (group.areaNames && group.areaNames.length > 0));
  if (!hasLocation) {
    return false;
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
  return rightTime - leftTime;
}
