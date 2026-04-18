import { promises as fs } from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "config", "sources.json");
const GENERATED_CONFIG_PATH = path.join(process.cwd(), "config", "openpostings-sources.json");
const LOCATION_PATH = path.join(process.cwd(), "config", "locations.json");

export async function loadSourceConfig() {
  const [curatedSources, generatedSources] = await Promise.all([
    readSourcesFile(CONFIG_PATH, { required: true }),
    readSourcesFile(GENERATED_CONFIG_PATH, { required: false }),
  ]);

  const merged = [...curatedSources];
  const seenKeys = new Set(curatedSources.map((source) => String(source?.key || "").trim()).filter(Boolean));

  for (const source of generatedSources) {
    const key = String(source?.key || "").trim();
    if (!key || seenKeys.has(key)) {
      continue;
    }
    merged.push(source);
    seenKeys.add(key);
  }

  return merged;
}

export async function loadLocationConfig() {
  const raw = await fs.readFile(LOCATION_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.states) ? parsed.states : [];
}

async function readSourcesFile(filePath, { required }) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.sources) ? parsed.sources : [];
  } catch (error) {
    if (!required && error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
