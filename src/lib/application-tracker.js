import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import ExcelJS from "exceljs";

const trackerDir = path.join(process.cwd(), "data");
const trackerJsonPath = path.join(trackerDir, "job-applications.json");
const trackerCsvPath = path.join(trackerDir, "job-applications.csv");
const trackerTemplatePath = path.join(trackerDir, "job-applications-template.xlsx");
const trackerWorkbookPath = path.join(trackerDir, "job-applications.xlsx");
const execFileAsync = promisify(execFile);

export const APPLICATION_STATUSES = [
  "Saved",
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
];

const CSV_COLUMNS = [
  ["company", "Company"],
  ["position", "Position"],
  ["jobId", "Job ID#"],
  ["jobUrl", "Job Listing - URL"],
  ["pdfCopyOfListing", "Copy of Listing"],
  ["compensation", "Compensation"],
  ["resumeProvided", "Resume Provided"],
  ["coverLetter", "Cover Letter"],
  ["applyDate", "Apply Date"],
  ["status", "Status"],
];

export function getApplicationTrackerPaths() {
  return {
    jsonPath: trackerJsonPath,
    csvPath: trackerCsvPath,
    xlsxPath: trackerWorkbookPath,
    templatePath: trackerTemplatePath,
  };
}

export async function prepareApplicationsWorkbookOpenPath() {
  return {
    openPath: "",
    workbookPath: trackerWorkbookPath,
    applicationsCount: (await listApplications()).length,
  };
}

export async function listApplications() {
  const store = await readStore();
  const applications = sortApplications(store.applications);
  syncApplicationsWorkbook(applications).catch(() => {});
  return applications;
}

