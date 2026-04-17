const USER_AGENT = "ats-job-aggregator/0.1 (local development)";
const cache = new Map();

export async function geocodeLocation(query) {
  if (!query) {
    return null;
  }

  const key = query.trim().toLowerCase();
  if (!key) {
    return null;
  }

  if (cache.has(key)) {
    return cache.get(key);
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      cache.set(key, null);
      return null;
    }

    const [match] = await response.json();
    const result = match
      ? {
          lat: Number(match.lat),
          lon: Number(match.lon),
          label: match.display_name,
        }
      : null;

    cache.set(key, result);
    return result;
  } catch {
    cache.set(key, null);
    return null;
  }
}

export function haversineMiles(from, to) {
  if (!from || !to) {
    return null;
  }

  const radiusMiles = 3958.8;
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLon = toRadians(to.lon - from.lon);

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return radiusMiles * c;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}