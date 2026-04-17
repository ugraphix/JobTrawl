const form = document.querySelector("#search-form");
const resultsNode = document.querySelector("#results");
const summaryNode = document.querySelector("#summary");
const sourceHealthNode = document.querySelector("#source-health");
const resultsCountNode = document.querySelector("#results-count");
const statusPillNode = document.querySelector("#status-pill");
const excludedCompaniesNode = document.querySelector("#excludedCompanies");
const atsSourceKeysNode = document.querySelector("#atsSourceKeys");
const websiteSourceKeysNode = document.querySelector("#websiteSourceKeys");
const excludedCompaniesCountNode = document.querySelector("#excludedCompaniesCount");
const atsSourcesCountNode = document.querySelector("#atsSourcesCount");
const websiteSourcesCountNode = document.querySelector("#websiteSourcesCount");
const websiteCollectionKeyNode = document.querySelector("#websiteCollectionKey");
const websiteCollectionDescriptionNode = document.querySelector("#websiteCollectionDescription");
const websiteSourcesGroupNode = document.querySelector("#websiteSourcesGroup");
const websiteSourcesDropdownNode = document.querySelector("#websiteSourcesDropdown");
const atsSourcesFieldsetNode = document.querySelector("#atsSourcesFieldset");
const atsSourcesContentNode = document.querySelector("#atsSourcesContent");
const excludeCompaniesFieldsetNode = document.querySelector("#excludeCompaniesFieldset");
const additionalSourcesFieldsetNode = document.querySelector("#additionalSourcesFieldset");
const additionalSourcesContentNode = document.querySelector("#additionalSourcesContent");
const arrangementsNode = document.querySelector("#arrangements");
const locationGroupsNode = document.querySelector("#location-groups");
const locationModeNoteNode = document.querySelector("#location-mode-note");
const manualLocationSection = document.querySelector("#manual-location-section");
const myLocationSection = document.querySelector("#my-location-section");
const distanceMilesNode = document.querySelector("#distanceMiles");
const locationModeInputs = document.querySelectorAll('input[name="locationMode"]');
const enableSourceCustomizationNode = document.querySelector("#enableSourceCustomization");
const searchAtsSourcesNode = document.querySelector("#searchAtsSources");
const searchAdditionalSourcesNode = document.querySelector("#searchAdditionalSources");
const syncSourcesButtonNode = document.querySelector("#syncSourcesButton");
const cacheStatusNode = document.querySelector("#cacheStatus");
const groupActionButtons = document.querySelectorAll('[data-group-action]');
const filterDropdownNodes = document.querySelectorAll('.filter-dropdown');

let bootstrapData = null;
let locationGroupCounter = 0;
let detectedLocation = null;
let geolocationRequested = false;

bootstrap();
form.addEventListener("submit", handleSearch);
websiteCollectionKeyNode.addEventListener("change", handleWebsiteCollectionChange);
enableSourceCustomizationNode.addEventListener("change", syncSourceCustomizationUI);
searchAtsSourcesNode.addEventListener("change", syncSourceCustomizationUI);
searchAdditionalSourcesNode.addEventListener("change", syncSourceCustomizationUI);
groupActionButtons.forEach((button) => button.addEventListener("click", handleGroupAction));
locationModeInputs.forEach((input) => input.addEventListener("change", handleLocationModeChange));
excludedCompaniesNode.addEventListener("change", updateDropdownCounts);
atsSourceKeysNode.addEventListener("change", updateDropdownCounts);
websiteSourceKeysNode.addEventListener("change", updateDropdownCounts);
filterDropdownNodes.forEach((dropdown) => dropdown.addEventListener("toggle", handleFilterDropdownToggle));
document.addEventListener("click", handleDocumentClick);
syncSourcesButtonNode.addEventListener("click", handleManualSync);

