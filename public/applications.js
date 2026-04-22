const trackerCountNode = document.querySelector("#tracker-count");
const trackerRowsNode = document.querySelector("#tracker-rows");
const trackerTableNode = document.querySelector("#tracker-table");
const trackerEmptyNode = document.querySelector("#tracker-empty");
const trackerStatsNode = document.querySelector("#tracker-stats");
const trackerStorageNode = document.querySelector("#tracker-storage");
const addApplicationButton = document.querySelector("#add-application-button");
const openCsvButton = document.querySelector("#open-csv-button");
const backButtonNode = document.querySelector(".tracker-back-button");

let applicationStatuses = [];
let applications = [];
let trackerPaths = {};

bootstrap().catch((error) => {
  trackerEmptyNode.hidden = false;
  trackerEmptyNode.textContent = error.message || "Unable to load the application tracker.";
});
addApplicationButton.addEventListener("click", handleAddApplication);
openCsvButton?.addEventListener("click", handleOpenCsvFile);
backButtonNode?.addEventListener("click", handleBackToSearch);
trackerRowsNode.addEventListener("change", handleTableChange);
trackerRowsNode.addEventListener("click", handleTableClick);

async function bootstrap() {
  await loadApplications();
}

async function loadApplications() {
  const response = await fetch("/api/applications", { signal: AbortSignal.timeout(20000) });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Unable to load applications");
  }

  applicationStatuses = Array.isArray(payload.statuses) ? payload.statuses : [];
  applications = Array.isArray(payload.applications) ? payload.applications : [];
  trackerPaths = payload.paths || {};
  renderTracker(payload.paths);
}

function renderTracker(paths = trackerPaths) {
  const orderedApplications = sortApplicationsForDisplay(applications);

  trackerCountNode.textContent = `${orderedApplications.length} tracked application${orderedApplications.length === 1 ? "" : "s"}`;
  trackerTableNode.hidden = orderedApplications.length === 0;
  trackerEmptyNode.hidden = orderedApplications.length !== 0;

  const activeCount = orderedApplications.filter((item) => !["Rejected", "Job Offer"].includes(item.status)).length;
  const appliedStatuses = new Set([
    "Resume Submitted",
    "Resume Reviewed",
    "Recruiter Screening",
    "Interview 1",
    "Interview 2",
    "Interview 3",
    "Interview 4",
    "Interview 5",
    "Rejected",
    "Job Offer",
  ]);
  const appliedCount = orderedApplications.filter((item) => item.applyDate || appliedStatuses.has(item.status)).length;

  trackerStatsNode.innerHTML = `
    <div class="tracker-stat-card">
      <strong>${applications.length}</strong>
      <span>Total rows</span>
    </div>
    <div class="tracker-stat-card">
      <strong>${activeCount}</strong>
      <span>Active pipelines</span>
    </div>
    <div class="tracker-stat-card">
      <strong>${appliedCount}</strong>
      <span>Applied roles</span>
    </div>
  `;

  trackerStorageNode.textContent = paths?.xlsxPath
    ? `Saved locally to ${paths.xlsxPath}`
    : "";

  trackerRowsNode.innerHTML = orderedApplications.map(renderRow).join("");
  syncRenderedApplicationFields();
}

function renderRow(application) {
  return `
    <article class="tracker-record" data-application-id="${escapeAttribute(application.id)}">
      <div class="tracker-record-header">
        <div>
          <div class="tracker-record-title">${escapeHtml(application.company || "New application")}</div>
          <div class="tracker-record-meta">Last updated ${escapeHtml(formatDateTime(application.updatedAt)) || "just now"}</div>
        </div>
        <div class="tracker-row-actions">
          ${application.jobUrl ? `<a class="tracker-text-action tracker-text-action-open" href="${escapeAttribute(application.jobUrl)}" target="_blank" rel="noreferrer">Open listing</a>` : ""}
          <button type="button" class="tracker-text-action tracker-text-action-delete" data-action="delete">Delete</button>
        </div>
      </div>
      <div class="tracker-record-grid">
        ${renderField("Company", "company", "text", application.company)}
        ${renderField("Position", "position", "text", application.position)}
        ${renderField("Job ID#", "jobId", "text", application.jobId)}
        ${renderField("Job Listing - URL", "jobUrl", "url", application.jobUrl, "https://...")}
        ${renderDocumentField("pdf Copy of listing", application.pdfCopyOfListing, "Unable to save PDF")}
      </div>
      <div class="tracker-record-grid tracker-record-grid-secondary">
        ${renderField("Compensation", "compensation", "text", application.compensation)}
        ${renderUploadField("Resume Provided", "resumeProvided", application.resumeProvided)}
        ${renderUploadField("Cover Letter", "coverLetter", application.coverLetter)}
        ${renderField("Apply Date", "applyDate", "date", application.applyDate)}
        ${renderStatusField(application.status)}
      </div>
    </article>
  `;
}

