// scripts/daemon-bridge.mjs
//
// Wires Wigolo's compiled engine into the benchmark HTTP daemon.
//
// IMPORTANT: imports are from ../dist/, so the daemon requires a successful
//   `npm run build`  (or `./scripts/build_and_install_dev.sh`)
// before it can answer requests. See build_and_install_dev.sh.
//
// Wigolo's tool handlers (handleSearch / handleResearch / handleCrawl) require
// constructed subsystems (search engines, browser pool, router, backend status,
// etc.). We lazily call `initSubsystems()` once on first request and reuse the
// returned subsystems for all subsequent calls. We register `shutdown` to fire
// on process exit so the browser pool, sqlite handle, and any searxng process
// are torn down cleanly when the daemon stops.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { initSubsystems } from "../dist/server.js";
import { handleSearch } from "../dist/tools/search.js";
import { handleResearch } from "../dist/tools/research.js";
import { handleCrawl } from "../dist/tools/crawl.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from package.json so /health reports the same version as the
// MCP server does.
function readPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const version = readPkgVersion();

// Subsystem singleton. initSubsystems() is async + heavy (loads plugins, opens
// the SQLite cache, starts the embedding service, etc.) so we keep one instance
// alive for the lifetime of the daemon process.
let subsystemsPromise = null;
async function getSubsystems() {
  if (!subsystemsPromise) {
    subsystemsPromise = initSubsystems().then(async (subs) => {
      const onExit = async () => {
        try {
          await subs.shutdown();
        } catch (err) {
          process.stderr.write(`[daemon-bridge] shutdown error: ${String(err)}\n`);
        }
      };
      process.once("exit", onExit);
      process.once("SIGTERM", onExit);
      process.once("SIGINT", onExit);
      await subs.bootstrapSearxng();
      return subs;
    });
  }
  return subsystemsPromise;
}

// /search — accepts either a string query or a SearchInput object. The bench
// harness POSTs `{ "query": "..." }`, but we forward `opts` too so callers can
// override max_results, include_content, etc.
export async function search(query, opts = {}) {
  const subs = await getSubsystems();
  const input = typeof query === "string" ? { query, ...opts } : { ...query, ...opts };
  return await handleSearch(
    input,
    subs.searchEngines,
    subs.router,
    subs.backendStatus,
  );
}

// /research — `question` is the canonical input field for handleResearch.
export async function research(question, opts = {}) {
  const subs = await getSubsystems();
  const input =
    typeof question === "string"
      ? { question, ...opts }
      : { ...question, ...opts };
  return await handleResearch(
    input,
    subs.searchEngines,
    subs.router,
    subs.backendStatus,
  );
}

// /crawl — `url` is required by CrawlInput.
export async function crawl(url, opts = {}) {
  const subs = await getSubsystems();
  const input = typeof url === "string" ? { url, ...opts } : { ...url, ...opts };
  return await handleCrawl(input, subs.router);
}