async function bootstrap() {
  try {
    const response = await fetch("/api/bootstrap", { signal: AbortSignal.timeout(10000) });
    const payload = await response.json();
    bootstrapData = payload;

    renderCheckboxGroup(arrangementsNode, payload.arrangements, (value) => ({
      value,
      label: titleCase(value),
      checked: false,
    }));

    renderCheckboxGroup(excludedCompaniesNode, sortByLabel(payload.companies, (value) => value), (value) => ({
      value,
      label: value,
      checked: false,
    }));

    renderCheckboxGroup(atsSourceKeysNode, sortByLabel(payload.atsSources, (source) => source.company), (source) => ({
      value: source.key,
      label: `${source.company} (${payload.providers[source.provider] || source.provider})`,
      checked: false,
    }));

    websiteCollectionKeyNode.innerHTML = [
      '<option value="">None</option>',
      ...sortByLabel(payload.websiteCollections, (collection) => collection.label).map((collection) => `<option value="${escapeAttribute(collection.key)}">${escapeHtml(collection.label)}</option>`),
    ].join("");
    renderWebsiteSources("");

    addLocationGroup();
    syncLocationModeUI();
    updateDropdownCounts();
    syncSourceCustomizationUI();
    renderCacheStatus(payload.cacheStatus);
  } catch (error) {
    setStatus("Error");
    resultsCountNode.textContent = "Unable to load filters";
    resultsNode.className = "results-list empty-state";
    resultsNode.textContent = error.message || "Bootstrap request failed.";
  }
}

async function handleManualSync() {
  syncSourcesButtonNode.disabled = true;
  syncSourcesButtonNode.textContent = "Syncing...";

  try {
    const body = buildSourceSelectionPayload();
    const response = await fetch("/api/cache/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Sync failed");
    }

    renderCacheStatus(payload.cacheStatus, `Synced ${payload.syncedSources} source${payload.syncedSources === 1 ? "" : "s"}.`);
  } catch (error) {
    renderCacheStatus(null, error.message || "Sync failed.");
  } finally {
    syncSourcesButtonNode.disabled = false;
    syncSourcesButtonNode.textContent = "Sync sources";
  }
}

async function handleSearch(event) {
  event.preventDefault();
  setStatus("Searching", true);
  resultsCountNode.textContent = "Searching configured sources...";
  resultsNode.className = "results-list";
  resultsNode.innerHTML = renderLoadingState();

  const locationMode = getLocationMode();

  if (locationMode === "my_location" && !detectedLocation) {
    await requestBrowserLocation();
  }

  if (locationMode === "my_location" && !detectedLocation?.coordinates) {
    setStatus("Location needed");
    resultsCountNode.textContent = "Location permission needed";
    resultsNode.className = "results-list empty-state";
    resultsNode.textContent = "We need your browser location before we can apply a mileage filter.";
    return;
  }

  const locationGroups = collectEffectiveLocationGroups(locationMode);

  const body = {
    keyword: form.keyword.value.trim(),
    recency: form.recency.value,
    arrangements: getCheckedValues(arrangementsNode),
    locationGroups,
    distanceMiles: locationMode === "my_location" ? form.distanceMiles.value : "",
    userCoordinates: locationMode === "my_location" && detectedLocation?.coordinates ? detectedLocation.coordinates : null,
    sourceSelectionMode: enableSourceCustomizationNode.checked ? "custom" : "all",
    searchAtsSources: enableSourceCustomizationNode.checked ? searchAtsSourcesNode.checked : true,
    searchAdditionalSources: enableSourceCustomizationNode.checked ? searchAdditionalSourcesNode.checked : true,
    websiteCollectionKey: websiteCollectionKeyNode.value,
    selectedAtsSourceKeys: getCheckedValues(atsSourceKeysNode),
    selectedWebsiteSourceKeys: getCheckedValues(websiteSourceKeysNode),
    excludedCompanies: getCheckedValues(excludedCompaniesNode),
  };

  if (body.sourceSelectionMode === "custom" && !body.searchAtsSources && !body.searchAdditionalSources) {
    setStatus("Choose sources");
    resultsCountNode.textContent = "No source types selected";
    summaryNode.textContent = "Turn on ATS/API sources, Additional sources, or both before searching.";
    sourceHealthNode.innerHTML = "";
    resultsNode.className = "results-list empty-state";
    resultsNode.textContent = "No search ran because no source types were selected.";
    return;
  }

  try {
    const response = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    const payload = await response.json();

    if (!response.ok) {
      setStatus("Error");
      resultsCountNode.textContent = "Search failed";
      resultsNode.className = "results-list empty-state";
      resultsNode.textContent = payload.error || "Unexpected error";
      return;
    }

    renderResults(payload, body, locationMode);
    setStatus("Complete");
  } catch (error) {
    setStatus("Timed out");
    resultsCountNode.textContent = "Search timed out";
    resultsNode.className = "results-list empty-state";
    resultsNode.textContent = "The search took too long. Try fewer sources or a broader filter set.";
  }
}

