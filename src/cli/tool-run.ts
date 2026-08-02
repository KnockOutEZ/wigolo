import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SmartRouter, type HttpClient } from '../fetch/router.js';
import { BrowserPool } from '../fetch/browser-pool.js';
import { httpFetch } from '../fetch/http-client.js';
import { DuckDuckGoEngine } from '../search/engines/duckduckgo.js';
import { BingEngine } from '../search/engines/bing.js';
import { initDatabase, closeDatabase } from '../cache/db.js';
import { BackendStatus } from '../server/backend-status.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { parseArgs, type ParsedArgs } from '../repl/parser.js';
import { booleanFlagsFor } from './flag-bridge.js';
import {
  formatSearchResults,
  formatFetchResult,
  formatCrawlResult,
  formatMapResult,
  formatExtractResult,
  formatCacheResult,
  formatFindSimilarResult,
  formatResearchResult,
  formatAgentResult,
  formatDiffResult,
  formatWatchResult,
  formatJson,
} from '../repl/formatters.js';
import { executeSearch } from '../repl/commands/search.js';
import { executeFetch } from '../repl/commands/fetch.js';
import { executeCrawl } from '../repl/commands/crawl.js';
import { executeExtract } from '../repl/commands/extract.js';
import { executeCache } from '../repl/commands/cache.js';
import { executeFindSimilar } from '../repl/commands/find-similar.js';
import { executeResearch } from '../repl/commands/research.js';
import { executeAgent } from '../repl/commands/agent.js';
import { executeDiff } from '../repl/commands/diff.js';
import { executeWatch } from '../repl/commands/watch.js';
import { TOOL_HELP, isToolCommand, type ToolCommand } from './help.js';
import type { ReplDeps } from '../repl/commands/types.js';
import type {
  SearchOutput,
  FetchOutput,
  CrawlOutput,
  MapOutput,
  ExtractOutput,
  CacheOutput,
  FindSimilarOutput,
  ResearchOutput,
  AgentOutput,
  DiffOutput,
  WatchJobOutput,
} from '../types.js';

const log = createLogger('cli');

/**
 * Result shape shared by every executor: the tool's output object, always
 * carrying an optional `error` string when the call failed. Used only to route
 * the process exit code — the payload itself is emitted verbatim. The concrete
 * per-tool output shapes all extend this (each carries an optional `error`),
 * so a widening cast is safe.
 */
interface ExecResult {
  error?: string;
}

function writeOut(text: string): void {
  // RESULT output goes to stdout. All logs stay on stderr (createLogger).
  process.stdout.write(text + '\n');
}

/**
 * Emit a formatted or JSON rendering of a tool result and return whether it was
 * a failure. Under `--json` the JSON is the ONLY thing on stdout (zero log
 * leakage), so JSON.parse of full stdout always succeeds.
 */
function emit(
  command: ToolCommand,
  result: ExecResult,
  parsed: ParsedArgs,
  useJson: boolean,
): void {
  if (useJson) {
    writeOut(formatJson(result));
    return;
  }

  switch (command) {
    case 'search':
      writeOut(formatSearchResults(result as unknown as SearchOutput));
      break;
    case 'fetch':
      writeOut(formatFetchResult(result as unknown as FetchOutput));
      break;
    case 'crawl': {
      const url = parsed.positional[0] ?? '';
      const record = result as Record<string, unknown>;
      if ('urls' in record && !('pages' in record)) {
        writeOut(formatMapResult(result as unknown as MapOutput, url));
      } else {
        writeOut(formatCrawlResult(result as unknown as CrawlOutput, url));
      }
      break;
    }
    case 'extract':
      writeOut(formatExtractResult(result as unknown as ExtractOutput));
      break;
    case 'cache':
      writeOut(formatCacheResult(result as unknown as CacheOutput));
      break;
    case 'find-similar':
    case 'find_similar':
      writeOut(formatFindSimilarResult(result as unknown as FindSimilarOutput));
      break;
    case 'research':
      writeOut(formatResearchResult(result as unknown as ResearchOutput));
      break;
    case 'agent':
      writeOut(formatAgentResult(result as unknown as AgentOutput));
      break;
    case 'diff':
      writeOut(formatDiffResult(result as unknown as DiffOutput));
      break;
    case 'watch':
      writeOut(formatWatchResult(result as unknown as WatchJobOutput));
      break;
  }
}

