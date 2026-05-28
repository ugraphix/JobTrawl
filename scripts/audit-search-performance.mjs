const endpoint = process.env.JOBTRAWL_SEARCH_ENDPOINT || "http://localhost:3001/api/search";

const searches = [
  {
    name: "product-manager-loose-default",
    body: buildSearchBody({ usOnly: false, recency: "7d", keywordMode: "loose" }),
  },
  {
    name: "product-manager-loose-7d-us",
    body: buildSearchBody({ usOnly: true, recency: "7d", keywordMode: "loose" }),
  },
  {
    name: "product-manager-loose-24h-us",
    body: buildSearchBody({ usOnly: true, recency: "24h", keywordMode: "loose" }),
  },
  {
    name: "product-manager-strict-7d-us",
    body: buildSearchBody({ usOnly: true, recency: "7d", keywordMode: "strict" }),
  },
];

for (const search of searches) {
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(search.body),
  });
  const payloadText = await response.text();
  const elapsedMs = Date.now() - startedAt;
  const payloadBytes = Buffer.byteLength(payloadText);
  const payload = JSON.parse(payloadText);
  const jobs = Array.isArray(payload.confirmedUsJobs) && payload.confirmedUsJobs.length > 0
    ? payload.confirmedUsJobs
    : Array.isArray(payload.jobs)
      ? payload.jobs
      : [];

  console.log(JSON.stringify({
    name: search.name,
    status: response.status,
    elapsedMs,
    headlineCount: payload.headlineCount,
    verifiedUsCount: payload.confirmedUsCount,
    unknownLocationCount: payload.unknownLocationCount,
    nonUsDroppedCount: payload.nonUsDroppedCount,
    providerBreakdown: buildProviderBreakdown(jobs),
    payloadBytes,
    candidateRows: payload.meta?.candidateRows ?? null,
    generatedCandidateRows: payload.meta?.generatedCandidateRows ?? null,
    curatedCandidateRows: payload.meta?.curatedCandidateRows ?? null,
    timings: payload.meta?.timings || {},
    searchTimings: payload.meta?.searchTimings || {},
    suspiciousVerifiedUsJobs: search.body.usOnly ? findSuspiciousVerifiedUsJobs(jobs) : [],
  }, null, 2));
}

function buildSearchBody({ usOnly, recency, keywordMode }) {
  return {
    keyword: "product manager",
    keywordMode,
    recency,
    usOnly,
    sourceSelectionMode: "all",
    sourceCustomizationMode: "companies",
    arrangements: [],
    locationGroups: [],
  };
}

function buildProviderBreakdown(jobs) {
  const breakdown = {};
  for (const job of jobs) {
    const provider = String(job?.provider || "unknown");
    breakdown[provider] = (breakdown[provider] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(breakdown).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  );
}

function findSuspiciousVerifiedUsJobs(jobs) {
  const suspiciousPattern = /\b(india|australia|poland|bulgaria|canada|ireland|israel|brazil|mexico|colombia|south africa|hong kong)\b/i;
  return jobs
    .filter((job) => suspiciousPattern.test([
      job?.title,
      job?.locationLabel,
      job?.rawLocationText,
      job?.city,
      job?.region,
      job?.country,
    ].filter(Boolean).join(" ")))
    .slice(0, 10)
    .map((job) => ({
      title: job.title,
      company: job.company,
      provider: job.provider,
      sourceKey: job.sourceKey,
      locationLabel: job.locationLabel,
      country: job.country,
      applyUrl: job.applyUrl,
    }));
}
