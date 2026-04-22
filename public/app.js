const form = document.querySelector("#search-form");
const resultsNode = document.querySelector("#results");
const summaryNode = document.querySelector("#summary");
const sourceHealthNode = document.querySelector("#source-health");
const resultsCountNode = document.querySelector("#results-count");
const statusPillNode = document.querySelector("#status-pill");
const resultsVisibilityControlsNode = document.querySelector("#results-visibility-controls");
const excludedCompaniesNode = document.querySelector("#excludedCompanies");
const excludedCompaniesSearchNode = document.querySelector("#excludedCompaniesSearch");
const includedCompaniesNode = document.querySelector("#includedCompanies");
const includedCompaniesSearchNode = document.querySelector("#includedCompaniesSearch");
const atsSourceKeysNode = document.querySelector("#atsSourceKeys");
const excludedCompaniesCountNode = document.querySelector("#excludedCompaniesCount");
const includedCompaniesCountNode = document.querySelector("#includedCompaniesCount");
const atsSourcesCountNode = document.querySelector("#atsSourcesCount");
const atsSourcesFieldsetNode = document.querySelector("#atsSourcesFieldset");
const atsSourcesContentNode = document.querySelector("#atsSourcesContent");
const includedCompaniesFieldsetNode = document.querySelector("#includedCompaniesFieldset");
const excludeCompaniesFieldsetNode = document.querySelector("#excludeCompaniesFieldset");
const arrangementsNode = document.querySelector("#arrangements");
const usOnlyNode = document.querySelector("#usOnly");
const locationGroupsNode = document.querySelector("#location-groups");
const locationModeNoteNode = document.querySelector("#location-mode-note");
const manualLocationSection = document.querySelector("#manual-location-section");
const myLocationSection = document.querySelector("#my-location-section");
const distanceMilesNode = document.querySelector("#distanceMiles");
const locationModeInputs = document.querySelectorAll('input[name="locationMode"]');
const enableSourceCustomizationNode = document.querySelector("#enableSourceCustomization");
const sourceCustomizationModeInputs = document.querySelectorAll('input[name="sourceCustomizationMode"]');
const groupActionButtons = document.querySelectorAll('[data-group-action]');
const filterDropdownNodes = document.querySelectorAll('.filter-dropdown');
const keywordInputNode = document.querySelector("#keyword");
const searchButtonNode = document.querySelector(".search-button");
const SEARCH_REQUEST_TIMEOUT_MS = 180000;
const SEARCH_PROGRESS_POLL_MS = 900;
const SEARCH_PROGRESS_STALE_MS = 2800;
const SEARCH_STATE_STORAGE_KEY = "jobtrawl:last-search-state";
const HIDDEN_POSTS_STORAGE_KEY = "jobtrawl:hidden-posts";
const TRACKER_REFRESH_TIMEOUT_MS = 70000;
const SEARCH_BUTTON_INTENT_WINDOW_MS = 1500;

let bootstrapData = null;
let trackedApplications = [];
let renderedJobsByKey = new Map();
let hiddenPostKeys = loadHiddenPostKeys();
let showHiddenPosts = false;
let latestRenderedSearchState = null;
let locationGroupCounter = 0;
let detectedLocation = null;
let geolocationRequested = false;
let activeSearchRequestId = "";
let activeSearchProgressTimer = null;
let activeSearchStartedAt = 0;
let activeSearchLastServerProgressAt = 0;
let activeSearchTimelineTick = 0;
let activeSearchProgressRequestInFlight = false;
let trackedApplicationsRefreshPromise = null;
let searchButtonIntentUntil = 0;

bootstrap();
form.addEventListener("submit", handleSearch);
keywordInputNode?.addEventListener("keydown", handleKeywordKeydown);
searchButtonNode?.addEventListener("click", markSearchButtonIntent);
enableSourceCustomizationNode.addEventListener("change", syncSourceCustomizationUI);
sourceCustomizationModeInputs.forEach((input) => input.addEventListener("change", syncSourceCustomizationUI));
groupActionButtons.forEach((button) => button.addEventListener("click", handleGroupAction));
locationModeInputs.forEach((input) => input.addEventListener("change", handleLocationModeChange));
excludedCompaniesNode.addEventListener("change", updateDropdownCounts);
excludedCompaniesSearchNode?.addEventListener("input", handleExcludedCompaniesSearch);
includedCompaniesNode?.addEventListener("change", updateDropdownCounts);
includedCompaniesSearchNode?.addEventListener("input", handleIncludedCompaniesSearch);
atsSourceKeysNode.addEventListener("change", updateDropdownCounts);
filterDropdownNodes.forEach((dropdown) => dropdown.addEventListener("toggle", handleFilterDropdownToggle));
document.addEventListener("click", handleDocumentClick);
resultsNode.addEventListener("change", handleResultsToggle);
resultsVisibilityControlsNode?.addEventListener("click", handleVisibilityControlsClick);
window.addEventListener("focus", handleWindowFocus);
document.addEventListener("visibilitychange", handleVisibilityChange);

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
      label: formatCompanyLabel(value),
      checked: false,
    }));

    renderCheckboxGroup(includedCompaniesNode, sortByLabel(payload.companies, (value) => value), (value) => ({
      value,
      label: formatCompanyLabel(value),
      checked: false,
    }));

    renderCheckboxGroup(atsSourceKeysNode, payload.atsProviders, (provider) => ({
      value: provider.key,
      label: provider.label,
      checked: false,
    }));

    addLocationGroup();
    syncLocationModeUI();
    updateDropdownCounts();
    syncSourceCustomizationUI();
    await refreshTrackedApplications();
    if (shouldRestorePersistedSearchState()) {
      restorePersistedSearchState();
    }
  } catch (error) {
    setStatus("Error");
    resultsCountNode.textContent = "Unable to load filters";
    resultsNode.className = "results-list empty-state";
    resultsNode.textContent = error.message || "Bootstrap request failed.";
  }
}