async function dispatch(
  command: ToolCommand,
  parsed: ParsedArgs,
  deps: ReplDeps,
): Promise<ExecResult> {
  // Every executor's output extends ExecResult (all carry `error?: string`),
  // so each return type widens to ExecResult without a cast.
  switch (command) {
    case 'search':
      return executeSearch(parsed, deps);
    case 'fetch':
      return executeFetch(parsed, deps);
    case 'crawl':
      return executeCrawl(parsed, deps);
    case 'extract':
      return executeExtract(parsed, deps);
    case 'cache':
      return executeCache(parsed);
    case 'find-similar':
    case 'find_similar':
      return executeFindSimilar(parsed, deps);
    case 'research':
      return executeResearch(parsed, deps);
    case 'agent':
      return executeAgent(parsed, deps);
    case 'diff':
      return executeDiff(parsed, deps);
    case 'watch':
      return executeWatch(parsed, deps);
  }
}

/**
 * One-shot runner for the ten MCP tools. Initializes the DB + fetch router the
 * same way the interactive shell does, but is searxng-free BY CONSTRUCTION: it
 * never calls `resolveSearchBackend` and never constructs a sidecar process.
 * The `search`/`fetch` tools route through the core provider (its own direct
 * adapters), but the research/agent/find_similar pipelines search the passed
 * engine instances directly — so we seed the same keyless direct engines the
 * MCP server uses (DuckDuckGo + Bing, no sidecar). Without these, one-shot
 * research/agent/find_similar would find zero web sources.
 *
 * Contract: RESULT → stdout, ALL logs → stderr. `--json` emits the tool's
 * MCP-shape JSON on stdout (exit 0), a failure exits 1, and under `--json` a
 * failure prints a JSON error object on stdout.
 */
export async function runTool(command: string, rawArgs: string[]): Promise<number> {
  if (!isToolCommand(command)) {
    process.stderr.write(`wigolo: unknown tool '${command}'\n`);
    return 1;
  }

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    writeOut(TOOL_HELP[command]);
    return 0;
  }

  const useJson = rawArgs.includes('--json');
  const args = rawArgs.filter((a) => a !== '--json');
  // `parseArgs` expects the command token at index 0. The boolean-flag set
  // keeps bare no-value flags (e.g. --no-content) from swallowing a positional.
  const parsed = parseArgs([command, ...args], booleanFlagsFor(command));

  const config = getConfig();
  mkdirSync(config.dataDir, { recursive: true });
  initDatabase(join(config.dataDir, 'wigolo.db'));

  const httpClient: HttpClient = { fetch: (url, options) => httpFetch(url, options) };
  const browserPool = new BrowserPool();
  const router = new SmartRouter(httpClient, browserPool);
  const backendStatus = new BackendStatus();
  const deps: ReplDeps = {
    router,
    engines: [new DuckDuckGoEngine(), new BingEngine()],
    backendStatus,
  };

  try {
    const result = await dispatch(command, parsed, deps);
    const failed = typeof result.error === 'string' && result.error.length > 0;

    if (useJson && failed) {
      // Emit a JSON error object on stdout — the whole result already carries
      // `.error`, so it is a parseable error envelope on its own.
      writeOut(formatJson(result));
    } else {
      emit(command, result, parsed, useJson);
    }
    return failed ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('one-shot tool failed', { command, error: msg });
    if (useJson) {
      writeOut(formatJson({ error: msg }));
    } else {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return 1;
  } finally {
    await browserPool.shutdown();
    closeDatabase();
  }
}
