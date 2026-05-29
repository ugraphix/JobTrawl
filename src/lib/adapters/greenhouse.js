import { buildNormalizedJob, cleanText, fetchJson, safeText } from "./shared.js";

export async function fetchGreenhouseJobs(source) {
  const boardToken = source.boardToken || source.slug;
  const url = new URL(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs`);
  url.searchParams.set("content", "true");

  const payload = await fetchJson(url);
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const officeLookup = await fetchGreenhouseOfficeLookup(boardToken);

  return jobs.map((job) => {
    const locationLabel = resolveGreenhouseLocationLabel(job, officeLookup) || job.location?.name || "Unspecified";

    return buildNormalizedJob(source, {
      id: job.id,
      company: source.company,
      title: job.title,
      team: job.departments?.map((item) => item.name).join(", ") || null,
      department: job.offices?.map((item) => item.name).join(", ") || null,
      locationLabel,
      postedAt: job.first_published || job.created_at || null,
      updatedAt: job.updated_at || null,
      dateStatus: (job.first_published || job.created_at) ? "posted" : job.updated_at ? "updated" : "unknown",
      applyUrl: job.absolute_url,
      descriptionSnippet: safeText(job.content),
      searchText: cleanText(job.content),
      rawLocationText: locationLabel,
    });
  });
}

async function fetchGreenhouseOfficeLookup(boardToken) {
  try {
    const payload = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/offices`);
    const offices = Array.isArray(payload.offices) ? payload.offices : [];
    return new Map(offices.map((office) => [office.id, office]));
  } catch {
    return new Map();
  }
}

function resolveGreenhouseLocationLabel(job, officeLookup) {
  const locationName = cleanText(job?.location?.name || "");
  if (!locationName || hasStateOrCountry(locationName) || officeLookup.size === 0) {
    return locationName || null;
  }

  for (const office of Array.isArray(job?.offices) ? job.offices : []) {
    const resolved = resolveOfficeLocationLabel(office, locationName, officeLookup);
    if (resolved) {
      return resolved;
    }
  }

  return locationName || null;
}

function resolveOfficeLocationLabel(office, locationName, officeLookup) {
  const matchedOffice = officeLookup.get(office?.id);
  if (!matchedOffice) {
    return null;
  }

  const directLocation = cleanText(matchedOffice.location || "");
  if (directLocation && includesLocationName(directLocation, locationName) && hasStateOrCountry(directLocation)) {
    return directLocation;
  }

  const childLocations = (Array.isArray(matchedOffice.child_ids) ? matchedOffice.child_ids : [])
    .map((childId) => officeLookup.get(childId))
    .filter(Boolean)
    .map((childOffice) => cleanText(childOffice.location || childOffice.name || ""))
    .filter((value) => includesLocationName(value, locationName) && hasStateOrCountry(value));
  const inferredState = inferConsistentState(childLocations);
  if (inferredState) {
    return `${locationName}, ${inferredState}`;
  }

  const parentOffice = officeLookup.get(matchedOffice.parent_id);
  const parentText = cleanText(`${parentOffice?.name || ""} ${parentOffice?.location || ""}`);
  if (/\bnorthern california\b|\bsouthern california\b|\bcalifornia\b|\bca\b/i.test(parentText)) {
    return `${locationName}, CA`;
  }

  return null;
}

function hasStateOrCountry(value) {
  return /,\s*[A-Z]{2}(?:\s+\d{5})?\b/.test(value)
    || /\b(united states|usa|canada|india|brazil|mexico|colombia|australia|united kingdom)\b/i.test(value);
}

function includesLocationName(value, locationName) {
  return cleanText(value).toLowerCase().includes(cleanText(locationName).toLowerCase());
}

function inferConsistentState(locations) {
  const states = [...new Set(
    locations
      .map((location) => location.match(/,\s*([A-Z]{2})(?:\s+\d{5})?\b/)?.[1] || null)
      .filter(Boolean)
  )];
  return states.length === 1 ? states[0] : null;
}