async function handleLocationModeChange() {
  syncLocationModeUI();

  if (getLocationMode() === "my_location" && !detectedLocation && !geolocationRequested) {
    await requestBrowserLocation();
  }
}

async function requestBrowserLocation() {
  if (!navigator.geolocation) {
    locationModeNoteNode.textContent = "Browser location is not available here. Continue using manual filters.";
    return;
  }

  geolocationRequested = true;
  locationModeNoteNode.textContent = "Getting your location...";

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(async (position) => {
      try {
        const location = await reverseGeocode(position.coords.latitude, position.coords.longitude);
        detectedLocation = location;
        const labelParts = [location.areaName, location.stateCode].filter(Boolean);
        locationModeNoteNode.textContent = labelParts.length > 0
          ? `Using browser location: ${labelParts.join(", ")}`
          : "Location found, but it could not be mapped to the current state and city lists.";
      } catch {
        detectedLocation = null;
        locationModeNoteNode.textContent = "Could not translate your browser location into a state and city. Manual filters are still available.";
      } finally {
        resolve();
      }
    }, () => {
      detectedLocation = null;
      locationModeNoteNode.textContent = "Location access was denied or unavailable. Continue using manual filters.";
      resolve();
    }, {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000,
    });
  });
}

async function reverseGeocode(latitude, longitude) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error("Reverse geocoding failed");
  }

  const payload = await response.json();
  const address = payload.address || {};
  const stateCode = mapStateNameToCode(address.state || address.region || "");
  const areaName = matchAreaName(stateCode, address.city || address.town || address.village || address.suburb || address.county || "");

  return {
    stateCode,
    areaName,
    coordinates: {
      latitude,
      longitude,
    },
  };
}

function mapStateNameToCode(stateName) {
  const normalized = String(stateName || "").trim().toLowerCase();
  const state = bootstrapData?.states?.find((item) => item.name.toLowerCase() === normalized || item.code.toLowerCase() === normalized);
  return state ? state.code : "";
}

function matchAreaName(stateCode, candidate) {
  const state = bootstrapData?.states?.find((item) => item.code === stateCode);
  if (!state) {
    return "";
  }

  const normalized = String(candidate || "").trim().toLowerCase();
  const match = state.areas.find((area) => area.toLowerCase() === normalized || normalized.includes(area.toLowerCase()) || area.toLowerCase().includes(normalized));
  return match || "";
}

function handleFilterDropdownToggle(event) {
  const current = event.currentTarget;
  const currentGroup = current.closest('.filter-group');

  if (!current.open) {
    syncFilterToolbar(currentGroup, false);
    return;
  }

  filterDropdownNodes.forEach((dropdown) => {
    if (dropdown !== current) {
      dropdown.open = false;
      syncFilterToolbar(dropdown.closest('.filter-group'), false);
    }
  });

  syncFilterToolbar(currentGroup, true);
}

function handleDocumentClick(event) {
  if (event.target.closest('.filter-group')) {
    return;
  }

  filterDropdownNodes.forEach((dropdown) => {
    dropdown.open = false;
    syncFilterToolbar(dropdown.closest('.filter-group'), false);
  });
}

function syncFilterToolbar(groupNode, visible) {
  const toolbar = groupNode?.querySelector('.filter-toolbar');
  if (!toolbar) {
    return;
  }

  toolbar.hidden = !visible;
}

function handleWebsiteCollectionChange() {
  renderWebsiteSources(websiteCollectionKeyNode.value);
}

function syncSourceCustomizationUI() {
  const customizeEnabled = enableSourceCustomizationNode.checked;
  const useAts = searchAtsSourcesNode.checked;
  const useAdditional = searchAdditionalSourcesNode.checked;

  atsSourcesFieldsetNode.hidden = !customizeEnabled;
  additionalSourcesFieldsetNode.hidden = !customizeEnabled;
  atsSourcesContentNode.hidden = !useAts;
  additionalSourcesContentNode.hidden = !useAdditional;
  atsSourcesFieldsetNode.classList.toggle("fieldset-disabled", customizeEnabled && !useAts);
  additionalSourcesFieldsetNode.classList.toggle("fieldset-disabled", customizeEnabled && !useAdditional);

  if (!customizeEnabled) {
    filterDropdownNodes.forEach((dropdown) => {
      dropdown.open = false;
      syncFilterToolbar(dropdown.closest('.filter-group'), false);
    });
  }
}

