import { fetchJobsForSource } from "./adapters/index.js";
import { fetchDescriptionFallback, hasUsableDescriptionText } from "./adapters/shared.js";
import {
  calculateJobDistanceMiles,
  buildJobContentSignature,
  buildJobDuplicateSignature,
  buildJobListingKey,
  extractCanonicalJobId,
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

const DESCRIPTION_ENRICH_CONCURRENCY = 8;
const MAX_DESCRIPTION_ENRICH_JOBS = 30;
const DESCRIPTION_ENRICH_TIMEOUT_MS = 3500;

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
  const unknownDateMatches = [];

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

      const hasKnownDate = Boolean(enriched.postedAt || enriched.updatedAt);
      if (!matchesRecency(enriched, filters.recency)) {
        if (filters.recency && !hasKnownDate) {
          unknownDateMatches.push(enriched);
          const counts = matchedCounts.get(result.source.key);
          counts.unknownDateCount += 1;
        }
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

  await enrichMissingDescriptions(jobs);
  await enrichMissingDescriptions(unknownDateMatches);
  backfillCompensation(jobs);
  backfillCompensation(unknownDateMatches);

  const annotated = annotatePossibleDuplicates(jobs);
  const annotatedUnknownDate = annotatePossibleDuplicates(unknownDateMatches);
  const aggregated = aggregateJobsByListingKey(annotated);
  const aggregatedUnknownDate = aggregateJobsByListingKey(annotatedUnknownDate);
  const deduped = uniqueBy(
    aggregated.sort(sortJobs),
    buildSearchDedupKey
  );
  const dedupedUnknownDate = uniqueBy(
    aggregatedUnknownDate.sort(sortJobs),
    buildSearchDedupKey
  ).filter((job) => !deduped.some((datedJob) => buildSearchDedupKey(datedJob) === buildSearchDedupKey(job)));

  return {
    jobs: deduped,
    unknownDateJobs: dedupedUnknownDate,
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

async function enrichMissingDescriptions(jobs) {
  const jobsNeedingDescription = jobs
    .filter((job) => needsDescriptionRefresh(job) && job.applyUrl)
    .sort(sortJobs)
    .slice(0, MAX_DESCRIPTION_ENRICH_JOBS);
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
      }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(DESCRIPTION_ENRICH_CONCURRENCY, jobsNeedingDescription.length)) },
    () => worker()
  );
  await Promise.all(workers);
}

function needsDescriptionRefresh(job) {
  if (!hasUsableDescriptionText(job)) {
    return true;
  }

  const candidate = String(job.searchText || job.descriptionSnippet || "").trim().toLowerCase();
  if (!candidate) {
    return true;
  }

  return /^(the\s+)?(total\s+cash\s+range|cash\s+range|salary\s+range|pay\s+range|base\s+pay)/.test(candidate);
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
