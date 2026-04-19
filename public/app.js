const form = document.querySelector("#search-form");
const resultsNode = document.querySelector("#results");
const summaryNode = document.querySelector("#summary");
const sourceHealthNode = document.querySelector("#source-health");
const resultsCountNode = document.querySelector("#results-count");
const statusPillNode = document.querySelector("#status-pill");
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
const SEARCH_REQUEST_TIMEOUT_MS = 120000;
const SEARCH_PROGRESS_POLL_MS = 900;
const SEARCH_PROGRESS_STALE_MS = 2800;

let bootstrapData = null;
let locationGroupCounter = 0;
let detectedLocation = null;
let geolocationRequested = false;
let activeSearchRequestId = "";
let activeSearchProgressTimer = null;
let activeSearchStartedAt = 0;
let activeSearchLastServerProgressAt = 0;
let activeSearchTimelineTick = 0;

bootstrap();
form.addEventListener("submit", handleSearch);
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
  } catch (error) {
    setStatus("Error");
    resultsCountNode.textContent = "Unable to load filters";
    resultsNode.className = "results-list empty-state";
    resultsNode.textContent = error.message || "Bootstrap request failed.";
  }
}

async function handleSearch(event) {
  event.preventDefault();
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

function handleExcludedCompaniesSearch(event) {
  filterCheckboxGroup(excludedCompaniesNode, event.currentTarget.value);
}

function handleIncludedCompaniesSearch(event) {
  filterCheckboxGroup(includedCompaniesNode, event.currentTarget.value);
}

function buildSourceSelectionPayload() {
  const sourceSelectionMode = enableSourceCustomizationNode.checked ? "custom" : "all";
  const sourceCustomizationMode = getSourceCustomizationMode();

  return {
    sourceSelectionMode,
    sourceCustomizationMode,
    selectedAtsProviderKeys: sourceSelectionMode === "custom" && sourceCustomizationMode === "ats" ? getCheckedValues(atsSourceKeysNode) : [],
    includedCompanies: sourceSelectionMode === "custom" && sourceCustomizationMode === "companies" ? getCheckedValues(includedCompaniesNode) : [],
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
  const usLocationUnknownJobs = payload.jobs.filter((job) => job.usLocationUnknown);
  const jobsWithKnownUsLocation = payload.jobs.filter((job) => !job.usLocationUnknown);
  const unknownArrangementJobs = jobsWithKnownUsLocation.filter((job) => job.arrangementUnknown);
  const primaryJobs = jobsWithKnownUsLocation.filter((job) => !job.arrangementUnknown);
  const datedJobs = primaryJobs.filter((job) => job.postedAt || job.updatedAt);
  const unknownDateJobs = primaryJobs.filter((job) => !job.postedAt && !job.updatedAt);
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
  const arrangementValue = job.workArrangement || "unknown";
  const arrangementLabel = titleCase(arrangementValue);
  const descriptionPreview = buildDescriptionPreview(job);
  const distancePill = Number.isFinite(job.distanceMiles)
    ? `<span class="pill">${escapeHtml(`${job.distanceMiles.toFixed(1)} miles away`)}</span>`
    : "";
  const usUnknownPill = job.usLocationUnknown
    ? '<span class="pill">U.S. match unknown</span>'
    : "";

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
        <span class="pill">${escapeHtml(job.locationLabel || "Unspecified")}</span>
        ${job.team ? `<span class="pill">${escapeHtml(job.team)}</span>` : ""}
        ${distancePill}
        ${usUnknownPill}
      </div>
      <div class="job-meta">
        <div>${escapeHtml(dateLine)}</div>
        <div>Source key: ${escapeHtml(job.sourceKey)}</div>
        ${descriptionPreview ? `
          <div class="job-snippet-block">
            <div class="job-snippet-label">Job description</div>
            <div class="job-snippet">${escapeHtml(descriptionPreview)}</div>
          </div>
        ` : ""}
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

function startSearchProgressPolling(searchRequestId) {
  stopSearchProgressPolling();
  if (!searchRequestId) {
    return;
  }

  activeSearchLastServerProgressAt = 0;
  activeSearchTimelineTick = 0;
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

function stopSearchProgressPolling() {
  if (activeSearchProgressTimer) {
    window.clearInterval(activeSearchProgressTimer);
    activeSearchProgressTimer = null;
  }
  activeSearchRequestId = "";
  activeSearchStartedAt = 0;
  activeSearchLastServerProgressAt = 0;
  activeSearchTimelineTick = 0;
}

async function pollSearchProgress(searchRequestId) {
  if (!searchRequestId || activeSearchRequestId !== searchRequestId) {
    return;
  }

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
  }
}

function updateLoadingUi(progress = {}) {
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
  const elapsedSeconds = activeSearchStartedAt ? Math.max(1, Math.round((Date.now() - activeSearchStartedAt) / 1000)) : 0;

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
  const elapsedMs = activeSearchStartedAt ? Date.now() - activeSearchStartedAt : 0;
  const elapsedSeconds = activeSearchStartedAt ? Math.max(1, Math.round(elapsedMs / 1000)) : 0;

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
  const elapsedMs = activeSearchStartedAt ? Date.now() - activeSearchStartedAt : 0;
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
          key: "filtering",
          message: "Filtering and matching job titles",
          detail: "JobTrawl is applying your keyword, date, and work-arrangement filters to the combined job list.",
          minElapsedMs: 0,
          percent: 93,
        },
        {
          key: "sorting",
          message: "Sorting job titles and removing duplicates",
          detail: "The combined results are being cleaned up so repeated listings and stale duplicates don't crowd the page.",
          minElapsedMs: 1400,
          percent: 96,
        },
        {
          key: "cards",
          message: "Creating result cards",
          detail: "The final matches are being organized into cards so they're ready to show in the results list.",
          minElapsedMs: 2800,
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
  const selectedPhase = phases[Math.max(steppedIndex, elapsedIndex)] || phases[0];

  return {
    ...selectedPhase,
    step: phases.indexOf(selectedPhase) + 1,
    totalSteps: phases.length,
  };
}

function clampProgressPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
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
    return trimPreview(roleSnippet, 900);
  }

  const title = normalizePreviewText(job.title);
  let preview = roleSearchText;
  if (title && preview.toLowerCase().startsWith(title.toLowerCase())) {
    preview = preview.slice(title.length).trim();
  }

  return trimPreview(preview, 900);
}

function normalizePreviewText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractRoleDescription(value) {
  const text = normalizePreviewText(value);
  if (!text) {
    return "";
  }

  const preferredHeadings = [
    "about the role",
    "about this role",
    "role overview",
    "position overview",
    "job summary",
    "position summary",
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

  return candidate || text;
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
    "about the role",
    "about this role",
    "what you'll do",
    "what you will do",
    "responsibilities",
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

function trimPreview(value, maxLength = 900) {
  const text = normalizePreviewText(value);
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()}...`;
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



