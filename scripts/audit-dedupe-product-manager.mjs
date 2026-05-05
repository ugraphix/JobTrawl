import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { fetchJobsForSource } from "../src/lib/adapters/index.js";
import { deriveLocationMetadata } from "../src/lib/adapters/shared.js";
import { loadSourceConfig } from "../src/lib/config.js";
import {
  buildJobDuplicateSignature,
  buildJobListingKey,
  evaluateRecency,
  extractCanonicalJobId,
  hasSpecifiedLocation,
  inferWorkArrangement,
  isExpiredJob,
  isLikelyJobPosting,
  matchesKeyword,
  normalizeText,
  normalizeWorkArrangement,
  uniqueBy,
} from "../src/lib/filters.js";

const DATA_DIR = path.join(process.cwd(), "data");
const OUTPUT_PATH = path.join(DATA_DIR, "dedupe-audit-product-manager-summary.json");
const CONCURRENCY = Number(process.env.JOBTRAWL_DEDUPE_AUDIT_CONCURRENCY || 10);
const LIMIT = Number(process.env.JOBTRAWL_DEDUPE_AUDIT_LIMIT || 4454);
const TIMEOUT_MS = Number(process.env.JOBTRAWL_DEDUPE_AUDIT_TIMEOUT_MS || 90000);
const FILTERS = {
  keyword: String(process.env.JOBTRAWL_DEDUPE_AUDIT_KEYWORD || "product manager").trim(),
  keywordScope: "title_and_description",
  keywordMode: "strict",
  recency: "24h",
};

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const allSources = await loadSourceConfig();
  const sources = [...(LIMIT > 0 ? allSources.slice(0, LIMIT) : allSources)].sort((left, right) => (
    String(left?.provider || "").localeCompare(String(right?.provider || ""))
    || String(left?.company || "").localeCompare(String(right?.company || ""))
    || String(left?.key || "").localeCompare(String(right?.key || ""))
  ));

  const sourceResults = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= sources.length) {
        return;
      }
      const source = sources[currentIndex];
      try {
        const jobs = await withTimeout(fetchJobsForSource(source, {}), TIMEOUT_MS);
        sourceResults.push({ source, jobs, error: null });
      } catch (error) {
        sourceResults.push({ source, jobs: [], error: String(error?.message || error) });
      }

      if ((currentIndex + 1) % 100 === 0 || currentIndex + 1 === sources.length) {
        process.stdout.write(`[dedupe-audit] ${currentIndex + 1}/${sources.length} fetched\n`);
      }
    }
  });

  await Promise.all(workers);
  const keywordPassedJobs = buildKeywordPassedJobs(sourceResults, FILTERS);
  const audit = analyzeDedupe(keywordPassedJobs);
  const output = {
    startedAt: new Date().toISOString(),
    sourceCount: sources.length,
    filters: FILTERS,
    fetchSummary: {
      succeededSources: sourceResults.filter((item) => !item.error).length,
      failedSources: sourceResults.filter((item) => item.error).length,
      rawJobsFetched: sourceResults.reduce((sum, item) => sum + item.jobs.length, 0),
    },
    ...audit,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${OUTPUT_PATH}\n`);
  process.stdout.write(`${JSON.stringify({
    sourceCount: output.sourceCount,
    enteringDedupe: output.counts.enteringDedupe,
    keptAfterDedupe: output.counts.keptAfterDedupe,
    removedByDedupe: output.counts.removedByDedupe,
    duplicateKeyKinds: output.duplicateKeyKinds,
    suspiciousGroupCounts: output.suspiciousGroupCounts,
  }, null, 2)}\n`);
}

async function withTimeout(promise, timeoutMs) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs).unref?.();
    }),
  ]);
}

function buildKeywordPassedJobs(sourceResults, filters) {
  const jobs = [];
  for (const result of sourceResults) {
    for (const rawJob of result.jobs || []) {
      const job = prepareJob(rawJob);
      if (!isLikelyJobPosting(job)) {
        continue;
      }
      const recency = evaluateRecency(job, filters.recency);
      if (!recency.matches) {
        continue;
      }
      if (!matchesKeyword(job, filters.keyword, filters.keywordScope, filters.keywordMode)) {
        continue;
      }
      if (isExpiredJob(job)) {
        continue;
      }
      jobs.push(job);
    }
  }
  return jobs;
}

function prepareJob(job) {
  const arrangement = normalizeWorkArrangement(job?.workArrangement);
  const enriched = {
    ...job,
    workArrangement: arrangement,
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
  enriched.workArrangement = arrangement || inferWorkArrangement(enriched);
  return enriched;
}

function analyzeDedupe(jobs) {
  const groupedByKey = new Map();
  for (const job of jobs) {
    const key = buildJobListingKey(job);
    if (!groupedByKey.has(key)) {
      groupedByKey.set(key, []);
    }
    groupedByKey.get(key).push(job);
  }

  const duplicateGroups = [...groupedByKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => summarizeGroup(key, group))
    .sort((left, right) => right.size - left.size || left.duplicateKey.localeCompare(right.duplicateKey));

  const aggregated = aggregateJobsByListingKeyForAudit(jobs);
  const deduped = uniqueBy(aggregated.sort(sortJobsForAudit), buildJobListingKey);
  const removedByDedupe = jobs.length - deduped.length;

  const duplicateKeyKinds = {};
  for (const group of duplicateGroups) {
    duplicateKeyKinds[group.duplicateKeyKind] = (duplicateKeyKinds[group.duplicateKeyKind] || 0) + 1;
  }

  const suspiciousGroupCounts = {
    differentTitlesMerged: duplicateGroups.filter((group) => group.flags.differentTitlesMerged).length,
    differentCompaniesMerged: duplicateGroups.filter((group) => group.flags.differentCompaniesMerged).length,
    differentLocationsMerged: duplicateGroups.filter((group) => group.flags.differentLocationsMerged).length,
    remoteOnsiteMerged: duplicateGroups.filter((group) => group.flags.remoteOnsiteMerged).length,
    differentAtsSourcesMerged: duplicateGroups.filter((group) => group.flags.differentAtsSourcesMerged).length,
    missingCompanyOrLocation: duplicateGroups.filter((group) => group.flags.missingCompanyOrLocation).length,
  };

  return {
    counts: {
      enteringDedupe: jobs.length,
      keptAfterDedupe: deduped.length,
      removedByDedupe,
      duplicateGroups: duplicateGroups.length,
    },
    duplicateKeyUsed: "buildJobListingKey(company + canonicalJobId | externalId | applyUrl | content signature fallback)",
    duplicateKeyKinds,
    suspiciousGroupCounts,
    topDuplicateGroups: duplicateGroups.slice(0, 25),
    suspiciousDuplicateGroups: duplicateGroups.filter((group) => isSuspicious(group)).slice(0, 25),
    sampleRemovedJobs: buildRemovedJobSamples(duplicateGroups, 25),
    sampleKeptJobs: buildKeptJobSamples(duplicateGroups, 25),
    providerImpact: buildProviderImpact(duplicateGroups),
  };
}

function summarizeGroup(duplicateKey, group) {
  const sortedGroup = [...group].sort(sortJobsForAudit);
  const keptJob = summarizeJob(sortedGroup[0]);
  const removedJobs = sortedGroup.slice(1).map(summarizeJob);
  const titles = [...new Set(sortedGroup.map((job) => String(job.title || "").trim()).filter(Boolean))];
  const companies = [...new Set(sortedGroup.map((job) => String(job.company || "").trim() || "(missing company)"))];
  const locations = [...new Set(sortedGroup.map((job) => String(job.locationLabel || job.rawLocationText || "").trim() || "(missing location)"))];
  const arrangements = [...new Set(sortedGroup.map((job) => normalizeWorkArrangement(job.workArrangement) || "unknown"))];
  const sources = [...new Set(sortedGroup.map((job) => String(job.sourceKey || "").trim() || "(missing source)"))];
  const atsFamilies = [...new Set(sortedGroup.map((job) => String(job.provider || "").trim() || "(missing provider)"))];

  const duplicateKeyKind = inferDuplicateKeyKind(duplicateKey);
  const flags = {
    differentTitlesMerged: titles.length > 1,
    differentCompaniesMerged: companies.length > 1,
    differentLocationsMerged: locations.length > 1,
    remoteOnsiteMerged: arrangements.includes("remote") && (arrangements.includes("onsite") || arrangements.includes("hybrid")),
    differentAtsSourcesMerged: atsFamilies.length > 1 || sources.length > 1,
    missingCompanyOrLocation: companies.includes("(missing company)") || locations.includes("(missing location)"),
  };

  return {
    duplicateKey,
    duplicateKeyKind,
    size: sortedGroup.length,
    keptJob,
    removedJobs,
    sources,
    atsFamilies,
    titles,
    companies,
    locations,
    arrangements,
    flags,
  };
}

function summarizeJob(job) {
  return {
    title: job.title || null,
    company: job.company || null,
    location: job.locationLabel || job.rawLocationText || null,
    workArrangement: normalizeWorkArrangement(job.workArrangement) || "unknown",
    applyUrl: job.applyUrl || null,
    source: job.sourceKey || null,
    atsFamily: job.provider || null,
    externalId: job.externalId || null,
    canonicalJobId: extractCanonicalJobId(job) || null,
  };
}

function inferDuplicateKeyKind(key) {
  if (key.includes("|jobid|")) {
    return "jobid";
  }
  if (key.includes("|id|")) {
    return "externalId";
  }
  if (key.includes("|url|")) {
    return "applyUrl";
  }
  return "contentSignature";
}

function buildRemovedJobSamples(groups, limit = 25) {
  const samples = [];
  for (const group of groups) {
    for (const job of group.removedJobs) {
      samples.push({
        duplicateKey: group.duplicateKey,
        duplicateKeyKind: group.duplicateKeyKind,
        keptJob: group.keptJob,
        removedJob: job,
        sources: group.sources,
        atsFamilies: group.atsFamilies,
        flags: group.flags,
      });
      if (samples.length >= limit) {
        return samples;
      }
    }
  }
  return samples;
}

function buildKeptJobSamples(groups, limit = 25) {
  return groups.slice(0, limit).map((group) => ({
    duplicateKey: group.duplicateKey,
    duplicateKeyKind: group.duplicateKeyKind,
    keptJob: group.keptJob,
    removedCount: group.removedJobs.length,
    sources: group.sources,
    atsFamilies: group.atsFamilies,
    flags: group.flags,
  }));
}

function buildProviderImpact(groups) {
  const impact = {};
  for (const group of groups) {
    for (const job of [group.keptJob, ...group.removedJobs]) {
      const provider = String(job.atsFamily || "unknown");
      if (!impact[provider]) {
        impact[provider] = {
          enteringGroups: 0,
          removedJobs: 0,
          keptJobs: 0,
        };
      }
      impact[provider].enteringGroups += 1;
      if (job === group.keptJob) {
        impact[provider].keptJobs += 1;
      } else {
        impact[provider].removedJobs += 1;
      }
    }
  }

  return Object.fromEntries(
    Object.entries(impact)
      .sort((left, right) => right[1].removedJobs - left[1].removedJobs || left[0].localeCompare(right[0]))
  );
}

function isSuspicious(group) {
  return group.flags.differentTitlesMerged
    || group.flags.differentCompaniesMerged
    || group.flags.remoteOnsiteMerged
    || group.flags.missingCompanyOrLocation;
}

function aggregateJobsByListingKeyForAudit(jobs) {
  const grouped = new Map();
  for (const job of annotatePossibleDuplicatesForAudit(jobs)) {
    const key = buildJobListingKey(job);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(job);
  }
  return [...grouped.values()].map((group) => mergeJobGroupForAudit(group));
}

function annotatePossibleDuplicatesForAudit(jobs) {
  const grouped = new Map();
  for (const job of jobs) {
    const signature = buildJobDuplicateSignature(job);
    if (!grouped.has(signature)) {
      grouped.set(signature, {
        jobs: [],
        listingKeys: new Set(),
      });
    }
    const entry = grouped.get(signature);
    entry.jobs.push(job);
    entry.listingKeys.add(buildJobListingKey(job));
  }

  return jobs.map((job) => {
    const group = grouped.get(buildJobDuplicateSignature(job));
    if (!group || group.listingKeys.size < 2) {
      return job;
    }
    return {
      ...job,
      duplicateInfo: {
        ...(job.duplicateInfo || {}),
        isPossibleDuplicate: true,
        label: "POSSIBLE DUPLICATE",
        details: [`Same company, title, and description matched ${group.listingKeys.size} current results`],
        currentResultCount: group.listingKeys.size,
      },
    };
  });
}

function mergeJobGroupForAudit(group) {
  if (!Array.isArray(group) || group.length <= 1) {
    return group?.[0] || null;
  }
  const sortedGroup = [...group].sort(sortJobsForAudit);
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

function sortJobsForAudit(left, right) {
  const leftTime = left.postedAt ? new Date(left.postedAt).getTime() : left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
  const rightTime = right.postedAt ? new Date(right.postedAt).getTime() : right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  const leftLocation = hasSpecifiedLocation(left);
  const rightLocation = hasSpecifiedLocation(right);
  if (leftLocation !== rightLocation) {
    return leftLocation ? -1 : 1;
  }
  return 0;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