export async function createApplication(input = {}) {
  const store = await readStore();
  const now = new Date().toISOString();
  const payload = sanitizeApplication({
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  const existing = findExistingApplication(store.applications, payload);

  if (existing) {
    const merged = sanitizeApplication({
      ...existing,
      ...fillMissingFields(existing, payload),
      updatedAt: now,
    });
    const applications = store.applications.map((item) => item.id === existing.id ? merged : item);
    await writeStore({ applications });
    return { application: merged, created: false };
  }

  const applications = sortApplications([payload, ...store.applications]);
  await writeStore({ applications });
  return { application: payload, created: true };
}

export async function updateApplication(id, input = {}) {
  const store = await readStore();
  const existing = store.applications.find((item) => item.id === id);

  if (!existing) {
    const error = new Error("Application not found");
    error.code = "APPLICATION_NOT_FOUND";
    throw error;
  }

  const updated = sanitizeApplication({
    ...existing,
    ...input,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
  const applications = sortApplications(store.applications.map((item) => item.id === id ? updated : item));
  await writeStore({ applications });
  return updated;
}

export async function getApplication(id) {
  const store = await readStore();
  return store.applications.find((item) => item.id === id) || null;
}

export async function deleteApplication(id) {
  const store = await readStore();
  const nextApplications = store.applications.filter((item) => item.id !== id);

  if (nextApplications.length === store.applications.length) {
    const error = new Error("Application not found");
    error.code = "APPLICATION_NOT_FOUND";
    throw error;
  }

  await writeStore({ applications: nextApplications });
}

export async function getApplicationsCsvBuffer() {
  const applications = await listApplications();
  const csv = buildApplicationsCsv(applications);
  return Buffer.from(csv, "utf8");
}

export async function getApplicationsWorkbookBuffer() {
  const store = await readStore();
  const applications = sortApplications(store.applications);
  const buffer = await buildApplicationsWorkbookFallbackBuffer(applications);
  try {
    await writeFileWithRetry(trackerWorkbookPath, buffer);
  } catch (error) {
    if (!isWorkbookLockError(error)) {
      throw error;
    }
  }
  return buffer;
}

async function readStore() {
  await fs.mkdir(trackerDir, { recursive: true });

  try {
    const raw = await fs.readFile(trackerJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const applications = Array.isArray(parsed?.applications)
      ? parsed.applications.map((item) => sanitizeApplication(item)).filter(isMeaningfulApplication)
      : [];
    return { applications: sortApplications(applications) };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const emptyStore = { applications: [] };
    await writeStore(emptyStore);
    return emptyStore;
  }
}

async function writeStore(store) {
  const normalized = {
    version: 1,
    applications: sortApplications(
      Array.isArray(store?.applications)
        ? store.applications.map((item) => sanitizeApplication(item)).filter(isMeaningfulApplication)
        : []
    ),
  };
  const jsonPayload = `${JSON.stringify(normalized, null, 2)}\n`;
  const csvPayload = buildApplicationsCsv(normalized.applications);
  await fs.mkdir(trackerDir, { recursive: true });
  await writeFileWithRetry(trackerJsonPath, jsonPayload, "utf8");
  try {
    await writeFileWithRetry(trackerCsvPath, csvPayload, "utf8");
  } catch (error) {
    if (!isRetryableWriteError(error)) {
      throw error;
    }
  }
  await syncApplicationsWorkbook(normalized.applications);
}

function sanitizeApplication(input = {}) {
  const position = normalizeText(input.position || input.title);
  const rawJobId = normalizeText(input.jobId || input.sourceKey);
  const inferredJobId = inferJobId(rawJobId, normalizeText(input.jobUrl));
  const compensation = normalizeText(input.compensation || input.salary);
  const id = normalizeText(input.id) || crypto.randomUUID();

  return {
    id,
    company: normalizeText(input.company),
    position,
    jobId: inferredJobId,
    jobUrl: normalizeText(input.jobUrl),
    pdfCopyOfListing: normalizeText(input.pdfCopyOfListing),
    compensation,
    resumeProvided: normalizeText(input.resumeProvided),
    coverLetter: normalizeText(input.coverLetter),
    applyDate: normalizeDateValue(input.applyDate || input.appliedAt),
    status: normalizeStatus(input.status),
    trackerKey: normalizeText(input.trackerKey),
    listingTextSnapshot: normalizeLongText(input.listingTextSnapshot),
    descriptionSnippet: normalizeLongText(input.descriptionSnippet),
    searchText: normalizeLongText(input.searchText),
    storageCompanySegment: normalizeText(input.storageCompanySegment) || buildStorageCompanySegment(input.company),
    storageRoleSegment: normalizeText(input.storageRoleSegment) || buildStorageRoleSegment(position || inferredJobId || "application", id),
    createdAt: normalizeDateTimeValue(input.createdAt) || new Date().toISOString(),
    updatedAt: normalizeDateTimeValue(input.updatedAt) || new Date().toISOString(),
  };
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeLongText(value) {
  return String(value || "").trim().slice(0, 200000);
}

function normalizeStatus(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return APPLICATION_STATUSES[0];
  }

  const match = APPLICATION_STATUSES.find((status) => status.toLowerCase() === normalized.toLowerCase());
  return match || APPLICATION_STATUSES[0];
}

function normalizeDateValue(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

function normalizeDateTimeValue(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString();
}

function findExistingApplication(applications, candidate) {
  const candidateTrackerKey = normalizeComparableText(candidate.trackerKey);
  const candidateUrl = normalizeComparableUrl(candidate.jobUrl);
  const candidateTitle = normalizeComparableText(candidate.position);
  const candidateCompany = normalizeComparableText(candidate.company);

  return applications.find((item) => {
    const existingTrackerKey = normalizeComparableText(item.trackerKey);
    if (candidateTrackerKey && existingTrackerKey && candidateTrackerKey === existingTrackerKey) {
      return true;
    }

    const existingUrl = normalizeComparableUrl(item.jobUrl);
    if (candidateUrl && existingUrl && candidateUrl === existingUrl) {
      return true;
    }

    return candidateTitle
      && candidateCompany
      && candidateTitle === normalizeComparableText(item.position)
      && candidateCompany === normalizeComparableText(item.company);
  }) || null;
}

function fillMissingFields(existing, incoming) {
  const merged = {};

  for (const [key] of CSV_COLUMNS) {
    if (!existing[key] && incoming[key]) {
      merged[key] = incoming[key];
    }
  }

  if (existing.status === "Saved" && incoming.status && incoming.status !== "Saved") {
    merged.status = incoming.status;
  }

  for (const key of ["listingTextSnapshot", "descriptionSnippet", "searchText"]) {
    if (!existing[key] && incoming[key]) {
      merged[key] = incoming[key];
    }
  }

  return merged;
}

function normalizeComparableText(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeComparableUrl(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  return normalized.replace(/\/+$/, "").toLowerCase();
}

function isMeaningfulApplication(application) {
  if (!application) {
    return false;
  }

  return Boolean(
    application.company
    || application.position
    || application.jobId
    || application.jobUrl
    || application.compensation
    || application.resumeProvided
    || application.coverLetter
    || application.applyDate
    || application.status
    || application.pdfCopyOfListing
  );
}

function inferJobId(currentJobId, jobUrl) {
  const explicit = normalizeText(currentJobId);
  const fromUrl = extractJobIdFromUrl(jobUrl);

  if (fromUrl && shouldReplaceJobId(explicit)) {
    return fromUrl;
  }

  return explicit || fromUrl;
}

function shouldReplaceJobId(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return true;
  }

  return /careerpage$/i.test(normalized)
    || /^[a-z0-9-]+$/.test(normalized) && !/\d/.test(normalized);
}

function extractJobIdFromUrl(value) {
  const urlValue = normalizeText(value);
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
    ].map((item) => normalizeText(item));
    const queryId = queryCandidates.find(Boolean);
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
        return normalizeText(match[1]);
      }
    }
  } catch {
    return "";
  }

  return "";
}

function buildStorageCompanySegment(value) {
  const normalized = normalizeText(value)
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "Uncategorized";
}

function buildStorageRoleSegment(value, id) {
  const base = normalizeText(value)
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const suffix = normalizeText(id).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 8) || "item";
  return `${base || "application"}_${suffix}`;
}

async function writeFileWithRetry(filePath, contents, encoding) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.writeFile(filePath, contents, encoding);
      return;
    } catch (error) {
      if (!isRetryableWriteError(error) || attempt === 4) {
        throw error;
      }

      lastError = error;
      await wait(120 * (attempt + 1));
    }
  }

  if (lastError) {
    throw lastError;
  }
}