function renderWebsiteSources(collectionKey) {
  const collection = bootstrapData?.websiteCollections?.find((item) => item.key === collectionKey);
  const hasCollection = Boolean(collection);

  websiteSourcesGroupNode.hidden = !hasCollection;
  websiteSourcesDropdownNode.open = false;
  syncFilterToolbar(websiteSourcesGroupNode, false);

  if (!collection) {
    websiteCollectionDescriptionNode.textContent = "";
    websiteSourceKeysNode.innerHTML = "";
    updateDropdownCounts();
    return;
  }

  websiteCollectionDescriptionNode.textContent = collection.description || "";
  renderCheckboxGroup(websiteSourceKeysNode, sortByLabel(collection.sources, (source) => source.company), (source) => ({
    value: source.key,
    label: `${source.company} (${bootstrapData.providers[source.provider] || source.provider})`,
    checked: true,
  }));
  updateDropdownCounts();
}

function buildSourceSelectionPayload() {
  return {
    sourceSelectionMode: enableSourceCustomizationNode.checked ? "custom" : "all",
    searchAtsSources: enableSourceCustomizationNode.checked ? searchAtsSourcesNode.checked : true,
    searchAdditionalSources: enableSourceCustomizationNode.checked ? searchAdditionalSourcesNode.checked : true,
    websiteCollectionKey: websiteCollectionKeyNode.value,
    selectedAtsSourceKeys: getCheckedValues(atsSourceKeysNode),
    selectedWebsiteSourceKeys: getCheckedValues(websiteSourceKeysNode),
  };
}

function renderCacheStatus(cacheStatus, prefix = "") {
  if (!cacheStatusNode) {
    return;
  }

  if (!cacheStatus) {
    cacheStatusNode.textContent = prefix || "";
    return;
  }

  const parts = [];
  if (prefix) {
    parts.push(prefix);
  }
  parts.push(`${cacheStatus.cachedJobs || 0} cached jobs`);
  parts.push(`${cacheStatus.cachedSources || 0} cached sources`);
  parts.push(`backend: ${cacheStatus.backend || "unknown"}`);
  if (cacheStatus.lastError) {
    parts.push(`last sync issue: ${cacheStatus.lastError}`);
  }
  cacheStatusNode.textContent = parts.join(" · ");
}

function handleGroupAction(event) {
  const action = event.currentTarget.dataset.groupAction;
  const target = event.currentTarget.dataset.target;
  const container = document.querySelector(`#${target}`);

  if (!container) {
    return;
  }

  const checked = action === "select-all";
  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = checked;
  });
  updateDropdownCounts();
}

function updateDropdownCounts() {
  setDropdownCount(excludedCompaniesNode, excludedCompaniesCountNode, "selected");
  setDropdownCount(atsSourceKeysNode, atsSourcesCountNode, "selected");
  setDropdownCount(websiteSourceKeysNode, websiteSourcesCountNode, "selected");
}

function setDropdownCount(container, labelNode, suffix) {
  if (!container || !labelNode) {
    return;
  }

  const checkedCount = container.querySelectorAll('input[type="checkbox"]:checked').length;
  labelNode.textContent = `${checkedCount} ${suffix}`;
}

function getLocationMode() {
  return [...locationModeInputs].find((input) => input.checked)?.value || "";
}

function syncLocationModeUI() {
  const locationMode = getLocationMode();
  const manualActive = locationMode === "manual";
  const myLocationActive = locationMode === "my_location";

  manualLocationSection.hidden = !manualActive;
  myLocationSection.hidden = !myLocationActive;
  distanceMilesNode.disabled = !myLocationActive;

  locationGroupsNode.querySelectorAll(".location-state, .area-checkboxes input, .remove-location-group, .area-select-all, .area-clear-all, .add-location-link").forEach((element) => {
    element.disabled = !manualActive;
  });

  if (myLocationActive) {
    if (detectedLocation) {
      const labelParts = [detectedLocation.areaName, detectedLocation.stateCode].filter(Boolean);
      locationModeNoteNode.textContent = labelParts.length > 0
        ? `Using browser location: ${labelParts.join(", ")}`
        : "Location found, but it could not be mapped to the current state and city lists.";
    } else {
      locationModeNoteNode.textContent = "Allow browser location access to use your current area.";
    }
  }

  if (!myLocationActive) {
    distanceMilesNode.value = "";
  }
}

