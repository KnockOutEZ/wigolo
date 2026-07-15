import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli/help.js OR src/cli/help.ts → ../.. = package root
  return join(here, '..', '..');
}

export function getVersion(): string {
  try {
    const raw = readFileSync(join(packageRoot(), 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The ten one-shot tool commands, plus the `find_similar` snake-case alias. */
export const TOOL_COMMANDS = [
  'search',
  'fetch',
  'crawl',
  'extract',
  'cache',
  'find-similar',
  'find_similar',
  'research',
  'agent',
  'diff',
  'watch',
] as const;

export type ToolCommand = (typeof TOOL_COMMANDS)[number];

const TOOL_COMMAND_SET: ReadonlySet<string> = new Set(TOOL_COMMANDS);

export function isToolCommand(name: string): name is ToolCommand {
  return TOOL_COMMAND_SET.has(name);
}

/** Per-tool `--help` text. Keyed by every tool command incl. the alias. */
export const TOOL_HELP: Record<ToolCommand, string> = {
  search:
    `wigolo search <query> [flags]\n\n` +
    `Search the web (ML-reranked, multi-engine).\n\n` +
    `  --limit=N              Max results\n` +
    `  --domains=a,b          Restrict to these domains\n` +
    `  --exclude-domains=a,b  Drop these domains\n` +
    `  --from=YYYY-MM-DD      Earliest publish date\n` +
    `  --to=YYYY-MM-DD        Latest publish date\n` +
    `  --category=NAME        Search category\n` +
    `  --time-range=day|week|month|year\n` +
    `  --no-content           Skip full-content enrichment\n` +
    `  --json                 Emit machine-readable JSON\n`,
  fetch:
    `wigolo fetch <url> [flags]\n\n` +
    `Fetch a page as clean markdown (JS-rendered pages supported).\n\n` +
    `  --mode=raw|markdown    Rendering mode\n` +
    `  --max-chars=N          Truncate the body\n` +
    `  --section=HEADING      Return only a section\n` +
    `  --screenshot           Capture a screenshot\n` +
    `  --json                 Emit machine-readable JSON\n`,
  crawl:
    `wigolo crawl <url> [flags]\n\n` +
    `Crawl a site into the local cache.\n\n` +
    `  --depth N              Max crawl depth\n` +
    `  --max-pages N          Page cap\n` +
    `  --strategy=bfs|dfs|sitemap|map\n` +
    `  --json                 Emit machine-readable JSON\n`,
  extract:
    `wigolo extract <url> [flags]\n\n` +
    `Extract structured data from a page.\n\n` +
    `  --mode=selector|tables|metadata|schema|structured\n` +
    `  --selector=CSS         CSS selector (selector mode)\n` +
    `  --multiple             Return all matches\n` +
    `  --json                 Emit machine-readable JSON\n`,
  cache:
    `wigolo cache <subcommand> [flags]\n\n` +
    `Query the local knowledge cache.\n\n` +
    `  cache stats                          Cache statistics\n` +
    `  cache search <query>                 Search cached pages\n` +
    `  cache clear [--query=Q] [--url-pattern=P] [--since=T]\n` +
    `  --json                               Emit machine-readable JSON\n`,
  'find-similar':
    `wigolo find-similar <url-or-concept> [flags]\n\n` +
    `Discover related pages via hybrid semantic + keyword + web fusion.\n\n` +
    `  --limit=N              Max results\n` +
    `  --domains=a,b          Restrict to these domains\n` +
    `  --exclude-domains=a,b  Drop these domains\n` +
    `  --no-cache             Skip the local cache side\n` +
    `  --no-web               Skip the live-web side\n` +
    `  --json                 Emit machine-readable JSON\n`,
  find_similar:
    `wigolo find_similar <url-or-concept> [flags]\n\n` +
    `Alias of \`find-similar\`.\n\n` +
    `  --limit=N              Max results\n` +
    `  --domains=a,b          Restrict to these domains\n` +
    `  --exclude-domains=a,b  Drop these domains\n` +
    `  --no-cache             Skip the local cache side\n` +
    `  --no-web               Skip the live-web side\n` +
    `  --json                 Emit machine-readable JSON\n`,
  research:
    `wigolo research <question> [flags]\n\n` +
    `Multi-step research with a structured brief.\n\n` +
    `  --depth=quick|standard|comprehensive\n` +
    `  --max-sources=N        Source cap\n` +
    `  --domains=a,b          Restrict to these domains\n` +
    `  --exclude-domains=a,b  Drop these domains\n` +
    `  --json                 Emit machine-readable JSON\n`,
  agent:
    `wigolo agent <prompt> [flags]\n\n` +
    `Autonomous data gathering across the web.\n\n` +
    `  --urls=u1,u2           Seed URLs\n` +
    `  --max-pages=N          Page budget\n` +
    `  --max-time=MS          Time budget (ms)\n` +
    `  --json                 Emit machine-readable JSON\n`,
  diff:
    `wigolo diff <url> [flags]\n` +
    `wigolo diff --old="text" --new="text"\n\n` +
    `Diff a page against its cached copy (populate the cache with \`fetch\`/\`crawl\`\n` +
    `first), or diff two inline strings.\n\n` +
    `  --output=unified|hunks|summary\n` +
    `  --granularity=line|word|section\n` +
    `  --old="text"           Left side (inline mode)\n` +
    `  --new="text"           Right side (inline mode)\n` +
    `  --json                 Emit machine-readable JSON\n`,
  watch:
    `wigolo watch <subcommand> [flags]\n\n` +
    `Register change-watch jobs. Jobs run while \`wigolo serve\` (or an MCP session)\n` +
    `is active — a one-shot command cannot schedule them itself.\n\n` +
    `  watch add <url> [--interval=SECONDS] [--selector=CSS] [--notify=URL]\n` +
    `  watch list\n` +
    `  watch rm <job_id>\n` +
    `  watch run <job_id>            Run one check now\n` +
    `  watch pause <job_id>\n` +
    `  watch resume <job_id>\n` +
    `  --json                        Emit machine-readable JSON\n`,
};

export const HELP_TEXT = `wigolo — local-first web intelligence MCP server

Usage:
  wigolo                  Start MCP server on stdio (default)
  wigolo <command>        Run a subcommand
  wigolo <tool> <args>    Run a tool once (headless). See Tools below.

Subcommands:
  init [--wizard] [--json] Set up wigolo headlessly; wires agents. Components
                          download on first use (--warmup pre-caches)
  doctor [--fix] [--json] Diagnose installation; --fix repairs known failures
  config                  Manage settings (TUI or --set K=V headless)
  setup mcp               Wire wigolo into MCP clients
  shell                   Interactive REPL
  serve [--port N]        Start HTTP daemon
  health [--json]         Health check (exit code = status)
  verify [--json]         End-to-end capability smoke check
  auth                    Manage site auth
  plugin                  Manage plugins
  uninstall               Remove wigolo install
  status [--json]         Show running daemon status
  backfill                Backfill embeddings for cached pages without them

Tools (one-shot; add --json for machine-readable output, --help for flags):
  search <query>          Search the web
  fetch <url>             Fetch a page as markdown
  crawl <url>             Crawl a site into the cache
  extract <url>           Extract structured data from a page
  cache <subcommand>      Query the local knowledge cache
  find-similar <target>   Find related pages (alias: find_similar)
  research <question>     Multi-step research brief
  agent <prompt>          Autonomous data gathering
  diff <url>              Diff a page against its cached copy
  watch <subcommand>      Manage change-watch jobs

Advanced:
  warmup [--all|--searxng|--browser|--no-searxng]
                          Re-run component downloads (CI / repair)

Options:
  -h, --help              Print this help
  -V, --version           Print version

Docs: https://github.com/KnockOutEZ/wigolo
`;

export function printHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(HELP_TEXT);
}

export function printVersion(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`wigolo ${getVersion()}\n`);
}

export function printUnknownCommand(
  name: string,
  stream: NodeJS.WriteStream = process.stderr,
): void {
  stream.write(`wigolo: unknown command '${name}'\n\n`);
  stream.write(HELP_TEXT);
}
