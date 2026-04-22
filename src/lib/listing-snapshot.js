export function normalizeUrlForSnapshot(value) {
  const url = String(value || "").trim();
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    if (/^jobs\.careers\.microsoft\.com$/i.test(parsed.hostname)) {
      const positionId = parsed.pathname.match(/\/job\/(\d{8,})\/?$/i)?.[1];
      if (positionId) {
        const normalized = new URL("https://apply.careers.microsoft.com/careers");
        normalized.searchParams.set("pid", positionId);
        normalized.searchParams.set("start", "0");
        normalized.searchParams.set("sort_by", "timestamp");
        return normalized.toString();
      }
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

export function detectBlockedListing(domHtml) {
  const html = String(domHtml || "");
  const lower = html.toLowerCase();
  const title = extractHtmlTitle(html).toLowerCase();

  if (!html.trim()) {
    return "Listing capture produced an empty page";
  }

  if (title.includes("attention required") || title.includes("just a moment")) {
    return "Listing capture was blocked by site protection";
  }

  if (lower.includes("cloudflare") && (lower.includes("attention required") || lower.includes("verify you are human"))) {
    return "Listing capture was blocked by Cloudflare";
  }

  if (lower.includes("captcha") || lower.includes("verify you are human")) {
    return "Listing capture requires human verification";
  }

  return "";
}

export function shouldPreferTextListingSnapshot(jobUrl) {
  const normalized = String(jobUrl || "").trim();
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    return host === "apply.careers.microsoft.com"
      || host === "careers.expediagroup.com"
      || host === "careers.expedia.com"
      || host.endsWith(".expediagroup.com")
      || host === "www.mongodb.com"
      || host === "mongodb.com"
      || host === "jobs.smartrecruiters.com"
      || host === "api.smartrecruiters.com";
  } catch {
    return false;
  }
}

export function extractStructuredListingText(html) {
  const source = String(html || "");
  if (!source.trim()) {
    return "";
  }

  const candidates = [];
  const jsonLdBlocks = [...source.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of jsonLdBlocks) {
    const parsed = safelyParseStructuredJson(match[1]);
    collectStructuredDescriptions(parsed, candidates);
  }

  const metaPatterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
  ];
  for (const pattern of metaPatterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      candidates.push(decodeHtmlEntities(match[1]));
    }
  }

  const inlineDescriptionPatterns = [
    /"description"\s*:\s*"([\s\S]*?)"/i,
    /"jobDescription"\s*:\s*"([\s\S]*?)"/i,
  ];
  for (const pattern of inlineDescriptionPatterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      candidates.push(decodeHtmlEntities(match[1].replace(/\\u003C/gi, "<").replace(/\\u003E/gi, ">")));
    }
  }

  collectSmartRecruitersSectionCandidates(source, candidates);

  return candidates
    .map((value) => formatListingSnapshotText(String(value || "").replace(/\\n/g, "\n").replace(/\\r/g, "\n")))
    .filter((value) => value.length >= 60)
    .join("\n\n")
    .trim();
}

export function extractHtmlTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return cleanHtmlText(match?.[1] || "");
}

export function extractVisibleHtmlText(html) {
  const source = String(html || "");
  const stripped = source
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const decoded = decodeHtmlEntities(stripped)
    .split(/\n+/)
    .map((line) => cleanHtmlText(line))
    .filter(Boolean)
    .join("\n");

  return formatListingSnapshotText(decoded).trim();
}