function isRetryableWriteError(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.code === "EBUSY"
    || error?.code === "EPERM"
    || message.includes("being used by another process")
    || message.includes("cannot access the file")
    || message.includes("because it is being used")
    || message.includes("ioexception");
}

function isWorkbookLockError(error) {
  return isRetryableWriteError(error);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replaceFileWithRetry(sourcePath, destinationPath) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isRetryableWriteError(error) || attempt === 4) {
        lastError = error;
        break;
      }

      lastError = error;
      await wait(140 * (attempt + 1));
    }
  }

  try {
    await fs.unlink(sourcePath);
  } catch {
    // Ignore temp cleanup errors.
  }

  if (lastError) {
    throw lastError;
  }
}

function sortApplications(applications) {
  return [...applications].sort((left, right) => {
    const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
    const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
    return rightTime - leftTime;
  });
}

function buildApplicationsCsv(applications) {
  const lines = [
    CSV_COLUMNS.map(([, label]) => escapeCsv(label)).join(","),
    ...applications.map((application) => CSV_COLUMNS.map(([key]) => escapeCsv(application[key] || "")).join(",")),
  ];
  return `${lines.join("\n")}\n`;
}

async function ensureWorkbookFile() {
  await fs.mkdir(trackerDir, { recursive: true });

  try {
    await fs.access(trackerTemplatePath);
  } catch {
    throw new Error("Workbook template file is missing");
  }
}

async function syncApplicationsWorkbook(applications) {
  try {
    await writeApplicationsWorkbook(applications);
  } catch (error) {
    if (!isWorkbookLockError(error)) {
      throw error;
    }
  }
}

async function writeApplicationsWorkbook(applications) {
  await writeWorkbookToPath(applications, trackerWorkbookPath);
}

async function writeApplicationsWorkbookWithExcelAutomation(applications, outputPath) {
  if (process.platform !== "win32") {
    throw new Error("Excel automation is only supported on Windows");
  }

  const payloadPath = path.join(os.tmpdir(), `jobtrawl-applications-${crypto.randomUUID()}.json`);
  const templateCopyPath = path.join(os.tmpdir(), `jobtrawl-applications-template-${crypto.randomUUID()}.xlsx`);
  const payload = {
    templatePath: trackerTemplatePath,
    templateCopyPath,
    outputPath,
    sheetName: "Live",
    maxColumn: CSV_COLUMNS.length,
    templateLastRow: 61,
    rows: applications.map((application) => CSV_COLUMNS.map(([key]) => application[key] || "")),
  };

  await fs.writeFile(payloadPath, JSON.stringify(payload), "utf8");

  const command = `
$ErrorActionPreference = 'Stop'
$payload = Get-Content -LiteralPath '${toPowerShellLiteral(payloadPath)}' -Raw | ConvertFrom-Json
$excel = $null
$workbook = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  Copy-Item -LiteralPath $payload.templatePath -Destination $payload.templateCopyPath -Force
  Copy-Item -LiteralPath $payload.templatePath -Destination $payload.outputPath -Force
  $workbook = $excel.Workbooks.Open($payload.outputPath)
  $worksheet = if ($payload.sheetName) { $workbook.Worksheets.Item($payload.sheetName) } else { $workbook.Worksheets.Item(1) }
  $lastRow = [Math]::Max([int]$payload.templateLastRow, 2)
  $lastColumnLetter = [char](64 + [int]$payload.maxColumn)
  $worksheet.Range(("A2:{0}{1}" -f $lastColumnLetter, $lastRow)).ClearContents() | Out-Null
  $targetRow = 2
  foreach ($row in @($payload.rows)) {
    $column = 1
    foreach ($value in @($row)) {
      $worksheet.Cells.Item($targetRow, $column).Value2 = [string]$value
      $column += 1
    }
    $targetRow += 1
  }
  $workbook.Save()
  $workbook.Close($false)
} finally {
  if ($workbook) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($workbook) | Out-Null }
  if ($excel) {
    $excel.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
  }
  if (Test-Path -LiteralPath $payload.templateCopyPath) {
    Remove-Item -LiteralPath $payload.templateCopyPath -Force -ErrorAction SilentlyContinue
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`.trim();

  try {
    await execFileAsync("powershell", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      timeout: 45000,
    });
  } finally {
    await fs.unlink(payloadPath).catch(() => {});
  }
}