function renderField(label, field, type, value, placeholder = "") {
  return `
    <label class="tracker-field">
      <span class="tracker-field-label">${escapeHtml(label)}</span>
      <input
        data-field="${escapeAttribute(field)}"
        type="${escapeAttribute(type)}"
        value="${escapeAttribute(value || "")}"
        ${placeholder ? `placeholder="${escapeAttribute(placeholder)}"` : ""}
      >
    </label>
  `;
}

function renderStatusField(value) {
  const currentValue = value || applicationStatuses[0] || "Saved";
  const options = applicationStatuses.map((status) => `
    <option value="${escapeAttribute(status)}" ${status === currentValue ? "selected" : ""}>${escapeHtml(status)}</option>
  `).join("");

  return `
    <label class="tracker-field tracker-status-field ${statusClassName(currentValue)}">
      <span class="tracker-field-label">Status</span>
      <select data-field="status">
        ${options}
      </select>
    </label>
  `;
}

function renderUploadField(label, field, value) {
  const filename = extractFilename(value);
  return `
    <label class="tracker-field">
      <span class="tracker-field-label">${escapeHtml(label)}</span>
      <span class="tracker-file-link-inline ${value ? "" : "tracker-file-link-inline-empty"}">
        ${value
          ? `<a class="tracker-file-link" href="${escapeAttribute(value)}" target="_blank" rel="noreferrer">${escapeHtml(filename || "Open saved file")}</a>`
          : "No file uploaded yet"}
      </span>
      <label class="tracker-upload-picker">
        <span>${value ? "Replace file" : "Choose file"}</span>
        <input
          data-upload-field="${escapeAttribute(field)}"
          type="file"
          accept=".pdf,.doc,.docx,.txt,.rtf"
        >
      </label>
    </label>
  `;
}

function renderDocumentField(label, value, emptyCopy) {
  const filename = extractFilename(value);
  return `
    <div class="tracker-field">
      <span class="tracker-field-label">${escapeHtml(label)}</span>
      <span class="tracker-upload-copy">
        ${value
          ? `<a href="${escapeAttribute(value)}" target="_blank" rel="noreferrer">${escapeHtml(filename || "Open saved PDF")}</a>`
          : `
            <span class="tracker-missing-file-note">
              ${escapeHtml(emptyCopy)}
              <span class="tracker-help-tooltip">
                <button type="button" class="tracker-help-button" aria-label="How to save the listing PDF yourself">?</button>
                <span class="tracker-help-bubble">
                  Open the job listing, use your browser Print menu, choose Save as PDF, then upload that file into pdf Copy of listing or keep it with your application files for reference.
                </span>
              </span>
            </span>
          `}
      </span>
    </div>
  `;
}

async function handleAddApplication() {
  addApplicationButton.disabled = true;
  addApplicationButton.textContent = "Adding...";

  try {
    const response = await fetch("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to add application");
    }

    await loadApplications();
  } catch (error) {
    window.alert(error.message || "Unable to add application");
  } finally {
    addApplicationButton.disabled = false;
    addApplicationButton.textContent = "Add blank row";
  }
}

function syncRenderedApplicationFields() {
  for (const application of applications) {
    const row = trackerRowsNode.querySelector(`[data-application-id="${escapeAttribute(application.id)}"]`);
    if (!row) {
      continue;
    }

    syncApplicationRow(row, application);
  }
}

function syncApplicationRow(row, application) {
  syncRowField(row, "company", application.company);
  syncRowField(row, "position", application.position);
  syncRowField(row, "jobId", application.jobId);
  syncRowField(row, "jobUrl", application.jobUrl);
  syncRowField(row, "compensation", application.compensation);
  syncRowField(row, "applyDate", application.applyDate);
  syncRowField(row, "status", application.status || applicationStatuses[0] || "Saved");

  const titleNode = row.querySelector(".tracker-record-title");
  if (titleNode) {
    titleNode.textContent = application.company || "New application";
  }

  const metaNode = row.querySelector(".tracker-record-meta");
  if (metaNode) {
    metaNode.textContent = `Last updated ${formatDateTime(application.updatedAt) || "just now"}`;
  }

  const statusField = row.querySelector(".tracker-status-field");
  if (statusField) {
    statusField.className = `tracker-field tracker-status-field ${statusClassName(application.status)}`;
  }
}

