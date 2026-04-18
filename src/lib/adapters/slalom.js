import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

import { buildNormalizedJob, cleanText, safeText } from "./shared.js";

const DEFAULT_CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export async function fetchSlalomJobs(source) {
  const browserState = await fetchSlalomBrowserStateWithRetry(source);
  const jobs = Array.isArray(browserState?.jobResult) ? browserState.jobResult : [];

  return jobs.map((job) =>
    buildNormalizedJob(source, {
      id: job.id || job.jobOrder || `${source.key}-${job.title}`,
      company: source.company,
      title: job.title,
      locationLabel: job.location || "Unspecified",
      postedAt: job.postingDate || null,
      applyUrl: buildSlalomApplyUrl(source, job),
      descriptionSnippet: safeText(job.description),
      searchText: cleanText(job.description),
      rawLocationText: job.location || null,
    })
  );
}

async function fetchSlalomBrowserStateWithRetry(source) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const state = await fetchSlalomBrowserState(source);
      if (Array.isArray(state?.jobResult) && state.jobResult.length > 0) {
        return state;
      }
      lastError = new Error("Slalom browser state returned no jobs");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to fetch Slalom jobs");
}

async function fetchSlalomBrowserState(source) {
  const chromePath = source.chromePath || DEFAULT_CHROME_PATH;
  const port = Number(source.remoteDebuggingPort || await findOpenPort());
  const profileDir = await mkdtemp(join(tmpdir(), "jobtrawl-slalom-"));
  let browser = null;

  try {
    browser = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-crash-reporter",
        "--disable-breakpad",
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        source.careersUrl,
      ],
      {
        stdio: "ignore",
        windowsHide: true,
      }
    );

    const target = await waitForSlalomTarget(port, source.careersUrl);
    return await evaluateSlalomState(target.webSocketDebuggerUrl);
  } finally {
    if (browser && !browser.killed) {
      browser.kill("SIGKILL");
    }
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port || 9333);
      });
    });
  });
}

async function waitForSlalomTarget(port, careersUrl) {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      const targets = await response.json();
      const target = targets.find((item) => item?.type === "page" && String(item.url || "").startsWith(careersUrl));
      if (target?.webSocketDebuggerUrl) {
        return target;
      }
    } catch {
      // Keep polling while Chrome boots and the page hydrates.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Timed out while loading Slalom careers page");
}

async function evaluateSlalomState(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out while reading Slalom browser state"));
    }, 20000);

    const responseId = 2;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      socket.send(
        JSON.stringify({
          id: responseId,
          method: "Runtime.evaluate",
          params: {
            awaitPromise: true,
            returnByValue: true,
            expression: `
              (async () => {
                const deadline = Date.now() + 20000;
                while (Date.now() < deadline) {
                  const app = document.querySelector("#app");
                  const root = app && app.__vue__;
                  const store = root && root.$store;
                  const jobResult = store && store.state && store.state.jobResult;
                  if (Array.isArray(jobResult) && jobResult.length > 0) {
                    return JSON.stringify({
                      jobResult,
                      locale: store.state.locale,
                      queryLimit: store.state.jobQueryLimit
                    });
                  }
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }

                return JSON.stringify({
                  jobResult: [],
                  locale: null,
                  queryLimit: null
                });
              })()
            `,
          },
        })
      );
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== responseId) {
        return;
      }

      clearTimeout(timeout);
      socket.close();

      const payload = message?.result?.result?.value;
      if (!payload) {
        reject(new Error("Slalom browser state returned no data"));
        return;
      }

      try {
        resolve(JSON.parse(payload));
      } catch (error) {
        reject(error);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Unable to connect to Slalom browser debugger"));
    });
  });
}

function buildSlalomApplyUrl(source, job) {
  const jobId = String(job?.id || "").trim();
  if (!jobId) {
    return source.careersUrl;
  }

  return `${String(source.careersUrl || "").replace(/#\/?$/, "")}#/post/${encodeURIComponent(jobId)}`;
}