async function writeApplicationsWorkbookFallback(applications) {
  const tempWorkbookPath = `${trackerWorkbookPath}.tmp`;
  const buffer = await buildApplicationsWorkbookBuffer(applications);
  await fs.writeFile(tempWorkbookPath, buffer);
  await replaceFileWithRetry(tempWorkbookPath, trackerWorkbookPath);
}

async function buildApplicationsWorkbookBuffer(applications) {
  const tempWorkbookPath = path.join(os.tmpdir(), `jobtrawl-workbook-buffer-${crypto.randomUUID()}.xlsx`);
  try {
    await writeWorkbookToPath(applications, tempWorkbookPath);
    return await fs.readFile(tempWorkbookPath);
  } finally {
    await fs.unlink(tempWorkbookPath).catch(() => {});
  }
}

async function buildApplicationsWorkbookFallbackBuffer(applications) {
  const workbook = await buildApplicationsWorkbookFallback(applications);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

async function writeWorkbookToPath(applications, outputPath) {
  const workbook = await buildApplicationsWorkbookFallback(applications);
  await workbook.xlsx.writeFile(outputPath);
}

async function buildApplicationsWorkbookFallback(applications) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "JobTrawl";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const worksheet = workbook.addWorksheet("Live", {
    views: [{ state: "frozen", ySplit: 1 }],
    properties: { defaultRowHeight: 22 },
  });

  const defaultWidths = [24, 34, 18, 54, 28, 24, 22, 22, 16, 18];
  worksheet.columns = CSV_COLUMNS.map(([key, label], index) => ({
    key,
    header: label,
    width: defaultWidths[index] || 22,
    style: {
      alignment: { vertical: "top", wrapText: true },
    },
  }));

  worksheet.autoFilter = {
    from: "A1",
    to: "J1",
  };

  const headerRow = worksheet.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = {
      name: "Arial",
      size: 10,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "2F6B57" },
    };
    cell.border = {
      top: { style: "thin", color: { argb: "FF000000" } },
      left: { style: "thin", color: { argb: "FF000000" } },
      bottom: { style: "thin", color: { argb: "FF000000" } },
      right: { style: "thin", color: { argb: "FF000000" } },
    };
    cell.alignment = { vertical: "middle", horizontal: "left" };
  });

  const totalRows = Math.max(applications.length, 60);
  for (let index = 0; index < totalRows; index += 1) {
    const rowNumber = index + 2;
    const row = worksheet.getRow(rowNumber);
    const application = applications[index] || null;

    CSV_COLUMNS.forEach(([key], columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      cell.value = application ? buildWorkbookCellValue(application, key) : "";
      cell.font = {
        name: "Arial",
        size: 10,
        color: { argb: "FF000000" },
      };
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: "FF000000" } },
        left: { style: "thin", color: { argb: "FF000000" } },
        bottom: { style: "thin", color: { argb: "FF000000" } },
        right: { style: "thin", color: { argb: "FF000000" } },
      };
    });

    row.height = 22;
    row.commit();
  }

  return workbook;
}

function buildWorkbookCellValue(application, key) {
  const value = application?.[key] || "";
  if (!value) {
    return "";
  }

  if (key === "jobUrl") {
    return {
      text: String(value),
      hyperlink: String(value),
    };
  }

  if (key === "pdfCopyOfListing" || key === "resumeProvided" || key === "coverLetter") {
    const localPath = resolveWorkbookLocalFilePath(application, key, value);
    if (localPath) {
      return {
        text: path.basename(localPath),
        hyperlink: toFileUri(localPath),
      };
    }
  }

  return String(value);
}

function resolveWorkbookLocalFilePath(application, key, value) {
  const raw = normalizeText(value);
  if (!raw) {
    return "";
  }

  if (!raw.startsWith("/api/applications/")) {
    return raw;
  }

  const filename = decodeURIComponent(raw.split("/files/")[1] || "");
  if (!filename) {
    return "";
  }

  return path.join(
    process.cwd(),
    "data",
    "jobs",
    formatWorkbookFolderSegment(application.storageCompanySegment),
    formatWorkbookFolderSegment(application.storageRoleSegment),
    filename
  );
}

function formatWorkbookFolderSegment(value) {
  const normalized = normalizeText(value)
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "item";
}

function toFileUri(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, "/");
  return `file:///${resolved}`;
}

function toPowerShellLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll('"', '""')}"`;
}