function addLocationGroup(initialStateCode = "", initialAreaNames = []) {
  const wrapper = document.createElement("div");
  wrapper.className = "location-group";
  wrapper.dataset.groupId = `location-group-${locationGroupCounter += 1}`;

  wrapper.innerHTML = `
    <div class="location-group-header">
      <strong>State filter</strong>
      <button type="button" class="text-button remove-location-group">Remove</button>
    </div>
    <label>
      <span>State</span>
      <select class="location-state">
        <option value="">Any state</option>
        ${sortByLabel(bootstrapData.states, (state) => state.name).map((state) => `<option value="${escapeAttribute(state.code)}" ${state.code === initialStateCode ? "selected" : ""}>${escapeHtml(state.name)}</option>`).join("")}
      </select>
    </label>
    <button type="button" class="text-button add-location-link">+ <span>add additional locations</span></button>
    <div class="group-actions area-actions">
      <button type="button" class="text-button area-select-all">Select all cities</button>
      <button type="button" class="text-button area-clear-all">Clear all cities</button>
    </div>
    <div class="checkbox-grid tall-grid area-checkboxes"></div>
  `;

  locationGroupsNode.appendChild(wrapper);

  const stateSelect = wrapper.querySelector(".location-state");
  const areaContainer = wrapper.querySelector(".area-checkboxes");
  const removeButton = wrapper.querySelector(".remove-location-group");
  const addButton = wrapper.querySelector(".add-location-link");
  const selectAllButton = wrapper.querySelector(".area-select-all");
  const clearAllButton = wrapper.querySelector(".area-clear-all");

  stateSelect.addEventListener("change", () => renderAreaCheckboxes(wrapper, []));
  removeButton.addEventListener("click", () => {
    if (locationGroupsNode.children.length > 1) {
      wrapper.remove();
    } else {
      stateSelect.value = "";
      renderAreaCheckboxes(wrapper, []);
    }
  });
  addButton.addEventListener("click", () => addLocationGroup());
  selectAllButton.addEventListener("click", () => setAreaCheckboxes(areaContainer, true));
  clearAllButton.addEventListener("click", () => setAreaCheckboxes(areaContainer, false));

  renderAreaCheckboxes(wrapper, initialAreaNames);
  syncLocationModeUI();
}

function renderAreaCheckboxes(wrapper, checkedAreaNames = []) {
  const stateCode = wrapper.querySelector(".location-state").value;
  const areaContainer = wrapper.querySelector(".area-checkboxes");
  const state = bootstrapData.states.find((item) => item.code === stateCode);
  const areas = sortByLabel(state?.areas || [], (area) => area);

  if (areas.length === 0) {
    areaContainer.innerHTML = '<div class="muted-copy">Choose a state to see available cities and areas.</div>';
    return;
  }

  areaContainer.innerHTML = areas.map((area) => `
    <label class="checkbox-item">
      <input type="checkbox" value="${escapeAttribute(area)}" ${checkedAreaNames.includes(area) ? "checked" : ""}>
      <span>${escapeHtml(area)}</span>
    </label>
  `).join("");

  syncLocationModeUI();
}

function setAreaCheckboxes(container, checked) {
  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = checked;
  });
}

function collectManualLocationGroups() {
  return [...locationGroupsNode.querySelectorAll(".location-group")]
    .map((group) => ({
      stateCode: group.querySelector(".location-state").value,
      areaNames: [...group.querySelectorAll('.area-checkboxes input[type="checkbox"]:checked')].map((input) => input.value),
    }))
    .filter((group) => group.stateCode || group.areaNames.length > 0);
}

function collectEffectiveLocationGroups(locationMode) {
  if (locationMode === "manual") {
    return collectManualLocationGroups();
  }

  if (locationMode === "my_location" && detectedLocation && (detectedLocation.stateCode || detectedLocation.areaName)) {
    return [{
      stateCode: detectedLocation.stateCode || "",
      areaNames: detectedLocation.areaName ? [detectedLocation.areaName] : [],
    }];
  }

  return [];
}