function syncRowField(row, field, value) {
  const input = row.querySelector(`[data-field="${field}"]`);
  if (!input) {
    return;
  }

  input.value = value || "";
}

async function handleOpenCsvFile() {
  if (!openCsvButton) {
    return;
  }

  openCsvButton.disabled = true;

  try {
    const response = await fetch("/api/applications/open-excel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Unable to open the Excel tracker");
      }

      const downloadUrl = String(payload.downloadUrl || "/api/applications/open.xlsx");
      const absoluteDownloadUrl = new URL(downloadUrl, window.location.origin).toString();
      if (downloadUrl) {
        window.location.href = `ms-excel:ofe|u|${absoluteDownloadUrl}`;
        return;
      }

      const localPath = String(payload.path || "").trim();
      if (localPath) {
        const fileUrl = `file:///${localPath.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1:")}`;
        const msExcelUrl = `ms-excel:ofe|u|${fileUrl}`;
        window.location.href = msExcelUrl;
        return;
      }

      throw new Error("Unable to locate the Excel tracker file");
    } catch (error) {
      window.alert(error.message || "Unable to open the Excel tracker");
    } finally {
    openCsvButton.disabled = false;
  }
}

function handleBackToSearch(event) {
  if (!backButtonNode) {
    return;
  }

  const previousUrl = document.referrer ? new URL(document.referrer, window.location.origin) : null;
  if (previousUrl?.origin === window.location.origin && window.history.length > 1) {
    event.preventDefault();
    window.history.back();
  }
}

async function handleTableChange(event) {
  const row = event.target.closest("[data-application-id]");
  if (!row) {
    return;
  }

  const applicationId = row.dataset.applicationId;
  const uploadField = event.target.dataset.uploadField;
  if (uploadField) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    await uploadApplicationFile(applicationId, uploadField, file);
    return;
  }

  const field = event.target.dataset.field;
  if (!field) {
    return;
  }

  const value = event.target.value;

  try {
    const response = await fetch(`/api/applications/${encodeURIComponent(applicationId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to save change");
      }

      applications = applications.map((application) => application.id === applicationId ? payload.application : application);
      renderTracker();
    } catch (error) {
      window.alert(error.message || "Unable to save change");
    }
  }

async function uploadApplicationFile(applicationId, field, file) {
  try {
    const contentBase64 = await readFileAsBase64(file);
    const response = await fetch(`/api/applications/${encodeURIComponent(applicationId)}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        field,
        filename: file.name,
        mimeType: file.type,
        contentBase64,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to upload file");
    }

    applications = applications.map((application) => application.id === applicationId ? payload.application : application);
    renderTracker();
  } catch (error) {
    window.alert(error.message || "Unable to upload file");
  }
}

async function handleTableClick(event) {
  const deleteButton = event.target.closest('[data-action="delete"]');
  if (!deleteButton) {
    return;
  }

  const row = deleteButton.closest("[data-application-id]");
  if (!row) {
    return;
  }

  const applicationId = row.dataset.applicationId;
  deleteButton.disabled = true;

  try {
    const response = await fetch(`/api/applications/${encodeURIComponent(applicationId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to delete application");
    }

    applications = applications.filter((application) => application.id !== applicationId);
    renderTracker();
  } catch (error) {
    window.alert(error.message || "Unable to delete application");
  }
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toLocaleString();
}

function sortApplicationsForDisplay(items) {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const rightTime = Date.parse(right?.updatedAt || right?.createdAt || 0);
    const leftTime = Date.parse(left?.updatedAt || left?.createdAt || 0);
    return rightTime - leftTime;
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",") ? result.split(",").pop() : result;
      resolve(base64 || "");
    };
    reader.onerror = () => reject(new Error("Unable to read file"));
    reader.readAsDataURL(file);
  });
}

function extractFilename(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }

  const parts = text.split("/");
  return decodeURIComponent(parts[parts.length - 1] || "");
}

function statusClassName(value) {
  return `status-${String(value || "saved").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "saved"}`;
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
