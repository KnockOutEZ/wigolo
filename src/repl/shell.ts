import { createInterface } from 'node:readline';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { parseArgs, tokenize, type ParsedArgs } from './parser.js';
import { booleanFlagsFor } from '../cli/flag-bridge.js';
import { complete } from './completer.js';
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
  formatJsonLine,
} from './formatters.js';
import { executeSearch } from './commands/search.js';
import { executeFetch } from './commands/fetch.js';
import { executeCrawl } from './commands/crawl.js';
import { executeExtract } from './commands/extract.js';
import { executeCache } from './commands/cache.js';
import { executeFindSimilar } from './commands/find-similar.js';
import { executeResearch } from './commands/research.js';
import { executeAgent } from './commands/agent.js';
import { executeDiff } from './commands/diff.js';
import { executeWatch } from './commands/watch.js';
import type { ReplDeps } from './commands/types.js';
import type { CrawlOutput, MapOutput } from '../types.js';

const log = createLogger('repl');

export interface ShellOptions {
  jsonMode?: boolean;
  input?: NodeJS.ReadableStream;
  /** Result/data sink (stdout in production). */
  output?: NodeJS.WritableStream;
  /** Human/diagnostic sink (stderr in production). Defaults to stderr. */
  errorOutput?: NodeJS.WritableStream;
  /** Whether the session is attached to a terminal (interactive). */
  isTty?: boolean;
}

export interface ShellResult {
  /** Number of commands that failed (error result, parse error, unknown). */
  failures: number;
}

/**
 * Parse one interactive shell line: tokenize, resolve the command's boolean-flag
 * set, then parse so bare boolean flags never swallow the following positional.
 * Exported for the boolean-wiring seam test.
 */
export function parseCommandLine(line: string): ParsedArgs {
  const tokens = tokenize(line);
  const cmd = tokens[0] ?? '';
  // The global --json flag is valueless. The one-shot path strips it before
  // parsing; the interactive path parses inline, so json must join the boolean
  // set or `fetch --json <url>` swallows the URL as --json's value.
  const booleans = booleanFlagsFor(cmd);
  booleans.add('json');
  return parseArgs(tokens, booleans);
}

function getHelpText(): string {
  return [
    'Available commands:',
    '',
    '  search <query> [--limit=N] [--domains=a,b] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]',
    '  fetch <url> [--mode=raw|markdown] [--max-chars=N] [--section=HEADING]',
    '  crawl <url> [--depth N] [--max-pages N] [--strategy=bfs|dfs|sitemap|map]',
    '  cache search <query> | cache stats | cache clear [--query=Q] [--url-pattern=P]',
    '  extract <url> [--mode=selector|tables|metadata|schema] [--selector=CSS]',
    '  find-similar <url-or-concept> [--limit=N] [--domains=a,b] [--no-cache] [--no-web]',
    '  research <question> [--depth=quick|standard|comprehensive] [--max-sources=N] [--domains=a,b]',
    '  agent <prompt> [--urls=u1,u2] [--max-pages=N] [--max-time=MS]',
    '  diff <url> [--output=unified|hunks|summary] [--granularity=line|word|section]',
    '  watch add <url> [--interval=SECONDS] | watch list | watch rm <id> | watch run <id>',
    '',
    '  help       Show this help',
    '  exit       Exit the shell',
    '  .history   Show command history',
    '  .json on|off  Toggle newline-delimited JSON output for tool results',
    '',
    'Global flags:',
    '  --json     Output raw JSON instead of formatted text',
  ].join('\n');
}

function loadHistory(historyPath: string): string[] {
  try {
    if (existsSync(historyPath)) {
      return readFileSync(historyPath, 'utf-8')
        .split('\n')
        .filter(line => line.trim().length > 0);
    }
  } catch (err) {
    log.warn('failed to load shell history', { error: String(err) });
  }
  return [];
}

function appendHistory(historyPath: string, line: string): void {
  try {
    mkdirSync(dirname(historyPath), { recursive: true });
    // History can contain typed queries/URLs — create it owner-only. The `mode`
    // applies at creation, so the file is never briefly world/group-readable
    // under a loose umask (no create-then-chmod TOCTOU window). On an existing
    // file the mode is ignored and the line is appended as before.
    appendFileSync(historyPath, line + '\n', { mode: 0o600 });
  } catch (err) {
    log.warn('failed to save shell history', { error: String(err) });
  }
}

