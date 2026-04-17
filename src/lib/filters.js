export const RECENCY_WINDOWS = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "14d": 14 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export const DISTANCE_OPTIONS = [3, 5, 10, 15, 20];

const LOCATION_ALIASES = [
  { aliases: ["seattle", "sea"], latitude: 47.6062, longitude: -122.3321 },
  { aliases: ["bellevue"], latitude: 47.6101, longitude: -122.2015 },
  { aliases: ["redmond"], latitude: 47.674, longitude: -122.1215 },
  { aliases: ["kirkland"], latitude: 47.6815, longitude: -122.2087 },
  { aliases: ["tacoma"], latitude: 47.2529, longitude: -122.4443 },
  { aliases: ["everett"], latitude: 47.978, longitude: -122.2021 },
  { aliases: ["san francisco", "sf"], latitude: 37.7749, longitude: -122.4194 },
  { aliases: ["san jose"], latitude: 37.3382, longitude: -121.8863 },
  { aliases: ["mountain view"], latitude: 37.3861, longitude: -122.0839 },
  { aliases: ["palo alto"], latitude: 37.4419, longitude: -122.143 },
  { aliases: ["los angeles", "la"], latitude: 34.0522, longitude: -118.2437 },
  { aliases: ["san diego"], latitude: 32.7157, longitude: -117.1611 },
  { aliases: ["new york city", "new york", "nyc"], latitude: 40.7128, longitude: -74.006 },
  { aliases: ["brooklyn"], latitude: 40.6782, longitude: -73.9442 },
  { aliases: ["queens"], latitude: 40.7282, longitude: -73.7949 },
  { aliases: ["albany"], latitude: 42.6526, longitude: -73.7562 },
  { aliases: ["austin"], latitude: 30.2672, longitude: -97.7431 },
  { aliases: ["dallas"], latitude: 32.7767, longitude: -96.797 },
  { aliases: ["houston"], latitude: 29.7604, longitude: -95.3698 },
  { aliases: ["boston"], latitude: 42.3601, longitude: -71.0589 },
  { aliases: ["cambridge"], latitude: 42.3736, longitude: -71.1097 },
  { aliases: ["chicago"], latitude: 41.8781, longitude: -87.6298 },
  { aliases: ["denver"], latitude: 39.7392, longitude: -104.9903 },
  { aliases: ["boulder"], latitude: 40.015, longitude: -105.2705 },
  { aliases: ["atlanta"], latitude: 33.749, longitude: -84.388 },
  { aliases: ["miami"], latitude: 25.7617, longitude: -80.1918 },
  { aliases: ["tampa"], latitude: 27.9506, longitude: -82.4572 },
  { aliases: ["raleigh"], latitude: 35.7796, longitude: -78.6382 },
  { aliases: ["charlotte"], latitude: 35.2271, longitude: -80.8431 },
  { aliases: ["portland"], latitude: 45.5152, longitude: -122.6784 },
  { aliases: ["philadelphia"], latitude: 39.9526, longitude: -75.1652 },
  { aliases: ["pittsburgh"], latitude: 40.4406, longitude: -79.9959 },
  { aliases: ["arlington"], latitude: 38.8816, longitude: -77.091 },
  { aliases: ["reston"], latitude: 38.9586, longitude: -77.357 },
  { aliases: ["washington dc", "washington, dc", "district of columbia", "dc"], latitude: 38.9072, longitude: -77.0369 },
  { aliases: ["london", "united kingdom", "uk"], latitude: 51.5072, longitude: -0.1276 },
  { aliases: ["warsaw", "poland"], latitude: 52.2297, longitude: 21.0122 },
];

export function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toIsoDate(value) {
  const date = value instanceof Date ? value : parseDate(value);
  return date ? date.toISOString() : null;
}

export function matchesKeyword(job, keyword, keywordScope = "title_and_description") {
  if (!keyword) {
    return true;
  }

  const query = normalizeText(keyword);
  if (!query) {
    return true;
  }

  const title = normalizeText(job.title);
  const description = normalizeText(job.searchText || job.descriptionSnippet);
  const queryWords = query.split(" ").filter(Boolean);
  const searchInDescription = keywordScope === "title_and_description";

  if (queryWords.length > 1) {
    if (title.includes(query)) {
      return true;
    }

    return searchInDescription ? description.includes(query) : false;
  }

  const haystack = normalizeText(
    [
      job.title,
      searchInDescription ? job.descriptionSnippet : null,
    ]
      .filter(Boolean)
      .join(" ")
  );

  return haystack.includes(query);
}

