import { absoluteUrl, buildNormalizedJob, cleanText, decodeHtmlEntities, fetchJson, fetchText } from "./shared.js";

export async function fetchManatalJobs(source) {
  const config = resolveManatalConfig(source);
  if (!config.jobsApiUrl) {
    throw new Error("Manatal source requires careersUrl or domainSlug");
  }

  const landingHtml = await fetchText(config.careersUrl);
  const runtimeConfig = extractRuntimeConfig(landingHtml, config, config.careersUrl);
  const postings = [];
  const seenUrls = new Set();

  for (let page = 1; page <= 25; page += 1) {
    const url = `${runtimeConfig.jobsApiUrl}${runtimeConfig.jobsApiUrl.includes("?") ? "&" : "?"}${new URLSearchParams({
      page: String(page),
      page_size: "50",
      ordering: "-is_pinned_in_career_page,-last_published_at",
    }).toString()}`;

    let responseJson;
    try {
      responseJson = await fetchJson(url, {
        headers: {
          Referer: runtimeConfig.boardUrl,
        },
      });
    } catch (error) {
      if (page > 1 && Number(error?.status || 0) === 404) {
        break;
      }
      throw error;
    }

    const results = Array.isArray(responseJson?.results) ? responseJson.results : [];
    if (results.length === 0) {
      break;
    }

    for (const job of results) {
      const applyUrl = buildJobUrl(runtimeConfig, job);
      if (!applyUrl || seenUrls.has(applyUrl)) {
        continue;
      }

      const locationParts = [
        cleanInlineText(job.location_display),
        cleanInlineText(job.city),
        cleanInlineText(job.state),
        cleanInlineText(job.country),
      ].filter(Boolean);

      let postedAt = null;
      for (const field of ["last_published_at", "published_at", "posting_date", "posted_date", "updated_at", "created_at"]) {
        const candidate = cleanInlineText(job?.[field]);
        if (candidate) {
          postedAt = candidate;
          break;
        }
      }

      const locationLabel = locationParts[0] || locationParts.slice(1).join(", ") || "Unspecified";
      postings.push(buildNormalizedJob(source, {
        id: applyUrl,
        company: source.company,
        title: cleanInlineText(job.position_name || job.title) || "Untitled Position",
        team: cleanInlineText(job.organization_name) || null,
        department: cleanInlineText(job.organization_name) || null,
        locationLabel,
        postedAt,
        applyUrl,
        rawLocationText: locationLabel,
      }));
      seenUrls.add(applyUrl);
    }

    if (!responseJson?.next) {
      break;
    }
  }

  return postings;
}

function resolveManatalConfig(source) {
  const careersUrl = String(source.careersUrl || source.boardUrl || "").trim();
  const parsed = safeUrl(careersUrl);
  const host = String(parsed?.hostname || "").toLowerCase();
  const pathParts = String(parsed?.pathname || "").split("/").filter(Boolean);
  const hostSubdomain = host.endsWith(".careers-page.com") && host !== "www.careers-page.com"
    ? String(host.split(".")[0] || "").trim().toLowerCase()
    : "";
  const domainSlug = String(source.domainSlug || hostSubdomain || pathParts[0] || "").trim().toLowerCase();
  const boardUrl = careersUrl || (domainSlug ? `https://www.careers-page.com/${domainSlug}/` : "");
  return {
    careersUrl: boardUrl,
    boardUrl,
    domainSlug,
    publicBaseUrl: "https://www.careers-page.com",
    jobsApiUrl: domainSlug ? `https://www.careers-page.com/api/v1.0/c/${encodeURIComponent(domainSlug)}/jobs/` : "",
  };
}

function extractRuntimeConfig(pageHtml, fallbackConfig, finalUrl) {
  const source = String(pageHtml || "");
  const baseUrlRaw = String(source.match(/const\s+baseUrl\s*=\s*['"]([^'"]+)['"]/i)?.[1] || "").trim();
  const publicBaseUrl = (baseUrlRaw || fallbackConfig.publicBaseUrl || "https://www.careers-page.com").replace(/\/+$/, "");
  const candidatePatterns = [
    /const\s+clientSlug\s*=\s*['"]([^'"]+)['"]/i,
    /data-domain_slug\s*=\s*['"]([^'"]+)['"]/i,
    /<a[^>]*class=['"][^'"]*\bnavbar-brand\b[^'"]*['"][^>]*href=['"]\/([^\/"'?#]+)/i,
    /<meta[^>]*property=['"]og:type['"][^>]*content=['"]\s*([^|'"]+?)\s*\|/i,
  ];
  const candidates = candidatePatterns
    .map((pattern) => String(source.match(pattern)?.[1] || "").trim().toLowerCase())
    .filter(Boolean);
  const finalParsed = safeUrl(finalUrl);
  const finalHost = String(finalParsed?.hostname || "").toLowerCase();
  if (finalHost.endsWith(".careers-page.com") && finalHost !== "www.careers-page.com") {
    candidates.unshift(String(finalHost.split(".")[0] || "").trim().toLowerCase());
  }
  candidates.push(fallbackConfig.domainSlug);
  const domainSlug = candidates.find((value) => value && value !== "job" && value !== "jobs" && value !== "www") || fallbackConfig.domainSlug;
  const protocol = String(finalParsed?.protocol || "https:");
  const hostWithPort = String(finalParsed?.host || "www.careers-page.com");
  const boardUrl = finalHost === "www.careers-page.com"
    ? `${protocol}//${hostWithPort}/${domainSlug}/`
    : finalHost.endsWith(".careers-page.com")
      ? `${protocol}//${hostWithPort}/`
      : fallbackConfig.boardUrl;

  return {
    ...fallbackConfig,
    domainSlug,
    publicBaseUrl,
    boardUrl,
    careersUrl: boardUrl,
    jobsApiUrl: `${publicBaseUrl}/api/v1.0/c/${encodeURIComponent(domainSlug)}/jobs/`,
  };
}

function buildJobUrl(config, item) {
  for (const key of ["url", "job_url", "apply_url", "public_url"]) {
    const raw = String(item?.[key] || "").trim();
    if (!raw) {
      continue;
    }
    const resolved = absoluteUrl(raw, config.boardUrl);
    if (resolved) {
      return resolved;
    }
  }

  const hash = String(item?.hash || "").trim();
  return hash && config.domainSlug
    ? `${config.publicBaseUrl}/${config.domainSlug}/job/${encodeURIComponent(hash)}`
    : config.boardUrl;
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function cleanInlineText(value) {
  return cleanText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))) || "";
}