export async function startShell(deps: ReplDeps, options: ShellOptions = {}): Promise<ShellResult> {
  const config = getConfig();
  const historyPath = config.shellHistoryPath;
  let jsonMode = options.jsonMode ?? false;
  const isTty = options.isTty ?? false;

  const out = options.output ?? process.stdout;
  const errOut = options.errorOutput ?? process.stderr;

  const rl = createInterface({
    input: options.input ?? process.stdin,
    output: errOut,
    prompt: 'wigolo> ',
    terminal: !(options.input),
    completer: (line: string) => complete(line),
  });

  const history = loadHistory(historyPath);
  let failures = 0;

  // Result/data → stdout; everything human-facing → stderr. This keeps NDJSON
  // stdout parseable (one JSON doc per line, zero human text interleaved).
  const emit = (text: string): void => {
    out.write(text + '\n');
  };
  const say = (text: string): void => {
    errOut.write(text + '\n');
  };

  const emitResult = (formatted: string, result: unknown, useJson: boolean): void => {
    if (useJson) {
      emit(formatJsonLine(result));
    } else {
      emit(formatted);
    }
    if (typeof (result as { error?: unknown })?.error === 'string') failures++;
  };

  log.info('shell started', { jsonMode, historyPath, isTty });
  say('wigolo interactive shell. Type "help" for commands, "exit" to quit.');
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();

    if (!trimmed) {
      rl.prompt();
      continue;
    }

    // History only for a real interactive terminal in text mode. A piped or
    // NDJSON session leaves no on-disk trace.
    if (isTty && !jsonMode) {
      appendHistory(historyPath, trimmed);
    }
    history.push(trimmed);

    const parsed = parseCommandLine(trimmed);

    if (parsed.command === 'exit' || parsed.command === 'quit' || parsed.command === '.exit') {
      say('Goodbye.');
      rl.close();
      return { failures };
    }

    if (parsed.command === 'help' || parsed.command === '.help') {
      say(getHelpText());
      rl.prompt();
      continue;
    }

    if (parsed.command === '.json') {
      const arg = parsed.positional[0];
      if (arg === 'on') jsonMode = true;
      else if (arg === 'off') jsonMode = false;
      else {
        say('Usage: .json on|off');
        rl.prompt();
        continue;
      }
      say(`JSON output ${jsonMode ? 'on' : 'off'}.`);
      rl.prompt();
      continue;
    }

    if (parsed.command === '.history') {
      const recent = history.slice(-50);
      for (const entry of recent) {
        say(`  ${entry}`);
      }
      rl.prompt();
      continue;
    }

    if (parsed.command === '.clear') {
      say('');
      rl.prompt();
      continue;
    }

    const useJson = jsonMode || parsed.flags.json === 'true';

    try {
      switch (parsed.command) {
        case 'search': {
          const result = await executeSearch(parsed, deps);
          emitResult(formatSearchResults(result), result, useJson);
          break;
        }
        case 'fetch': {
          const result = await executeFetch(parsed, deps);
          emitResult(formatFetchResult(result), result, useJson);
          break;
        }
        case 'crawl': {
          const result = await executeCrawl(parsed, deps);
          if (useJson) {
            emitResult('', result, true);
          } else {
            const url = parsed.positional[0] || '';
            if ('urls' in result && !('pages' in result)) {
              emitResult(formatMapResult(result as MapOutput, url), result, false);
            } else {
              emitResult(formatCrawlResult(result as CrawlOutput, url), result, false);
            }
          }
          break;
        }
        case 'extract': {
          const result = await executeExtract(parsed, deps);
          emitResult(formatExtractResult(result), result, useJson);
          break;
        }
        case 'cache': {
          const result = await executeCache(parsed);
          emitResult(formatCacheResult(result), result, useJson);
          break;
        }
        case 'find-similar':
        case 'find_similar': {
          const result = await executeFindSimilar(parsed, deps);
          emitResult(formatFindSimilarResult(result), result, useJson);
          break;
        }
        case 'research': {
          const result = await executeResearch(parsed, deps);
          emitResult(formatResearchResult(result), result, useJson);
          break;
        }
        case 'agent': {
          const result = await executeAgent(parsed, deps);
          emitResult(formatAgentResult(result), result, useJson);
          break;
        }
        case 'diff': {
          const result = await executeDiff(parsed, deps);
          emitResult(formatDiffResult(result), result, useJson);
          break;
        }
        case 'watch': {
          const result = await executeWatch(parsed, deps);
          emitResult(formatWatchResult(result), result, useJson);
          break;
        }
        default:
          failures++;
          say(`Unknown command: ${parsed.command}. Type "help" for available commands.`);
      }
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      log.error('command execution failed', { command: parsed.command, error: msg });
      say(`Error: ${msg}`);
    }

    rl.prompt();
  }

  log.info('shell input stream ended', { failures });
  return { failures };
}