function renderResults(payload, filters, locationMode) {
  const datedJobs = payload.jobs.filter((job) => job.postedAt || job.updatedAt);
  const unknownDateJobs = payload.jobs.filter((job) => !job.postedAt && !job.updatedAt);
  const totalJobs = payload.jobs.length;

  resultsCountNode.textContent = `${totalJobs} matched job${totalJobs === 1 ? "" : "s"} found`;
  summaryNode.textContent = buildSummary(payload, filters, locationMode);
  renderSourceHealth(payload.sources);

  if (payload.jobs.length === 0) {
    resultsNode.className = "results-list empty-state";
    resultsNode.textContent = "No jobs matched the current filters. Try widening the recency window, changing arrangements, or using fewer exclusions.";
    return;
  }

  resultsNode.className = "results-list";

  const datedMarkup = datedJobs.length > 0
    ? datedJobs.map(renderJobCard).join("")
    : totalJobs > 0
      ? '<div class="empty-state subtle-empty-state">No matches with known dates were found. The matches below have unknown posted dates.</div>'
      : '<div class="empty-state subtle-empty-state">No jobs with known dates matched these filters.</div>';

  const unknownMarkup = unknownDateJobs.length > 0
    ? `
      <details class="unknown-results-panel" ${datedJobs.length === 0 ? "open" : ""}>
        <summary>${datedJobs.length === 0 ? "Matched jobs with unknown dates" : "Show jobs with unknown dates"} (${unknownDateJobs.length})</summary>
        <div class="unknown-results-list">
          ${unknownDateJobs.map(renderJobCard).join("")}
        </div>
      </details>
    `
    : "";

  resultsNode.innerHTML = `${datedMarkup}${unknownMarkup}`;
}

function renderSourceHealth(sources) {
  const failures = sources.filter((source) => source.error);
  const zeroJobs = sources.filter((source) => !source.error && source.jobCount === 0);
  const withJobs = sources.filter((source) => !source.error && source.jobCount > 0);

  const summaryParts = [
    `${withJobs.length} sources returned jobs`,
    `${zeroJobs.length} returned 0 jobs`,
    `${failures.length} failed`,
  ];

  const topJobSources = withJobs.slice(0, 8).map((source) => `<span class="source-chip">${escapeHtml(`${source.company}: ${source.jobCount} matches`)}</span>`).join("");
  const failureItems = failures.map((source) => `<div class="source-detail-row">${escapeHtml(`${source.company}: ${source.error}`)}</div>`).join("");
  const zeroJobItems = zeroJobs.slice(0, 40).map((source) => `<div class="source-detail-row">${escapeHtml(`${source.company}: 0 matches from ${source.rawJobCount || 0} scraped jobs`)}</div>`).join("");
  const allItems = sources.map((source) => {
    const text = source.error
      ? `${source.company}: failed (${source.error})`
      : `${source.company}: ${source.jobCount} matches from ${source.rawJobCount || 0} scraped jobs (${source.datedCount || 0} dated, ${source.unknownDateCount || 0} unknown-date)`;
    return `<div class="source-detail-row">${escapeHtml(text)}</div>`;
  }).join("");

  sourceHealthNode.innerHTML = `
    <div class="source-health-summary">${escapeHtml(summaryParts.join(" • "))}</div>
    <div class="source-health-top">${topJobSources || '<span class="muted-copy">No sources returned jobs for this search.</span>'}</div>
    <details class="source-health-details">
      <summary>Show source details</summary>
      ${failures.length > 0 ? `<div class="source-detail-block"><strong>Failures</strong>${failureItems}</div>` : ""}
      ${zeroJobs.length > 0 ? `<div class="source-detail-block"><strong>0-job sources</strong>${zeroJobItems}</div>` : ""}
      <div class="source-detail-block"><strong>All selected sources</strong>${allItems}</div>
    </details>
  `;
}

