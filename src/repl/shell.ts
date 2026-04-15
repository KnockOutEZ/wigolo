import { createInterface } from 'node:readline';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { parseLine } from './parser.js';
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
  formatJson,
} from './formatters.js';
import { executeSearch } from './commands/search.js';
import { executeFetch } from './commands/fetch.js';
import { executeCrawl } from './commands/crawl.js';
import { executeExtract } from './commands/extract.js';
import { executeCache } from './commands/cache.js';
import { executeFindSimilar } from './commands/find-similar.js';
import { executeResearch } from './commands/research.js';
import { executeAgent } from './commands/agent.js';
import type { ReplDeps } from './commands/types.js';
import type { CrawlOutput, MapOutput } from '../types.js';

const log = createLogger('repl');

export interface ShellOptions {
  jsonMode?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
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
    '',
    '  help       Show this help',
    '  exit       Exit the shell',
    '  .history   Show command history',
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
    appendFileSync(historyPath, line + '\n');
  } catch (err) {
    log.warn('failed to save shell history', { error: String(err) });
  }
}

export async function startShell(deps: ReplDeps, options: ShellOptions = {}): Promise<void> {
  const config = getConfig();
  const historyPath = config.shellHistoryPath;
  const jsonMode = options.jsonMode ?? false;

  const rl = createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stderr,
    prompt: 'wigolo> ',
    terminal: !(options.input),
  });

  const history = loadHistory(historyPath);

  const write = (text: string): void => {
    const out = options.output ?? process.stdout;
    out.write(text + '\n');
  };

  log.info('shell started', { jsonMode, historyPath });
  write('wigolo interactive shell. Type "help" for commands, "exit" to quit.');
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();

    if (!trimmed) {
      rl.prompt();
      continue;
    }

    appendHistory(historyPath, trimmed);
    history.push(trimmed);

    const parsed = parseLine(trimmed);

    if (parsed.command === 'exit' || parsed.command === 'quit' || parsed.command === '.exit') {
      write('Goodbye.');
      rl.close();
      return;
    }

    if (parsed.command === 'help' || parsed.command === '.help') {
      write(getHelpText());
      rl.prompt();
      continue;
    }

    if (parsed.command === '.history') {
      const recent = history.slice(-50);
      for (const entry of recent) {
        write(`  ${entry}`);
      }
      rl.prompt();
      continue;
    }

    if (parsed.command === '.clear') {
      write('');
      rl.prompt();
      continue;
    }

    const useJson = jsonMode || parsed.flags.json === 'true';

    try {
      switch (parsed.command) {
        case 'search': {
          const result = await executeSearch(parsed, deps);
          write(useJson ? formatJson(result) : formatSearchResults(result));
          break;
        }
        case 'fetch': {
          const result = await executeFetch(parsed, deps);
          write(useJson ? formatJson(result) : formatFetchResult(result));
          break;
        }
        case 'crawl': {
          const result = await executeCrawl(parsed, deps);
          if (useJson) {
            write(formatJson(result));
          } else {
            const url = parsed.positional[0] || '';
            if ('urls' in result && !('pages' in result)) {
              write(formatMapResult(result as MapOutput, url));
            } else {
              write(formatCrawlResult(result as CrawlOutput, url));
            }
          }
          break;
        }
        case 'extract': {
          const result = await executeExtract(parsed, deps);
          write(useJson ? formatJson(result) : formatExtractResult(result));
          break;
        }
        case 'cache': {
          const result = await executeCache(parsed);
          write(useJson ? formatJson(result) : formatCacheResult(result));
          break;
        }
        case 'find-similar': {
          const result = await executeFindSimilar(parsed, deps);
          write(useJson ? formatJson(result) : formatFindSimilarResult(result));
          break;
        }
        case 'research': {
          const result = await executeResearch(parsed, deps);
          write(useJson ? formatJson(result) : formatResearchResult(result));
          break;
        }
        case 'agent': {
          const result = await executeAgent(parsed, deps);
          write(useJson ? formatJson(result) : formatAgentResult(result));
          break;
        }
        default:
          write(`Unknown command: ${parsed.command}. Type "help" for available commands.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('command execution failed', { command: parsed.command, error: msg });
      write(`Error: ${msg}`);
    }

    rl.prompt();
  }

  log.info('shell input stream ended');
}