async function handleSearch(event) {
  event.preventDefault();
  if (!isExplicitSearchSubmit(event)) {
    return;
  }

  const searchRequestId = createSearchRequestId();
  activeSearchRequestId = searchRequestId;
  activeSearchStartedAt = Date.now();
  setStatus("Searching", true);
  updateLoadingUi({
    stage: "queued",
    message: "Preparing your search",
    detail: "JobTrawl is checking your filters and getting the source list ready.",
    percent: 2,
  });
  startSearchProgressPolling(searchRequestId);

  resultsNode.className = "results-list";

  const locationMode = getLocationMode();

  if (locationMode === "my_location" && !detectedLocation) {
    await requestBrowserLocation();
  }

  if (locationMode === "my_location" && !detectedLocation?.coordinates) {
    stopSearchProgressPolling();
    setStatus("Location needed");
    resultsCountNode.textContent = "Location permission needed";
    resultsNode.className = "results-list empty-state";
    resultsNode.textContent = "We need your browser location before we can apply a mileage filter.";
    return;
  }

  const locationGroups = collectEffectiveLocationGroups(locationMode);

  const body = buildSearchPayload(locationMode, locationGroups);
  body.searchRequestId = searchRequestId;

  try {
    const response = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS),
    });

    const payload = await response.json();
    stopSearchProgressPolling();

    if (!response.ok) {
      setStatus("Error");
      resultsCountNode.textContent = "Search failed";
      resultsNode.className = "results-list empty-state";
      resultsNode.textContent = payload.error || "Unexpected error";
      return;
    }

    await runFinalLoadingSequence(payload);
    renderResults(payload, body, locationMode);
    setStatus("Complete");
  } catch (error) {
    stopSearchProgressPolling();
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

function syncSourceCustomizationUI() {
  const customizeEnabled = enableSourceCustomizationNode.checked;
  const customizationMode = getSourceCustomizationMode();

  const customizeModeFieldset = document.querySelector("#customizeSearchModeFieldset");
  customizeModeFieldset.hidden = !customizeEnabled;
  atsSourcesFieldsetNode.hidden = !customizeEnabled || customizationMode !== "ats";
  excludeCompaniesFieldsetNode.hidden = !customizeEnabled || customizationMode !== "companies";
  atsSourcesContentNode.hidden = customizationMode !== "ats";
  atsSourcesFieldsetNode.classList.toggle("fieldset-disabled", customizationMode !== "ats");
  excludeCompaniesFieldsetNode.classList.toggle("fieldset-disabled", customizationMode !== "companies");

  if (!customizeEnabled) {
    filterDropdownNodes.forEach((dropdown) => {
      dropdown.open = false;
      syncFilterToolbar(dropdown.closest('.filter-group'), false);
    });
  }
}

function markSearchButtonIntent() {
  searchButtonIntentUntil = Date.now() + SEARCH_BUTTON_INTENT_WINDOW_MS;
}

function isExplicitSearchSubmit(event) {
  const submitter = event?.submitter;
  if (submitter === searchButtonNode) {
    return true;
  }

  if (document.activeElement === searchButtonNode) {
    return true;
  }

  return Date.now() <= searchButtonIntentUntil;
}

function handleKeywordKeydown(event) {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
}

function handleExcludedCompaniesSearch(event) {
  filterCheckboxGroup(excludedCompaniesNode, event.currentTarget.value);
}

function handleIncludedCompaniesSearch(event) {
  filterCheckboxGroup(includedCompaniesNode, event.currentTarget.value);
}

function buildSourceSelectionPayload() {
  const selectedAtsProviderKeys = getCheckedValues(atsSourceKeysNode);
  const includedCompanies = getCheckedValues(includedCompaniesNode);
  let sourceCustomizationMode = getSourceCustomizationMode();

  if (selectedAtsProviderKeys.length > 0 && includedCompanies.length === 0) {
    sourceCustomizationMode = "ats";
  } else if (includedCompanies.length > 0 && selectedAtsProviderKeys.length === 0) {
    sourceCustomizationMode = "companies";
  }

  const hasExplicitSelection = selectedAtsProviderKeys.length > 0 || includedCompanies.length > 0;
  const sourceSelectionMode = enableSourceCustomizationNode.checked || hasExplicitSelection ? "custom" : "all";

  return {
    sourceSelectionMode,
    sourceCustomizationMode,
    selectedAtsProviderKeys: sourceSelectionMode === "custom" && sourceCustomizationMode === "ats" ? selectedAtsProviderKeys : [],
    includedCompanies: sourceSelectionMode === "custom" && sourceCustomizationMode === "companies" ? includedCompanies : [],
  };
}

function buildSearchPayload(locationMode = getLocationMode(), locationGroups = collectEffectiveLocationGroups(locationMode)) {
  return {
    keyword: form.keyword.value.trim(),
    keywordMode: form.keywordMode?.value || "strict",
    recency: form.recency.value,
    arrangements: getCheckedValues(arrangementsNode),
    usOnly: Boolean(usOnlyNode?.checked),
    locationGroups,
    distanceMiles: locationMode === "my_location" ? form.distanceMiles.value : "",
    userCoordinates: locationMode === "my_location" && detectedLocation?.coordinates ? detectedLocation.coordinates : null,
    excludedCompanies: getCheckedValues(excludedCompaniesNode),
    ...buildSourceSelectionPayload(),
  };
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
  setDropdownCount(includedCompaniesNode, includedCompaniesCountNode, "selected");
  setDropdownCount(atsSourceKeysNode, atsSourcesCountNode, "selected");
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

function getSourceCustomizationMode() {
  return [...sourceCustomizationModeInputs].find((input) => input.checked)?.value || "ats";
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
  persistSearchState(payload, filters, locationMode);
  latestRenderedSearchState = cloneSearchState({ payload, filters, locationMode });
  renderedJobsByKey = new Map();
  const datedAndUnknownDateJobs = [
    ...(Array.isArray(payload.jobs) ? payload.jobs : []),
    ...(Array.isArray(payload.unknownDateJobs) ? payload.unknownDateJobs : []),
  ];
  datedAndUnknownDateJobs.forEach((job) => {
    const trackerKey = buildTrackerKey(job);
    const hidePostKey = buildHidePostKey(job);
    job.trackerKey = trackerKey;
    job.hidePostKey = hidePostKey;
    job.hiddenByUser = hiddenPostKeys.has(hidePostKey);
    renderedJobsByKey.set(trackerKey, job);
  });

  const hiddenJobsCount = datedAndUnknownDateJobs.filter((job) => job.hiddenByUser).length;
  const visibleJobs = showHiddenPosts
    ? (Array.isArray(payload.jobs) ? payload.jobs : [])
    : (Array.isArray(payload.jobs) ? payload.jobs.filter((job) => !job.hiddenByUser) : []);
  const visibleUnknownDateJobs = showHiddenPosts
    ? (Array.isArray(payload.unknownDateJobs) ? payload.unknownDateJobs : [])
    : (Array.isArray(payload.unknownDateJobs) ? payload.unknownDateJobs.filter((job) => !job.hiddenByUser) : []);
  renderResultsVisibilityControls(hiddenJobsCount);

  const usLocationUnknownJobs = visibleJobs.filter((job) => job.usLocationUnknown);
  const jobsWithKnownUsLocation = visibleJobs.filter((job) => !job.usLocationUnknown);
  const unknownArrangementJobs = jobsWithKnownUsLocation.filter((job) => job.arrangementUnknown);
  const primaryJobs = jobsWithKnownUsLocation.filter((job) => !job.arrangementUnknown);
  const datedJobs = primaryJobs.filter((job) => job.postedAt || job.updatedAt);
  const unknownDateJobs = [
    ...primaryJobs.filter((job) => !job.postedAt && !job.updatedAt),
    ...visibleUnknownDateJobs,
  ];
  const totalJobs = visibleJobs.length + visibleUnknownDateJobs.length;

  resultsCountNode.textContent = hiddenJobsCount > 0
    ? `${totalJobs} matched job${totalJobs === 1 ? "" : "s"} found • ${hiddenJobsCount} hidden`
    : `${totalJobs} matched job${totalJobs === 1 ? "" : "s"} found`;
  summaryNode.textContent = buildSummary(payload, filters, locationMode);
  renderSourceHealth(payload.sources);

  if (datedAndUnknownDateJobs.length === 0) {
    resultsNode.className = "results-list empty-state";
    resultsNode.textContent = "No jobs matched the current filters. Try widening the recency window, changing arrangements, or using fewer exclusions.";
    return;
  }

  if (visibleJobs.length === 0 && visibleUnknownDateJobs.length === 0) {
    resultsNode.className = "results-list empty-state";
    resultsNode.textContent = "All matched jobs are currently hidden. Turn on Show hidden posts to review them again.";
    return;
  }

  resultsNode.className = "results-list";

  const datedMarkup = datedJobs.length > 0
    ? datedJobs.map(renderJobCard).join("")
    : unknownArrangementJobs.length > 0
      ? '<div class="empty-state subtle-empty-state">Some matching jobs do not specify remote, hybrid, or onsite status. Those matches are listed below in the unknown work arrangement section.</div>'
    : usLocationUnknownJobs.length > 0
      ? '<div class="empty-state subtle-empty-state">Location details were not available in some matching job postings. Those matches are listed below in the unspecified-location section.</div>'
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

  const unknownUsLocationMarkup = usLocationUnknownJobs.length > 0
    ? `
      <details class="unknown-results-panel">
        <summary>Show jobs with unspecified location that may still be in the U.S. (${usLocationUnknownJobs.length})</summary>
        <div class="unknown-results-list">
          ${usLocationUnknownJobs.map(renderJobCard).join("")}
        </div>
      </details>
    `
    : "";

  const unknownArrangementMarkup = unknownArrangementJobs.length > 0
    ? `
      <details class="unknown-results-panel" ${datedJobs.length === 0 && unknownDateJobs.length === 0 ? "open" : ""}>
        <summary>Show jobs with unknown work arrangement that may still match your selected arrangement filters (${unknownArrangementJobs.length})</summary>
        <div class="unknown-results-list">
          ${unknownArrangementJobs.map(renderJobCard).join("")}
        </div>
      </details>
    `
    : "";

  resultsNode.innerHTML = `${datedMarkup}${unknownMarkup}${unknownArrangementMarkup}${unknownUsLocationMarkup}`;
}

function persistSearchState(payload, filters, locationMode) {
  try {
    sessionStorage.setItem(SEARCH_STATE_STORAGE_KEY, JSON.stringify({
      payload,
      filters,
      locationMode,
      savedAt: new Date().toISOString(),
    }));
  } catch {
    // Ignore storage failures and keep the live page usable.
  }
}

function restorePersistedSearchState() {
  try {
    const raw = sessionStorage.getItem(SEARCH_STATE_STORAGE_KEY);
    if (!raw) {
      return;
    }

    const savedState = JSON.parse(raw);
    if (!savedState?.payload || !Array.isArray(savedState.payload.jobs)) {
      return;
    }

    renderResults(savedState.payload, savedState.filters || {}, savedState.locationMode || getLocationMode());
    setStatus("Complete");
  } catch {
    // Ignore malformed saved state.
  }
}

function shouldRestorePersistedSearchState() {
  try {
    const navigationEntry = performance.getEntriesByType?.("navigation")?.[0];
    if (navigationEntry?.type === "back_forward") {
      return true;
    }
  } catch {
    // Ignore performance API issues and skip restore.
  }

  return false;
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

async function handleResultsToggle(event) {
  const hidePostInput = event.target.closest(".hide-post-input");
  if (hidePostInput) {
    handleHidePostToggle(hidePostInput);
    return;
  }

  const trackInput = event.target.closest(".track-application-input");
  if (!trackInput) {
    return;
  }

  const trackerKey = trackInput.dataset.trackerKey || "";
  const job = renderedJobsByKey.get(trackerKey);
  if (!job) {
    return;
  }

  const toggle = trackInput.closest(".track-save-toggle");

  if (!trackInput.checked) {
    await handleResultsUnsave(job, trackInput, toggle);
    return;
  }

  await handleResultsSave(job, trackInput, toggle);
}

function handleVisibilityControlsClick(event) {
  const button = event.target.closest("#showHiddenPostsButton");
  if (!button) {
    return;
  }

  hiddenPostKeys.clear();
  persistHiddenPostKeys(hiddenPostKeys);
  showHiddenPosts = false;
  rerenderCurrentResults();
}

function handleHidePostToggle(input) {
  const hidePostKey = input.dataset.hidePostKey || "";
  if (!hidePostKey) {
    return;
  }

  if (input.checked) {
    hiddenPostKeys.add(hidePostKey);
    showHiddenPosts = false;
  } else {
    hiddenPostKeys.delete(hidePostKey);
  }

  persistHiddenPostKeys(hiddenPostKeys);
  if (input.checked) {
    window.setTimeout(() => {
      rerenderCurrentResults();
    }, 180);
    return;
  }

  rerenderCurrentResults();
}

function renderTrackerSummary(paths = {}) {
  return paths;
}

function buildTrackedApplicationPayload(job) {
  const compensation = extractCompensationFromJob(job);
  const jobId = extractJobIdentifier(job);
  return {
    company: job.company || "",
    position: job.title || "",
    jobId,
    jobUrl: job.applyUrl || "",
    trackerKey: job.trackerKey || "",
    pdfCopyOfListing: "",
    compensation,
    resumeProvided: "",
    coverLetter: "",
    applyDate: "",
    status: "Saved",
    listingTextSnapshot: buildDescriptionSnapshot(job) || normalizePreviewText(job.searchText || job.descriptionSnippet || ""),
    descriptionSnippet: normalizePreviewText(job.descriptionSnippet || ""),
    searchText: normalizePreviewText(job.searchText || ""),
  };
}

function buildTrackerKey(job) {
  const base = [
    job.sourceKey || "",
    job.company || "",
    job.title || "",
    job.applyUrl || "",
  ].join("|");

  return base
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, "-")
    .replace(/-+/g, "-");
}

function isJobTracked(job) {
  return Boolean(findTrackedApplication(job));
}

function findTrackedApplication(job) {
  const trackerKey = normalizeSearchText(job.trackerKey);
  const jobUrl = normalizeSearchText(job.applyUrl);
  const company = normalizeSearchText(job.company);
  const title = normalizeSearchText(job.title);

  return trackedApplications.find((application) => {
    const sameTrackerKey = trackerKey && normalizeSearchText(application.trackerKey) === trackerKey;
    if (sameTrackerKey) {
      return true;
    }

    const sameUrl = jobUrl && normalizeSearchText(application.jobUrl) === jobUrl;
    const sameCompanyAndTitle = !jobUrl
      && company
      && title
      && normalizeSearchText(application.company) === company
      && normalizeSearchText(application.position) === title;

    return sameUrl || sameCompanyAndTitle;
  }) || null;
}

function renderJobCard(job) {
  const dateLine = formatDateLine(job);
  const arrangementValue = job.workArrangement || "unknown";
  const arrangementLabel = titleCase(arrangementValue);
  const descriptionPreview = buildDescriptionPreview(job);
  const compensation = extractCompensationFromJob(job);
  const jobId = extractJobIdentifier(job);
  const locationVariants = collectLocationVariants(job);
  const distancePill = Number.isFinite(job.distanceMiles)
    ? `<span class="pill">${escapeHtml(`${job.distanceMiles.toFixed(1)} miles away`)}</span>`
    : "";
  const usUnknownPill = job.usLocationUnknown
    ? '<span class="pill">U.S. match unknown</span>'
    : "";
  const alreadyTracked = isJobTracked(job);
  const hideCheckboxChecked = job.hiddenByUser && !showHiddenPosts;
  const warningCards = [];

  if (job?.repostInfo?.isPossibleRepost) {
    warningCards.push(`
      <div class="job-warning-card">
        <div class="job-repost-banner">${escapeHtml(job.repostInfo.label || "POSSIBLE REPOST")}</div>
        ${Array.isArray(job.repostInfo.details) && job.repostInfo.details.length > 0
          ? `<div class="job-repost-details">${job.repostInfo.details.map((detail) => `<div>${escapeHtml(detail)}</div>`).join("")}</div>`
          : ""}
      </div>
    `);
  }

  if (job?.duplicateInfo?.isPossibleDuplicate) {
    warningCards.push(`
      <div class="job-warning-card">
        <div class="job-repost-banner job-duplicate-banner">${escapeHtml(job.duplicateInfo.label || "POSSIBLE DUPLICATE")}</div>
        ${Array.isArray(job.duplicateInfo.details) && job.duplicateInfo.details.length > 0
          ? `<div class="job-repost-details job-duplicate-details">${job.duplicateInfo.details.map((detail) => `<div>${escapeHtml(detail)}</div>`).join("")}</div>`
          : ""}
      </div>
    `);
  }

  const warningMarkup = `
    <div class="job-repost-banner-wrap">
      <div class="job-warning-stack">
        ${warningCards.join("")}
      </div>
    </div>
  `;

  return `
    <article class="job-card">
      <div class="job-head">
        <div>
          <h3>${escapeHtml(job.title)}</h3>
          <p class="company-line">${escapeHtml(job.company)} · ${escapeHtml(job.provider)}</p>
        </div>
        <div class="job-label-stack">
          <div class="job-label-heading">Working arrangement</div>
          <div class="pill-row arrangement-pill-row">
            <span class="pill">${escapeHtml(arrangementLabel)}</span>
          </div>
          ${job.employmentType ? `<div class="job-inline-note">${escapeHtml(job.employmentType)}</div>` : ""}
        </div>
      </div>
      <div class="pill-row">
        ${locationVariants.map((variant) => `<span class="pill">${escapeHtml(variant.locationLabel || "Unspecified")}</span>`).join("")}
        ${job.team ? `<span class="pill">${escapeHtml(job.team)}</span>` : ""}
        ${distancePill}
        ${usUnknownPill}
      </div>
      <div class="job-detail-row has-repost-banner">
        <div class="job-meta">
          <div>${escapeHtml(dateLine)}</div>
          ${jobId ? `<div>Job ID: ${escapeHtml(jobId)}</div>` : ""}
          <div>Source key: ${escapeHtml(job.sourceKey)}</div>
          ${compensation ? `<div>Compensation: ${escapeHtml(compensation)}</div>` : ""}
        </div>
        ${warningMarkup}
      </div>
      ${descriptionPreview ? `
        <div class="job-snippet-block">
          <div class="job-snippet-label">Job description</div>
          <div class="job-snippet">${escapeHtml(descriptionPreview)}</div>
        </div>
      ` : ""}
      <div class="job-actions">
        ${renderOpenApplicationLinks(locationVariants)}
        <label class="job-visibility-toggle job-actions-hide-toggle">
          <input
            type="checkbox"
            class="hide-post-input"
            data-hide-post-key="${escapeAttribute(job.hidePostKey || "")}"
            ${hideCheckboxChecked ? "checked" : ""}
          >
          <span>Hide this post</span>
        </label>
        <label class="track-save-toggle ${alreadyTracked ? "saved" : ""}">
          <input
            type="checkbox"
            class="track-application-input"
            data-tracker-key="${escapeAttribute(job.trackerKey || "")}"
            ${alreadyTracked ? "checked" : ""}
          >
          <span class="track-save-copy">${alreadyTracked ? "Saved to application tracker sheet" : "Save to application tracker sheet"}</span>
        </label>
      </div>
    </article>
  `;
}

function collectLocationVariants(job = {}) {
  const rawVariants = Array.isArray(job.locationVariants) && job.locationVariants.length > 0
    ? job.locationVariants
    : [{
        locationLabel: job.locationLabel || "Unspecified",
        applyUrl: job.applyUrl || "",
        externalId: job.externalId || "",
      }];

  const variants = [];
  const seen = new Set();

  for (const variant of rawVariants) {
    const locationLabel = String(variant?.locationLabel || job.locationLabel || "Unspecified").trim() || "Unspecified";
    const applyUrl = String(variant?.applyUrl || job.applyUrl || "").trim();
    const dedupeKey = `${applyUrl.toLowerCase()}|${locationLabel.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    variants.push({
      locationLabel,
      applyUrl,
      externalId: String(variant?.externalId || "").trim(),
    });
  }

  return variants;
}

function renderOpenApplicationLinks(locationVariants = []) {
  if (locationVariants.length <= 1) {
    const onlyVariant = locationVariants[0];
    return `<a href="${escapeAttribute(onlyVariant?.applyUrl || "#")}" target="_blank" rel="noreferrer">Open application</a>`;
  }

  return `
    <div class="job-open-links">
      ${locationVariants.map((variant) => `
        <a href="${escapeAttribute(variant.applyUrl || "#")}" target="_blank" rel="noreferrer">
          ${escapeHtml(`Open application - ${variant.locationLabel || "Unspecified"}`)}
        </a>
      `).join("")}
    </div>
  `;
}

function buildSummary(payload, filters, locationMode) {
  const successText = `${payload.meta.successfulSources} of ${payload.meta.searchedSources} sources responded`;
  const unknownDateText = `${payload.jobs.filter((job) => !job.postedAt && !job.updatedAt).length} jobs have unknown dates.`;
  const unknownUsLocationText = filters.usOnly
    ? `${payload.jobs.filter((job) => job.usLocationUnknown).length} jobs have unspecified location and are shown separately.`
    : "";
  const unknownArrangementText = filters.arrangements.length > 0
    ? `${payload.jobs.filter((job) => job.arrangementUnknown).length} jobs have unknown work arrangement and are shown separately.`
    : "";
  const keywordText = filters.keyword
    ? `Keyword filter: ${filters.keyword}. ${filters.keywordMode === "loose" ? "Loose keyword search is active." : "Strict keyword search is active."}`
    : "No keyword filter is active.";
  const arrangementText = filters.arrangements.length > 0
    ? `Arrangements: ${filters.arrangements.join(", ")}.`
    : "All arrangements included.";
  const countryText = filters.usOnly
    ? "Only United States jobs are included."
    : "Jobs from all countries are included.";

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

  return `${successText}. ${unknownDateText} ${unknownUsLocationText} ${unknownArrangementText} ${keywordText} ${arrangementText} ${countryText} ${locationText}`;
}

function renderLoadingState() {
  return renderLoadingStateMarkup({
    message: "Searching job sources and filtering results",
    detail: "JobTrawl is checking cache first and then reaching out to employer job boards as needed.",
    percent: 8,
  });
}

function renderLoadingStateMarkup(progress = {}) {
  const percent = clampProgressPercent(progress.percent);
  const progressLabel = buildProgressLabel(progress);
  const loadingStepsMarkup = buildLoadingStepsMarkup(progress);
  return `
    <div class="loading-state">
      <div class="loading-header">
        <div class="loading-eyebrow">Search in progress</div>
        <div class="loading-progress-wrap">
          <div class="loading-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
            <span style="width: ${percent}%"></span>
          </div>
          <div class="loading-meta">${escapeHtml(progressLabel)}</div>
        </div>
      </div>
      <div class="loading-title">${escapeHtml(progress.message || "Searching job sources and filtering results")} ${renderLoadingDots()}</div>
      <div class="loading-detail">${escapeHtml(progress.detail || "JobTrawl is working through the selected sources.")}</div>
      ${loadingStepsMarkup}
    </div>
  `;
}

function renderLoadingDots() {
  return '<span class="loading-dots" aria-hidden="true"><span></span><span></span><span></span></span>';
}

function buildLoadingStepsMarkup(progress = {}) {
  const steps = getLoadingTimelineSteps(progress);
  if (steps.length === 0) {
    return "";
  }

  return `
    <div class="loading-steps" aria-label="Search progress steps">
      ${steps.map((step) => `
        <div class="loading-step ${step.state}">
          <div class="loading-step-marker">${step.state === "done" ? "✓" : step.index}</div>
          <div class="loading-step-copy">
            <div class="loading-step-title">${escapeHtml(step.title)}</div>
            <div class="loading-step-detail">${escapeHtml(step.detail)}</div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function getLoadingTimelineSteps(progress = {}) {
  const stage = progress.stage || "loading_sources";
  const steps = stage === "filtering"
    ? [
        {
          key: "cache",
          title: "Checking cache",
          detail: "Reusing fast local matches before the app reaches out to live job boards.",
        },
        {
          key: "locations",
          title: "Searching locations",
          detail: "Applying your location and filter choices to the jobs that have been found.",
        },
        {
          key: "sources",
          title: "Loading sources",
          detail: "Pulling ATS and career-page results into one shared list.",
        },
        {
          key: "sorting",
          title: "Sorting job titles",
          detail: "Filtering titles, removing duplicates, and cleaning up the combined match list.",
        },
        {
          key: "descriptions",
          title: "Grabbing job descriptions",
          detail: "Keeping the role details that are useful for the result cards.",
        },
        {
          key: "cards",
          title: "Creating cards",
          detail: "Organizing the final matches into cards for the results page.",
        },
      ]
    : [
        {
          key: "cache",
          title: "Checking cache",
          detail: "Looking for fresh cached matches first so faster results can show up sooner.",
        },
        {
          key: "locations",
          title: "Searching locations",
          detail: "Getting your selected city, state, distance, and arrangement filters ready.",
        },
        {
          key: "sources",
          title: "Loading sources",
          detail: "Starting ATS feeds and employer career pages that match this search.",
        },
        {
          key: "sorting",
          title: "Sorting job titles",
          detail: "Lining up title matches while slower boards continue loading in the background.",
        },
        {
          key: "descriptions",
          title: "Grabbing job descriptions",
          detail: "Collecting role details like responsibilities, location, and work arrangement where available.",
        },
        {
          key: "cards",
          title: "Creating cards",
          detail: "Preparing the final result cards so the page is ready to show them.",
        },
      ];

  const currentKey = String(progress.timelineKey || "");
  let activeIndex = steps.findIndex((step) => step.key === currentKey);
  if (activeIndex === -1) {
    activeIndex = Math.max(0, Math.min(steps.length - 1, Number(progress.timelineStep || 1) - 1));
  }

  return steps.map((step, index) => ({
    ...step,
    index: index + 1,
    state: index < activeIndex ? "done" : index === activeIndex ? "active" : "pending",
  }));
}

function formatLocationGroup(group) {
  if (group.areaNames.length > 0) {
    return `${group.stateCode}: ${group.areaNames.join(", ")}`;
  }

  return `${group.stateCode}: all listed areas`;
}

function setStatus(text, isLoading = false) {
  document.body.classList.toggle("searching-active", isLoading);
  statusPillNode.classList.toggle("loading", isLoading);
  statusPillNode.innerHTML = isLoading
    ? `${escapeHtml(text)} ${renderLoadingDots()}`
    : escapeHtml(text);
  if (!isLoading) {
    statusPillNode.classList.remove("loading");
  }
}

function renderResultsVisibilityControls(hiddenJobsCount) {
  if (!resultsVisibilityControlsNode) {
    return;
  }

  if (hiddenJobsCount <= 0) {
    resultsVisibilityControlsNode.hidden = true;
    resultsVisibilityControlsNode.innerHTML = "";
    return;
  }

  const postLabel = hiddenJobsCount === 1 ? "post" : "posts";

  resultsVisibilityControlsNode.hidden = false;
  resultsVisibilityControlsNode.innerHTML = `
    <button id="showHiddenPostsButton" type="button" class="results-visibility-button">
      ${escapeHtml(`Show ${hiddenJobsCount} hidden ${postLabel}`)}
    </button>
  `;
}

function buildHidePostKey(job) {
  const canonicalJobId = extractCanonicalHideJobId(job);
  if (canonicalJobId) {
    return [
      String(job.sourceKey || "").toLowerCase(),
      String(job.company || "").toLowerCase(),
      canonicalJobId.toLowerCase(),
    ].join("|");
  }
  return job.trackerKey || buildTrackerKey(job);
}

function extractCanonicalHideJobId(job = {}) {
  const directCandidates = [
    job.jobId,
    job.externalId,
    job.id,
    job.applyUrl,
  ];

  for (const candidate of directCandidates) {
    const match = String(candidate || "").match(/\b([A-Za-z]+-\d+(?:-\d+)?)\b/);
    if (!match?.[1]) {
      continue;
    }
    const normalized = match[1].toUpperCase();
    const familyMatch = normalized.match(/^([A-Z]+-\d+)(?:-\d+)?$/);
    return familyMatch?.[1] || normalized;
  }

  return "";
}

function loadHiddenPostKeys() {
  try {
    const raw = localStorage.getItem(HIDDEN_POSTS_STORAGE_KEY);
    const parsed = JSON.parse(raw || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map((value) => String(value || "")).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function persistHiddenPostKeys(keys) {
  try {
    localStorage.setItem(HIDDEN_POSTS_STORAGE_KEY, JSON.stringify([...keys].sort()));
  } catch {
    // Ignore storage failures and keep the live page usable.
  }
}

function loadShowHiddenPostsPreference() {
  return false;
}

function persistShowHiddenPostsPreference(value) {
  void value;
}

function rerenderCurrentResults() {
  if (latestRenderedSearchState?.payload && Array.isArray(latestRenderedSearchState.payload.jobs)) {
    const snapshot = cloneSearchState(latestRenderedSearchState);
    if (snapshot?.payload && Array.isArray(snapshot.payload.jobs)) {
      renderResults(snapshot.payload, snapshot.filters || {}, snapshot.locationMode || getLocationMode());
      setStatus("Complete");
      return;
    }
  }

  restorePersistedSearchState();
}

function cloneSearchState(state) {
  if (!state) {
    return null;
  }

  if (typeof structuredClone === "function") {
    try {
      return structuredClone(state);
    } catch {
      // Fall through to JSON clone.
    }
  }

  try {
    return JSON.parse(JSON.stringify(state));
  } catch {
    return null;
  }
}

async function refreshTrackedApplications() {
  if (trackedApplicationsRefreshPromise) {
    return trackedApplicationsRefreshPromise;
  }

  trackedApplicationsRefreshPromise = (async () => {
    try {
      const response = await fetch("/api/applications", { signal: AbortSignal.timeout(TRACKER_REFRESH_TIMEOUT_MS) });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Unable to load tracker");
      }

      trackedApplications = Array.isArray(payload.applications) ? payload.applications : [];
      syncRenderedJobTrackingState();
      renderTrackerSummary(payload.paths);
    } catch {
      syncRenderedJobTrackingState();
    } finally {
      trackedApplicationsRefreshPromise = null;
    }
  })();

  try {
    await trackedApplicationsRefreshPromise;
  } catch {
    // Background tracker refresh failures should stay silent on the search page.
  }
}

function startSearchProgressPolling(searchRequestId) {
  stopSearchProgressPolling({ preserveSearchState: true });
  if (!searchRequestId) {
    return;
  }

  activeSearchLastServerProgressAt = 0;
  activeSearchTimelineTick = 0;
  activeSearchProgressRequestInFlight = false;
  pollSearchProgress(searchRequestId);
  activeSearchProgressTimer = window.setInterval(() => {
    activeSearchTimelineTick += 1;
    if (!activeSearchLastServerProgressAt || (Date.now() - activeSearchLastServerProgressAt) > SEARCH_PROGRESS_STALE_MS) {
      const fallbackProgress = buildFallbackProgress();
      updateLoadingUi(fallbackProgress);
    }
    pollSearchProgress(searchRequestId);
  }, SEARCH_PROGRESS_POLL_MS);
}

function stopSearchProgressPolling(options = {}) {
  if (activeSearchProgressTimer) {
    window.clearInterval(activeSearchProgressTimer);
    activeSearchProgressTimer = null;
  }
  if (!options.preserveSearchState) {
    activeSearchRequestId = "";
    activeSearchStartedAt = 0;
  }
  activeSearchLastServerProgressAt = 0;
  activeSearchTimelineTick = 0;
  activeSearchProgressRequestInFlight = false;
}

async function pollSearchProgress(searchRequestId) {
  if (!searchRequestId || activeSearchRequestId !== searchRequestId) {
    return;
  }

  if (activeSearchProgressRequestInFlight) {
    return;
  }

  activeSearchProgressRequestInFlight = true;

  try {
    const response = await fetch(`/api/search/status?id=${encodeURIComponent(searchRequestId)}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    if (activeSearchRequestId !== searchRequestId) {
      return;
    }

    activeSearchLastServerProgressAt = Date.now();
    updateLoadingUi(payload);
  } catch {
    if (!activeSearchLastServerProgressAt || (Date.now() - activeSearchLastServerProgressAt) > SEARCH_PROGRESS_STALE_MS) {
      const fallbackProgress = buildFallbackProgress();
      updateLoadingUi(fallbackProgress);
    }
  } finally {
    activeSearchProgressRequestInFlight = false;
  }
}

function updateLoadingUi(progress = {}) {
  if (!activeSearchRequestId) {
    return;
  }
  const displayProgress = enrichLoadingProgress(progress);
  resultsCountNode.textContent = buildLoadingCountText(displayProgress);
  resultsNode.innerHTML = renderLoadingStateMarkup(displayProgress);
  setStatus(buildLoadingStatusText(displayProgress), true);
}

function buildLoadingCountText(progress = {}) {
  if (Number.isFinite(progress.totalSources) && progress.totalSources > 0) {
    const completed = Number(progress.completedSources || 0);
    return `Searching ${completed} of ${progress.totalSources} sources...`;
  }

  return "Searching configured sources...";
}

function buildLoadingStatusText(progress = {}) {
  if (progress.timelineKey === "cards") {
    return "Creating cards";
  }

  if (["sorting", "descriptions"].includes(String(progress.timelineKey || ""))) {
    return "Finishing up";
  }

  switch (progress.stage) {
    case "loading_sources":
      return "Checking sources";
    case "filtering":
      return "Finishing up";
    case "completed":
      return "Complete";
    case "error":
      return "Error";
    default:
      return "Searching";
  }
}

function buildProgressLabel(progress = {}) {
  const completed = Number(progress.completedSources || 0);
  const total = Number(progress.totalSources || 0);
  const cached = Number(progress.cachedSources || 0);
  const live = Number(progress.liveSources || 0);
  const fallback = Number(progress.fallbackSources || 0);
  const elapsedSeconds = Math.max(1, Math.round(getSearchElapsedMs(progress) / 1000));

  if (total > 0) {
    const parts = [`${completed} of ${total} sources checked`];
    if (cached > 0) {
      parts.push(`${cached} cache`);
    }
    if (live > 0) {
      parts.push(`${live} live`);
    }
    if (fallback > 0) {
      parts.push(`${fallback} fallback`);
    }
    if (progress.failedSources > 0) {
      parts.push(`${progress.failedSources} slow or failed`);
    }
    parts.push(`${elapsedSeconds}s elapsed`);
    return parts.join(" • ");
  }

  return elapsedSeconds > 0 ? `${elapsedSeconds}s elapsed` : "Preparing search";
}

function buildFallbackProgress() {
  const elapsedMs = getSearchElapsedMs();
  const elapsedSeconds = Math.max(1, Math.round(elapsedMs / 1000));

  if (elapsedMs > 90000) {
    return {
      stage: "filtering",
      message: "Finishing the last cleanup steps",
      detail: "Most source checks are done. JobTrawl is filtering, deduplicating, and sorting the final results now.",
      percent: 97,
      elapsedSeconds,
    };
  }
  if (elapsedMs > 75000) {
    return {
      stage: "filtering",
      message: "Almost there",
      detail: "The slower employer boards are wrapping up, and the final cleanup pass is close behind.",
      percent: 94,
      elapsedSeconds,
    };
  }
  if (elapsedMs > 50000) {
    return {
      stage: "loading_sources",
      message: "Still waiting on the slowest job boards",
      detail: "Most sources should already be done. A smaller group of slower ATS or career pages is still finishing.",
      percent: 86,
      elapsedSeconds,
    };
  }
  if (elapsedMs > 35000) {
    return {
      stage: "loading_sources",
      message: "Checking live ATS feeds and career pages",
      detail: "Some employer boards respond quickly, and others take longer. JobTrawl is still working through the slower ones.",
      percent: 74,
      elapsedSeconds,
    };
  }
  if (elapsedMs > 15000) {
    return {
      stage: "loading_sources",
      message: "Mixing cached matches with fresh source checks",
      detail: "JobTrawl is pulling quick results from cache first and then filling in fresher data from live job boards.",
      percent: 58,
      elapsedSeconds,
    };
  }
  return {
    stage: "loading_sources",
    message: "Checking cache and loading sources",
    detail: "JobTrawl is building the source list, checking cache, and starting the first live board requests now.",
    percent: 42,
    elapsedSeconds,
  };
}

function enrichLoadingProgress(progress = {}) {
  const elapsedMs = getSearchElapsedMs(progress);
  const timelinePhase = buildTimelineLoadingPhase(elapsedMs, progress, activeSearchTimelineTick);
  const completed = Number(progress.completedSources || 0);
  const total = Number(progress.totalSources || 0);
  const hasRealSourceProgress = total > 0 && completed > 0;
  const incomingPercent = Number(progress.percent);
  const timelinePercent = Number(timelinePhase.percent || 0);

  return {
    ...progress,
    message: timelinePhase.totalSteps
      ? `Step ${timelinePhase.step} of ${timelinePhase.totalSteps}: ${timelinePhase.message || progress.message || "Searching"}`
      : (timelinePhase.message || progress.message),
    detail: timelinePhase.detail || progress.detail,
    percent: Number.isFinite(incomingPercent)
      ? Math.max(incomingPercent, timelinePercent)
      : timelinePercent,
    timelineStep: timelinePhase.step,
    timelineTotalSteps: timelinePhase.totalSteps,
    timelineKey: timelinePhase.key,
    sourceProgressKnown: hasRealSourceProgress,
  };
}

function buildTimelineLoadingPhase(elapsedMs = 0, progress = {}, timelineTick = 0) {
  const stage = progress.stage || "loading_sources";
  const phases = stage === "filtering"
    ? [
        {
          key: "cache",
          message: "Checking cache",
          detail: "Reusing fast local matches before the app reaches out to live job boards.",
          minElapsedMs: 0,
          percent: 92,
        },
        {
          key: "locations",
          message: "Searching locations",
          detail: "Applying your location and filter choices to the jobs that have been found.",
          minElapsedMs: 500,
          percent: 93,
        },
        {
          key: "sources",
          message: "Loading sources",
          detail: "Pulling ATS and career-page results into one shared list.",
          minElapsedMs: 1000,
          percent: 94,
        },
        {
          key: "sorting",
          message: "Sorting job titles and removing duplicates",
          detail: "The combined results are being cleaned up so repeated listings and stale duplicates don't crowd the page.",
          minElapsedMs: 1500,
          percent: 95,
        },
        {
          key: "descriptions",
          message: "Grabbing job descriptions",
          detail: "Keeping the role details that are useful for the result cards.",
          minElapsedMs: 2000,
          percent: 97,
        },
        {
          key: "cards",
          message: "Creating result cards",
          detail: "The final matches are being organized into cards so they're ready to show in the results list.",
          minElapsedMs: 2600,
          percent: 98,
        },
      ]
    : [
        {
          key: "cache",
          message: "Checking cache",
          detail: "JobTrawl is checking local cache first so it can reuse fast matches before it reaches out to live job boards.",
          minElapsedMs: 0,
          percent: 16,
        },
        {
          key: "locations",
          message: "Searching locations",
          detail: "Your keyword, location, and work-arrangement choices are being prepared for the source adapters.",
          minElapsedMs: 1200,
          percent: 24,
        },
        {
          key: "sources",
          message: "Loading sources",
          detail: "JobTrawl is loading the selected ATS feeds and employer career pages that match this search.",
          minElapsedMs: 2400,
          percent: 34,
        },
        {
          key: "sorting",
          message: "Sorting job titles",
          detail: "The search is lining up title matches while slower employer boards keep loading in the background.",
          minElapsedMs: 4200,
          percent: 48,
        },
        {
          key: "descriptions",
          message: "Grabbing job descriptions",
          detail: "JobTrawl is pulling title, location, arrangement, and description details from the job boards that have responded.",
          minElapsedMs: 6000,
          percent: 61,
        },
        {
          key: "cards",
          message: "Creating cards",
          detail: "The final matches are being organized into result cards while the remaining cleanup finishes.",
          minElapsedMs: 7800,
          percent: 74,
        },
      ];

  const steppedIndex = Math.min(phases.length - 1, Math.max(0, Math.floor(Number(timelineTick || 0) / 2)));
  const elapsedIndex = phases.reduce((currentIndex, phase, index) => (
    elapsedMs >= phase.minElapsedMs ? index : currentIndex
  ), 0);
  const completed = Number(progress.completedSources || 0);
  const total = Number(progress.totalSources || 0);
  const ratioIndex = total > 0
    ? Math.min(phases.length - 1, Math.floor((completed / Math.max(1, total)) * phases.length))
    : 0;
  const selectedIndex = Math.max(steppedIndex, elapsedIndex, ratioIndex);
  const selectedPhase = phases[selectedIndex] || phases[0];
  const phaseStartMs = selectedPhase.minElapsedMs || 0;
  const nextPhase = phases[selectedIndex + 1] || null;
  const phaseEndMs = nextPhase?.minElapsedMs || phaseStartMs + 6000;
  const phaseDurationMs = Math.max(1200, phaseEndMs - phaseStartMs);
  const phaseElapsedMs = Math.max(0, elapsedMs - phaseStartMs);
  const easedPhaseProgress = Math.min(1, phaseElapsedMs / phaseDurationMs);
  const previousPercent = selectedIndex > 0 ? Number(phases[selectedIndex - 1]?.percent || 0) : 0;
  const nextPercent = Number(selectedPhase.percent || previousPercent);
  const animatedPercent = Math.round(previousPercent + ((nextPercent - previousPercent) * easedPhaseProgress));

  return {
    ...selectedPhase,
    percent: Math.max(previousPercent, animatedPercent),
    step: selectedIndex + 1,
    totalSteps: phases.length,
  };
}

function getSearchElapsedMs(progress = {}) {
  if (activeSearchStartedAt) {
    return Math.max(0, Date.now() - activeSearchStartedAt);
  }

  const startedAt = String(progress.startedAt || "").trim();
  if (!startedAt) {
    return 0;
  }

  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Date.now() - parsed);
}

function clampProgressPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

async function runFinalLoadingSequence(payload = {}) {
  if (!activeSearchRequestId) {
    return;
  }

  const finalStates = [
    {
      stage: "filtering",
      message: "Filtering, deduplicating, and sorting matches",
      detail: "JobTrawl is cleaning up the combined matches before showing the final cards.",
      percent: 92,
      timelineKey: "sorting",
      timelineStep: 4,
    },
    {
      stage: "filtering",
      message: "Grabbing job descriptions",
      detail: "The role details are being finalized so the visible cards have the richest descriptions available.",
      percent: 97,
      timelineKey: "descriptions",
      timelineStep: 5,
    },
    {
      stage: "filtering",
      message: payload.jobs?.length
        ? `Creating ${payload.jobs.length} result card${payload.jobs.length === 1 ? "" : "s"}`
        : "Creating result cards",
      detail: "The final result cards are being prepared for display.",
      percent: 100,
      timelineKey: "cards",
      timelineStep: 6,
    },
  ];

  for (const state of finalStates) {
    updateLoadingUi(state);
    await delay(220);
  }
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function createSearchRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `search-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function filterCheckboxGroup(node, query) {
  const normalizedQuery = normalizeSearchText(query);
  [...node.querySelectorAll(".checkbox-item")].forEach((item) => {
    const label = normalizeSearchText(item.textContent);
    item.hidden = Boolean(normalizedQuery) && !label.includes(normalizedQuery);
  });
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

function buildDescriptionPreview(job) {
  const roleSearchText = extractRoleDescription(job.searchText);
  if (!roleSearchText) {
    const roleSnippet = extractRoleDescription(job.descriptionSnippet);
    if (!roleSnippet) {
      return "";
    }
    return trimPreview(roleSnippet, 1800);
  }

  const title = normalizePreviewText(job.title);
  let preview = roleSearchText;
  if (title && preview.toLowerCase().startsWith(title.toLowerCase())) {
    preview = preview.slice(title.length).trim();
  }

  return trimPreview(preview, 1800);
}

function buildDescriptionSnapshot(job) {
  const roleSearchText = extractRoleDescription(job.searchText);
  if (roleSearchText) {
    const title = normalizePreviewText(job.title);
    let snapshot = roleSearchText;
    if (title && snapshot.toLowerCase().startsWith(title.toLowerCase())) {
      snapshot = snapshot.slice(title.length).trim();
    }
    return snapshot;
  }

  const roleSnippet = extractRoleDescription(job.descriptionSnippet);
  if (roleSnippet) {
    return roleSnippet;
  }

  return normalizePreviewText(job.searchText || job.descriptionSnippet || "");
}

function normalizePreviewText(value) {
  return decodeHtmlEntities(String(value || "")).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, "-")
    .replace(/&mdash;|&#8212;/gi, "-")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => {
      const numeric = Number(code);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const numeric = Number.parseInt(code, 16);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _;
    });
}

function extractRoleDescription(value) {
  const text = normalizePreviewText(value);
  if (!text) {
    return "";
  }

  const preferredHeadings = [
    "about the role:",
    "about the role",
    "overview:",
    "overview",
    "about this role",
    "in this role:",
    "in this role",
    "role overview",
    "position overview",
    "job summary",
    "position summary",
    "role responsibilities:",
    "role responsibilities",
    "the role",
    "the opportunity",
    "what you'll do",
    "what you will do",
    "what you'll be doing",
    "what you get to do",
    "what you'll work on",
    "day to day",
    "responsibilities",
    "key responsibilities",
  ];
  const stopHeadings = [
    "about the company",
    "about us",
    "who we are",
    "what we do",
    "our mission",
    "company overview",
    "why join",
    "benefits",
    "compensation",
    "pay range",
    "salary range",
    "qualifications",
    "what you'll bring",
    "requirements",
    "equal opportunity",
    "eeo",
    "privacy",
    "accommodation",
  ];

  const lowerText = text.toLowerCase();
  let startIndex = -1;
  let selectedHeading = "";
  for (const heading of preferredHeadings) {
    const index = lowerText.indexOf(heading);
    if (index !== -1 && (startIndex === -1 || index < startIndex)) {
      startIndex = index;
      selectedHeading = heading;
    }
  }

  let candidate = text;
  if (startIndex !== -1) {
    candidate = text.slice(startIndex + selectedHeading.length).replace(/^[:\s.-]+/, "").trim();
  }

  if (startIndex === -1 && looksLikeCompanyBoilerplate(text)) {
    return "";
  }

  const lowerCandidate = candidate.toLowerCase();
  let stopIndex = -1;
  for (const heading of stopHeadings) {
    const index = lowerCandidate.indexOf(heading);
    if (index > 80 && (stopIndex === -1 || index < stopIndex)) {
      stopIndex = index;
    }
  }

  if (stopIndex !== -1) {
    candidate = candidate.slice(0, stopIndex).trim();
  }

  return stripLeadingDescriptionPunctuation(candidate || text);
}

function stripLeadingDescriptionPunctuation(value) {
  return normalizePreviewText(value).replace(/^[,\s;:.!/-]+/, "").trim();
}

function looksLikeCompanyBoilerplate(text) {
  const normalized = normalizePreviewText(text).toLowerCase();
  if (!normalized) {
    return false;
  }

  const boilerplateStarts = [
    "who we are",
    "about us",
    "about the company",
    "what we do",
    "our mission",
    "company overview",
  ];
  const roleSignals = [
    "about the role:",
    "about the role",
    "about this role",
    "overview:",
    "overview",
    "in this role:",
    "in this role",
    "what you'll do",
    "what you will do",
    "responsibilities",
    "role responsibilities",
    "job summary",
    "position summary",
    "the role",
    "the opportunity",
  ];

  const startsWithBoilerplate = boilerplateStarts.some((prefix) => normalized.startsWith(prefix));
  if (!startsWithBoilerplate) {
    return false;
  }

  return !roleSignals.some((signal) => normalized.includes(signal));
}

function trimPreview(value, maxLength = 1800) {
  const text = normalizePreviewText(value);
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()}...`;
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
  const broaderSentenceMatch = normalized.match(/(?:compensation(?:\s+and\s+benefits)?|salary|base\s+salary|base\s+pay|pay|pay\s+for\s+this\s+role|salary\s+for\s+this\s+role|salary\s+for\s+this\s+position|compensation\s+for\s+this\s+role|compensation\s+for\s+this\s+position)[^.;|]{0,160}?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?(?:[^.;|]{0,80}?(?:-|to)\s*(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)?\s?\d[\d,]*(?:\.\d{2})?)?[^.;|]{0,40}(?:annual|yearly|per year|yr|hourly|per hour|hour)?/i);
  if (broaderSentenceMatch) {
    return cleanCompensationText(broaderSentenceMatch[0]);
  }

  const usdLabeledRangeMatch = normalized.match(/(?:us\s+salary\s+range|salary\s+range|pay\s+range|base\s+pay\s+range|cash\s+range)[:\s-]*\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:-|to)\s*\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:usd|cad|eur|gbp|aud|nzd|jpy)?/i);
  if (usdLabeledRangeMatch) {
    return cleanCompensationText(usdLabeledRangeMatch[0]);
  }

  const sentenceRangeMatch = normalized.match(/(?:total\s+cash\s+range|cash\s+range|pay\s+range|salary\s+range|base\s+pay(?:\s+range)?)[^.$]{0,80}?\bis\s+(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?\s*(?:-|to)\s*(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)?\s?\d[\d,]*(?:\.\d{2})?/i);
  if (sentenceRangeMatch) {
    return cleanCompensationText(sentenceRangeMatch[0]);
  }

  const labeledRangeMatch = normalized.match(/(?:(?:base\s+)?pay\s+range|salary\s+range|compensation(?:\s+and\s+benefits)?|base\s+pay|salary)[:\s-]*(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)[^.;|]{0,80}/i);
  if (labeledRangeMatch) {
    const candidate = cleanCompensationText(labeledRangeMatch[0]);
    if (containsCurrencyMarker(candidate)) {
      return candidate;
    }
  }

  const currencyRangeMatch = normalized.match(/(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?\s*(?:-|to)\s*(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)?\s?\d[\d,]*(?:\.\d{2})?\s*(?:USD|CAD|EUR|GBP|AUD|NZD|JPY|annual|yearly|per year|yr|hourly|per hour|hour)?/i);
  if (currencyRangeMatch) {
    return cleanCompensationText(currencyRangeMatch[0]);
  }

  const usdRangeMatch = normalized.match(/(?:us\s+salary\s+range|salary\s+range|pay\s+range)[:\s-]*\$\s?\d[\d,]*(?:\.\d{2})?\s*-\s*\$\s?\d[\d,]*(?:\.\d{2})?\s*usd/i);
  if (usdRangeMatch) {
    return cleanCompensationText(usdRangeMatch[0]);
  }

  const annualRangeMatch = normalized.match(/\$\s?\d[\d,]*(?:\.\d{2})?\s*-\s*\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:annual|yearly|per year|yr)/i);
  if (annualRangeMatch) {
    return cleanCompensationText(annualRangeMatch[0]);
  }

  const hourlyRangeMatch = normalized.match(/\$\s?\d[\d,]*(?:\.\d{2})?\s*-\s*\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:hourly|per hour|hour)/i);
  if (hourlyRangeMatch) {
    return cleanCompensationText(hourlyRangeMatch[0]);
  }

  const annualSingleMatch = normalized.match(/\$\s?\d[\d,]*(?:\.\d{2})?\s*(?:annual|yearly|per year|yr)/i);
  if (annualSingleMatch) {
    return cleanCompensationText(annualSingleMatch[0]);
  }

  const salaryLabelMatch = normalized.match(/(?:(?:base\s+)?pay\s+range|salary\s+range|compensation|base\s+pay)[:\s-]{0,8}(.{0,140}?)(?:benefits|location|responsibilities|qualifications|requirements|about us|$)/i);
  if (salaryLabelMatch?.[1]) {
    const candidate = cleanCompensationText(salaryLabelMatch[1]);
    if (containsCurrencyMarker(candidate)) {
      return candidate;
    }
  }

  return "";
}

function extractJobIdentifier(job = {}) {
  const explicitId = firstMeaningfulJobId(job.jobId, job.externalId, job.id);
  if (explicitId) {
    return explicitId;
  }

  const applyUrl = String(job.applyUrl || "").trim();
  const urlId = extractJobIdFromUrl(applyUrl);
  if (urlId) {
    return urlId;
  }

  const searchPool = [
    job.searchText,
    job.descriptionSnippet,
    job.title,
  ]
    .map((value) => normalizePreviewText(value))
    .filter(Boolean)
    .join(" \n ");

  return extractJobIdFromText(searchPool) || String(job.sourceKey || "").trim();
}

function firstMeaningfulJobId(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || /^https?:/i.test(normalized) || normalized === "undefined" || normalized === "null") {
      continue;
    }

    if (/^[A-Za-z]+-\d+(?:-\d+)?$/.test(normalized) || /^\d{5,}$/.test(normalized)) {
      return normalized;
    }
  }

  return "";
}

function extractJobIdFromUrl(urlValue) {
  if (!urlValue) {
    return "";
  }

  try {
    const url = new URL(urlValue);
    const queryCandidates = [
      url.searchParams.get("gh_jid"),
      url.searchParams.get("jobId"),
      url.searchParams.get("jobid"),
      url.searchParams.get("reqId"),
      url.searchParams.get("requisitionId"),
      url.searchParams.get("jid"),
      url.searchParams.get("job"),
    ];
    const queryId = firstMeaningfulJobId(...queryCandidates);
    if (queryId) {
      return queryId;
    }

    const pathMatches = [
      url.pathname.match(/\/(R-\d+(?:-\d+)?)\/?$/i),
      url.pathname.match(/\/jobs\/(\d{5,})\/?$/i),
      url.pathname.match(/\/job\/[^/]+\/[^/]+\/([A-Za-z]-?\d+(?:-\d+)?)\/?$/i),
    ];
    for (const match of pathMatches) {
      if (match?.[1]) {
        return match[1];
      }
    }
  } catch {
    return "";
  }

  return "";
}

function extractJobIdFromText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const matches = [
    normalized.match(/\b(?:job\s*id|id\s*#|req(?:uisition)?\s*id)\s*[:#-]?\s*([A-Za-z]-?\d+(?:-\d+)?|\d{5,})\b/i),
    normalized.match(/\b(R-\d+(?:-\d+)?)\b/i),
  ];

  for (const match of matches) {
    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}

function containsCurrencyMarker(value) {
  const text = String(value || "");
  return /[$€£¥]|(?:\bUSD\b|\bCAD\b|\bEUR\b|\bGBP\b|\bAUD\b|\bNZD\b|\bJPY\b)/i.test(text);
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

  const rangeMatch = text.match(/(?:total\s+cash\s+range\s+for\s+this\s+position\s+in\s+[A-Za-z .-]+\s+is\s+)?(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)\s?\d[\d,]*(?:\.\d{2})?\s*(?:-|to)\s*(?:[A-Z]{2,3}\s+)?(?:\$|USD|CAD|EUR|GBP|AUD|NZD|JPY)?\s?\d[\d,]*(?:\.\d{2})?\s*(?:USD|CAD|EUR|GBP|AUD|NZD|JPY|annual|yearly|per year|yr|hourly|per hour|hour)?/i);
  if (rangeMatch) {
    return rangeMatch[0].replace(/\s+/g, " ").trim();
  }

  return text.trim();
}

async function handleResultsSave(job, trackInput, toggle) {
  trackInput.disabled = true;
  toggle?.classList.add("saving");

  try {
    const response = await fetch("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildTrackedApplicationPayload(job)),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to save application");
    }

    await refreshTrackedApplications();
    updateTrackToggleUi(toggle, true, payload.created ? "Saved to application tracker sheet" : "Already in application tracker sheet");
    if (payload.listingSnapshot?.ok === false) {
      window.alert(`Application saved, but the listing PDF could not be captured.\n\nReason: ${payload.listingSnapshot.error || "Unknown error"}`);
    }
  } catch (error) {
    trackInput.checked = false;
    trackInput.disabled = false;
    toggle?.classList.remove("saving");
    window.alert(error.message || "Unable to save application");
  }
}

async function handleResultsUnsave(job, trackInput, toggle) {
  const trackedApplication = findTrackedApplication(job);
  if (!trackedApplication?.id) {
    updateTrackToggleUi(toggle, false, "Save to application tracker sheet");
    return;
  }

  trackInput.disabled = true;
  toggle?.classList.add("saving");

  try {
    const response = await fetch(`/api/applications/${encodeURIComponent(trackedApplication.id)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to remove application");
    }

    await refreshTrackedApplications();
    updateTrackToggleUi(toggle, false, "Save to application tracker sheet");
  } catch (error) {
    trackInput.checked = true;
    trackInput.disabled = false;
    toggle?.classList.remove("saving");
    window.alert(error.message || "Unable to remove application");
  }
}

function updateTrackToggleUi(toggle, isSaved, text) {
  if (!toggle) {
    return;
  }

  toggle.classList.remove("saving");
  toggle.classList.toggle("saved", isSaved);

  const input = toggle.querySelector(".track-application-input");
  if (input) {
    input.checked = isSaved;
    input.disabled = false;
  }

  const copyNode = toggle.querySelector(".track-save-copy");
  if (copyNode) {
    copyNode.textContent = text;
  }
}

async function handleWindowFocus() {
  await refreshTrackedApplications();
}

async function handleVisibilityChange() {
  if (document.visibilityState === "visible") {
    await refreshTrackedApplications();
  }
}

function syncRenderedJobTrackingState() {
  resultsNode.querySelectorAll(".track-application-input").forEach((input) => {
    const trackerKey = input.dataset.trackerKey || "";
    const job = renderedJobsByKey.get(trackerKey);
    if (!job) {
      return;
    }

    const tracked = isJobTracked(job);
    const toggle = input.closest(".track-save-toggle");
    updateTrackToggleUi(
      toggle,
      tracked,
      tracked ? "Saved to application tracker sheet" : "Save to application tracker sheet"
    );
  });
}

function formatCompanyLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const exactOverrides = new Map([
    ["openai", "OpenAI"],
    ["xai", "xAI"],
    ["ibm", "IBM"],
    ["f5", "F5"],
    ["t-mobile", "T-Mobile"],
    ["uw medicine", "UW Medicine"],
    ["sap concur", "SAP Concur"],
    ["ansible government solutions", "Ansible Government Solutions"],
  ]);

  const normalized = raw.toLowerCase();
  if (exactOverrides.has(normalized)) {
    return exactOverrides.get(normalized);
  }

  if (/[A-Z]/.test(raw.slice(1))) {
    return raw;
  }

  return raw
    .split(/\s+/)
    .map((word) => word
      .split("-")
      .map((segment) => formatCompanySegment(segment))
      .join("-"))
    .join(" ");
}

function formatCompanySegment(segment) {
  const raw = String(segment || "");
  if (!raw) {
    return "";
  }

  if (/^[A-Z0-9&/]+$/.test(raw)) {
    return raw;
  }

  const tokenOverrides = new Map([
    ["ai", "AI"],
    ["hr", "HR"],
    ["it", "IT"],
    ["ml", "ML"],
    ["qa", "QA"],
    ["ux", "UX"],
    ["ui", "UI"],
    ["aws", "AWS"],
    ["ukg", "UKG"],
  ]);

  const normalized = raw.toLowerCase();
  if (tokenOverrides.has(normalized)) {
    return tokenOverrides.get(normalized);
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLowerCase();
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



