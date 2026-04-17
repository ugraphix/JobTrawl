import { promises as fs } from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "config", "sources.json");
const LOCATION_PATH = path.join(process.cwd(), "config", "locations.json");

export async function loadSourceConfig() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.sources) ? parsed.sources : [];
}

export async function loadLocationConfig() {
  const raw = await fs.readFile(LOCATION_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.states) ? parsed.states : [];
}