function renderJobCard(job) {
  const dateLine = formatDateLine(job);
  const distancePill = Number.isFinite(job.distanceMiles)
    ? `<span class="pill">${escapeHtml(`${job.distanceMiles.toFixed(1)} miles away`)}</span>`
    : "";

  return `
    <article class="job-card">
      <div class="job-head">
        <div>
          <h3>${escapeHtml(job.title)}</h3>
          <p class="company-line">${escapeHtml(job.company)} · ${escapeHtml(job.provider)}</p>
        </div>
        <div class="pill-row">
          <span class="pill">${escapeHtml(job.workArrangement || "unknown")}</span>
          ${job.employmentType ? `<span class="pill">${escapeHtml(job.employmentType)}</span>` : ""}
        </div>
      </div>
      <div class="pill-row">
        <span class="pill">${escapeHtml(job.locationLabel || "Unspecified")}</span>
        ${job.team ? `<span class="pill">${escapeHtml(job.team)}</span>` : ""}
        ${distancePill}
      </div>
      <div class="job-meta">
        <div>${escapeHtml(dateLine)}</div>
        <div>Source key: ${escapeHtml(job.sourceKey)}</div>
        ${job.descriptionSnippet ? `<div class="job-snippet">${escapeHtml(job.descriptionSnippet)}</div>` : ""}
      </div>
      <div class="job-actions">
        <a href="${escapeAttribute(job.applyUrl)}" target="_blank" rel="noreferrer">Open application</a>
      </div>
    </article>
  `;
}

function buildSummary(payload, filters, locationMode) {
  const successText = `${payload.meta.successfulSources} of ${payload.meta.searchedSources} sources responded`;
  const unknownDateText = `${payload.jobs.filter((job) => !job.postedAt && !job.updatedAt).length} jobs have unknown dates.`;
  const keywordText = filters.keyword
    ? `Keyword filter: ${filters.keyword}.`
    : "No keyword filter is active.";
  const arrangementText = filters.arrangements.length > 0
    ? `Arrangements: ${filters.arrangements.join(", ")}.`
    : "All arrangements included.";

  let locationText = "No location filter is active.";
  if (locationMode === "manual" && filters.locationGroups.length > 0) {
    locationText = `Manual locations: ${filters.locationGroups.map(formatLocationGroup).join(" | ")}.`;
  } else if (locationMode === "my_location") {
    if (filters.userCoordinates && filters.distanceMiles) {
      locationText = `Using browser location within ${filters.distanceMiles} miles.`;
    } else if (filters.locationGroups.length > 0) {
      locationText = `Using browser location: ${filters.locationGroups.map(formatLocationGroup).join(" | ")}.`;
    } else {
      locationText = "Using browser location, but no mapped state or city was detected yet.";
    }
  }

  return `${successText}. ${unknownDateText} ${keywordText} ${arrangementText} ${locationText}`;
}

function renderLoadingState() {
  return `
    <div class="loading-state">
      <div>Searching job sources and filtering results</div>
      ${renderLoadingDots()}
    </div>
  `;
}

function renderLoadingDots() {
  return '<span class="loading-dots" aria-hidden="true"><span></span><span></span><span></span></span>';
}

function formatLocationGroup(group) {
  if (group.areaNames.length > 0) {
    return `${group.stateCode}: ${group.areaNames.join(", ")}`;
  }

  return `${group.stateCode}: all listed areas`;
}

function setStatus(text, isLoading = false) {
  statusPillNode.classList.toggle("loading", isLoading);
  statusPillNode.innerHTML = isLoading
    ? `${escapeHtml(text)} ${renderLoadingDots()}`
    : escapeHtml(text);
}

function renderCheckboxGroup(node, items, mapItem) {
  node.innerHTML = items
    .map((item) => {
      const option = mapItem(item);
      return `
        <label class="checkbox-item">
          <input type="checkbox" value="${escapeAttribute(option.value)}" ${option.checked ? "checked" : ""}>
          <span>${escapeHtml(option.label)}</span>
        </label>
      `;
    })
    .join("");
}

function getCheckedValues(node) {
  return [...node.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
}

function formatDateLine(job) {
  if (job.postedAt) {
    return `Posted on ${new Date(job.postedAt).toLocaleString()}`;
  }

  if (job.updatedAt) {
    return `Updated on ${new Date(job.updatedAt).toLocaleString()}`;
  }

  return "Date unknown";
}

function titleCase(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

function sortByLabel(items, getLabel) {
  return [...items].sort((left, right) => {
    const leftLabel = String(getLabel(left) || "");
    const rightLabel = String(getLabel(right) || "");
    return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base" });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}