export function cleanHtmlText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function decodeHtmlEntities(value) {
  return repairMojibakeText(String(value || ""))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function buildListingTextPdfBuffer({
  title = "",
  sourceUrl = "",
  company = "",
  position = "",
  jobId = "",
  compensation = "",
  scrapedText = "",
  fallbackReason = "",
} = {}) {
  const formattedText = formatListingSnapshotText(scrapedText);
  const headerLines = [
    company ? `Company: ${company}` : "",
    position ? `Position: ${position}` : "",
    jobId ? `Job ID: ${jobId}` : "",
    compensation ? `Compensation: ${compensation}` : "",
    fallbackReason ? `Capture note: ${fallbackReason}` : "",
  ].filter(Boolean);

  return buildSimplePdfDocument({
    title,
    sourceUrl,
    bodyText: [
      headerLines.join("\n"),
      "",
      formattedText || "JobTrawl could not render the full webpage, but this PDF preserves the available listing details and text snapshot.",
    ].join("\n"),
  });
}

export function buildSimplePdfDocument({ title = "", sourceUrl = "", bodyText = "" }) {
  const lines = wrapPdfText([
    title,
    sourceUrl ? `Source URL: ${sourceUrl}` : "",
    "",
    bodyText,
  ].filter(Boolean).join("\n"));

  const pageWidth = 612;
  const pageHeight = 792;
  const marginLeft = 54;
  const marginTop = 60;
  const lineHeight = 15;
  const linesPerPage = 44;

  const pages = [];
  for (let index = 0; index < lines.length; index += linesPerPage) {
    const chunk = lines.slice(index, index + linesPerPage);
    const commands = ["BT", "/F1 11 Tf", `${marginLeft} ${pageHeight - marginTop} Td`, `${lineHeight} TL`];
    chunk.forEach((line, lineIndex) => {
      const escaped = escapePdfText(line);
      commands.push(lineIndex === 0 ? `(${escaped}) Tj` : `T* (${escaped}) Tj`);
    });
    commands.push("ET");
    pages.push(commands.join("\n"));
  }

  const objects = [];
  const pageObjectIds = [];

  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj");
  objects.push("2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj");
  objects.push("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj");

  let nextId = 4;
  for (const pageContent of pages) {
    const contentId = nextId;
    nextId += 1;
    const pageId = nextId;
    nextId += 1;
    pageObjectIds.push(pageId);
    objects.push(`${contentId} 0 obj\n<< /Length ${Buffer.byteLength(pageContent, "utf8")} >>\nstream\n${pageContent}\nendstream\nendobj`);
    objects.push(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>\nendobj`);
  }

  objects[1] = `2 0 obj\n<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] >>\nendobj`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${object}\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "utf8");
}

function wrapPdfText(text) {
  const rawLines = normalizePdfSafeText(text).split("\n");
  const wrapped = [];
  const maxChars = 92;

  for (const rawLine of rawLines) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      wrapped.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChars && current) {
        wrapped.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }

    if (current) {
      wrapped.push(current);
    }
  }

  return wrapped.length > 0 ? wrapped : [""];
}

function escapePdfText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function normalizePdfSafeText(value) {
  return repairMojibakeText(String(value || ""))
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[•·▪◦]/g, "-")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/[ ]{2,}/g, " ");
}

function safelyParseStructuredJson(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectStructuredDescriptions(node, out) {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectStructuredDescriptions(item, out);
    }
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  const type = String(node["@type"] || "").toLowerCase();
  if (type.includes("jobposting") && typeof node.description === "string") {
    out.push(node.description);
  }

  for (const value of Object.values(node)) {
    collectStructuredDescriptions(value, out);
  }
}

function collectSmartRecruitersSectionCandidates(source, out) {
  const sectionPattern = /"title"\s*:\s*"([^"]{2,120})"\s*,\s*"text"\s*:\s*"([\s\S]*?)"\s*(?=[,}])/gi;
  const sections = [];

  for (const match of source.matchAll(sectionPattern)) {
    const title = decodeJsonEscapes(match[1]);
    const text = decodeJsonEscapes(match[2]);
    if (!title || !text) {
      continue;
    }
    sections.push(`${title}\n${text}`);
  }

  if (sections.length > 0) {
    out.push(sections.join("\n\n"));
  }
}

function formatListingSnapshotText(value) {
  const source = decodeJsonEscapes(decodeHtmlEntities(String(value || "")))
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/div>/gi, "\n")
    .replace(/<div[^>]*>/gi, "")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/ul>/gi, "\n")
    .replace(/<ul[^>]*>/gi, "\n")
    .replace(/<\/ol>/gi, "\n")
    .replace(/<ol[^>]*>/gi, "\n")
    .replace(/<strong[^>]*>/gi, "")
    .replace(/<\/strong>/gi, "")
    .replace(/<b[^>]*>/gi, "")
    .replace(/<\/b>/gi, "")
    .replace(/<[^>]+>/g, " ");

    const lines = source
      .split(/\n+/)
      .map((line) => cleanHtmlText(line))
      .filter(Boolean)
      .filter((line) => !/^pretty-print$/i.test(line))
      .filter((line) => !/^search jobs$/i.test(line))
      .filter((line) => !/^join career network$/i.test(line))
      .filter((line) => !/^(home|teams|life at eg|locations|blog)$/i.test(line))
      .filter((line) => !/^\{?"id":/i.test(line))
      .filter((line) => !/^"uuid":/i.test(line))
      .filter((line) => !/[{}]/.test(line))
      .filter((line) => !/":"|","/.test(line))
      .filter((line) => !/^\}\}\},?"?[a-z0-9_]+":/i.test(line))
      .filter((line) => !/^\{.*"[a-z0-9_]+" *:/i.test(line))
      .filter((line) => (line.match(/"[a-z0-9_]+" *:/gi) || []).length < 2);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function mergeListingTextCandidates(...values) {
  const merged = [];

  for (const value of values) {
    const formatted = formatListingSnapshotText(value);
    if (!formatted) {
      continue;
    }

    const normalized = normalizeComparableListingText(formatted);
    let shouldInsert = true;

    for (let index = 0; index < merged.length; index += 1) {
      const existing = merged[index];
      const existingNormalized = normalizeComparableListingText(existing);

      if (existingNormalized === normalized || existingNormalized.includes(normalized)) {
        shouldInsert = false;
        break;
      }

      if (normalized.includes(existingNormalized)) {
        merged[index] = formatted;
        shouldInsert = false;
        break;
      }
    }

    if (shouldInsert) {
      merged.push(formatted);
    }
  }

  return merged.join("\n\n").trim();
}

function normalizeComparableListingText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .trim();
}

function decodeJsonEscapes(value) {
  let text = repairMojibakeText(String(value || ""));
  text = text
    .replace(/\\u003C/gi, "<")
    .replace(/\\u003E/gi, ">")
    .replace(/\\u0027/gi, "'")
    .replace(/\\u0026/gi, "&")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, " ");
  text = text.replace(/(?:\\u[0-9a-f]{4})+/gi, (match) => (
    match.replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
  ));
  text = text.replace(/(?:u[0-9a-f]{4}){2,}/gi, (match) => (
    match.replace(/u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
  ));
  return repairMojibakeText(text);
}

function repairMojibakeText(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }

  const simpleFixed = text
    .replace(/â€™/g, "'")
    .replace(/â€˜/g, "'")
    .replace(/â€œ/g, '"')
    .replace(/â€\x9d/g, '"')
    .replace(/â€"/g, '"')
    .replace(/â€“/g, "-")
    .replace(/â€”/g, "-")
    .replace(/â€¦/g, "...")
    .replace(/Â /g, " ")
    .replace(/Â/g, "");

  if (!/[ÃÂâ]/.test(simpleFixed)) {
    return simpleFixed;
  }

  try {
    const decoded = Buffer.from(simpleFixed, "latin1").toString("utf8");
    const originalNoise = countMojibakeMarkers(simpleFixed);
    const decodedNoise = countMojibakeMarkers(decoded);
    return decodedNoise < originalNoise ? decoded : simpleFixed;
  } catch {
    return simpleFixed;
  }
}

function countMojibakeMarkers(value) {
  return (String(value || "").match(/[ÃÂâ]|�/g) || []).length;
}