export function isLikelyJobPosting(job) {
  const title = normalizeText(job?.title);
  const applyUrl = String(job?.applyUrl || "").toLowerCase();

  if (!title || title.length < 4) {
    return false;
  }

  const blockedExactTitles = new Set([
    "about us",
    "benefits",
    "blog",
    "careers",
    "career opportunities",
    "contact us",
    "current openings",
    "employee login",
    "eeo statement",
    "eeo statement and accommodation request",
    "events",
    "job alerts",
    "job opportunities",
    "join our talent network",
    "locations",
    "log in",
    "login",
    "open positions",
    "our culture",
    "our events",
    "physicians and providers",
    "recently viewed jobs",
    "saved jobs",
    "search jobs",
    "search our open positions",
    "nursing careers",
    "search provider careers",
    "search nursing careers",
    "sign in",
    "talent community",
    "talent network",
    "team members",
    "all careers",
    "view my profile",
    "view all jobs",
    "view chi jobs",
    "view jobs",
  ]);

  if (blockedExactTitles.has(title)) {
    return false;
  }

  const blockedTitlePatterns = [
    /\b(applicant login|employee login|forgot password)\b/i,
    /\b(benefits|blog|culture|events|faqs|locations|saved jobs|team members?)\b/i,
    /\b(eeo statement|accommodation request|physicians and providers|view my profile)\b/i,
    /\b(search|view)\b.*\b(jobs|careers)\b/i,
    /\btalent (community|network)\b/i,
  ];

  if (blockedTitlePatterns.some((pattern) => pattern.test(title))) {
    return false;
  }

  const blockedHrefFragments = [
    "/about",
    "/benefits",
    "/blog",
    "/culture",
    "/employee",
    "/eeo",
    "/events",
    "/faq",
    "/faqs",
    "/locations",
    "/log-in",
    "/login",
    "/saved-jobs",
    "/savedjobs",
    "/sign-in",
    "/signin",
    "/talent-network",
    "/talentcommunity",
    "/team-members",
    "/profile",
  ];

  return !blockedHrefFragments.some((fragment) => applyUrl.includes(fragment));
}

export function matchesRecency(job, recencyKey) {
  if (!recencyKey || !RECENCY_WINDOWS[recencyKey] || !job.postedAt) {
    return true;
  }

  return Date.now() - new Date(job.postedAt).getTime() <= RECENCY_WINDOWS[recencyKey];
}

export function inferWorkArrangement(text) {
  const value = (text || "").toLowerCase();

  if (!value) {
    return "unknown";
  }

  if (value.includes("remote")) {
    return value.includes("hybrid") ? "hybrid" : "remote";
  }

  if (value.includes("hybrid")) {
    return "hybrid";
  }

  if (value.includes("on-site") || value.includes("onsite") || value.includes("office")) {
    return "onsite";
  }

  return "unknown";
}

export function normalizeCompany(value, fallback = "Unknown company") {
  return (value || fallback).trim();
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }

  return output;
}

export function normalizeWorkArrangement(value) {
  const arrangement = (value || "").toLowerCase();
  if (["remote", "hybrid", "onsite", "unknown"].includes(arrangement)) {
    return arrangement;
  }
  return inferWorkArrangement(value);
}

export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s,.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesLocationGroups(job, locationGroups) {
  const groups = (locationGroups || []).filter((group) => group && (group.stateCode || (group.areaNames && group.areaNames.length > 0)));

  if (groups.length === 0) {
    return true;
  }

  const haystack = normalizeLocationHaystack(job);

  return groups.some((group) => {
    const stateMatch = !group.stateCode
      || haystack.includes(normalizeText(group.stateCode))
      || haystack.includes(stateNameFromCode(group.stateCode));

    const areaNames = Array.isArray(group.areaNames) ? group.areaNames.filter(Boolean) : [];
    const areaMatch = areaNames.length === 0
      || areaNames.some((areaName) => haystack.includes(normalizeText(areaName)));

    return stateMatch && areaMatch;
  });
}

export function matchesUnitedStates(job) {
  const haystack = normalizeLocationHaystack(job);

  if (!haystack) {
    return false;
  }

  const normalizedCountry = normalizeText(job.country);
  const normalizedRegion = normalizeText(job.region);

  if (["us", "usa", "united states", "united states of america"].includes(normalizedCountry)) {
    return true;
  }

  if (normalizedRegion && stateNameFromCode(normalizedRegion.toUpperCase()) !== normalizedRegion) {
    return true;
  }

  return haystack.includes(" united states ")
    || haystack.startsWith("united states ")
    || haystack.endsWith(" united states")
    || haystack.includes(" usa ")
    || haystack.startsWith("usa ")
    || haystack.endsWith(" usa")
    || haystack.includes(" us ")
    || haystack.startsWith("us ")
    || haystack.endsWith(" us");
}

export function calculateJobDistanceMiles(job, originCoordinates) {
  if (!originCoordinates?.latitude || !originCoordinates?.longitude) {
    return null;
  }

  const jobCoordinates = extractJobCoordinates(job);
  if (!jobCoordinates) {
    return null;
  }

  return haversineMiles(originCoordinates.latitude, originCoordinates.longitude, jobCoordinates.latitude, jobCoordinates.longitude);
}

export function extractJobCoordinates(job) {
  const haystack = normalizeLocationHaystack(job);

  for (const location of LOCATION_ALIASES) {
    if (location.aliases.some((alias) => haystack.includes(normalizeText(alias)))) {
      return {
        latitude: location.latitude,
        longitude: location.longitude,
      };
    }
  }

  return null;
}

function normalizeLocationHaystack(job) {
  return normalizeText([
    job.locationLabel,
    job.rawLocationText,
    job.city,
    job.region,
    job.country,
  ].filter(Boolean).join(" "));
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMiles * c;
}

function stateNameFromCode(code) {
  const lookup = {
    CA: "california",
    CO: "colorado",
    FL: "florida",
    GA: "georgia",
    IL: "illinois",
    MA: "massachusetts",
    NC: "north carolina",
    NJ: "new jersey",
    NY: "new york",
    OR: "oregon",
    PA: "pennsylvania",
    TX: "texas",
    VA: "virginia",
    WA: "washington",
    DC: "district of columbia",
  };

  return lookup[code] || normalizeText(code);
}
