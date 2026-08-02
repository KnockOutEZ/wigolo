import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolFlagSpecs, type FlagSpec } from './flag-bridge.js';

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

/**
 * Implementation dependency names must never surface in user-facing help
 * (CLAUDE.md naming rule). Schema descriptions are authored to capability
 * language, but this render-time guard is the last line of defence: if a schema
 * ever leaks a library name, it is swapped for the capability phrasing here.
 */
const CAPABILITY_SANITIZERS: ReadonlyArray<[RegExp, string]> = [
  [/playwright/gi, 'browser engine'],
  [/\bsearxng\b/gi, 'search engine'],
  [/flaresolverr/gi, 'challenge solver'],
  [/\bonnx\b/gi, 'ML runtime'],
  [/readability(\.js)?/gi, 'content extractor'],
  [/defuddle/gi, 'content extractor'],
  [/trafilatura/gi, 'content extractor'],
  [/turndown/gi, 'markdown converter'],
  [/flashrank/gi, 'ML reranker'],
  [/\bcdp\b/gi, 'browser control protocol'],
];

export function sanitizeCapabilityText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of CAPABILITY_SANITIZERS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Properties reachable another way than a derived --flag; no flag row. */
const HELP_PROPERTY_EXCLUSIONS: ReadonlySet<string> = new Set([
  'url',
  'prompt',
  'question',
  'query',
  'action',
  'clear',
  'stats',
  'old',
  'new',
]);

/** Human-readable value hint per flag kind, for the generated table. */
function valueHint(spec: FlagSpec): string {
  switch (spec.kind) {
    case 'boolean':
      return '';
    case 'number':
      return '=N';
    case 'enum':
      return `=${(spec.enumValues ?? []).join('|')}`;
    case 'array-string':
      return '=a,b';
    case 'array-object':
      return '=JSON|@file';
    case 'object':
      return '=JSON|@file';
    case 'oneof-string-array':
    case 'string':
    default:
      return '=VALUE';
  }
}

/** Usage line + short blurb per tool command (positional shape + intent). */
const TOOL_USAGE: Record<ToolCommand, { usage: string; blurb: string }> = {
  search: {
    usage: 'wigolo search <query> [flags]',
    blurb: 'Search the web (ML-reranked, multi-engine).',
  },
  fetch: {
    usage: 'wigolo fetch <url> [flags]',
    blurb: 'Fetch a page as clean markdown (JS-rendered pages supported).',
  },
  crawl: {
    usage: 'wigolo crawl <url> [flags]',
    blurb: 'Crawl a site into the local cache.',
  },
  extract: {
    usage: 'wigolo extract <url> [flags]',
    blurb: 'Extract structured data from a page.',
  },
  cache: {
    usage: 'wigolo cache <subcommand> [flags]',
    blurb:
      'Query the local knowledge cache.\n' +
      '  cache stats                Cache statistics\n' +
      '  cache search <query>       Search cached pages\n' +
      '  cache clear [--query=Q] [--url-pattern=P] [--since=T]',
  },
  'find-similar': {
    usage: 'wigolo find-similar <url-or-concept> [flags]',
    blurb: 'Discover related pages via hybrid semantic + keyword + web fusion.',
  },
  find_similar: {
    usage: 'wigolo find_similar <url-or-concept> [flags]',
    blurb: 'Alias of `find-similar`. Discover related pages.',
  },
  research: {
    usage: 'wigolo research <question> [flags]',
    blurb: 'Multi-step research with a structured brief.',
  },
  agent: {
    usage: 'wigolo agent <prompt> [flags]',
    blurb: 'Autonomous data gathering across the web.',
  },
  diff: {
    usage: 'wigolo diff <url> [flags]\nwigolo diff --old="text" --new="text"',
    blurb:
      'Diff a page against its cached copy (populate the cache with `fetch`/`crawl`\n' +
      'first), or diff two inline strings.\n' +
      '  --old="text"               Left side (inline mode)\n' +
      '  --new="text"               Right side (inline mode)',
  },
  watch: {
    usage: 'wigolo watch <subcommand> [flags]',
    blurb:
      'Register change-watch jobs. Jobs run while `wigolo serve` (or an MCP session)\n' +
      'is active — a one-shot command cannot schedule them itself.\n' +
      '  watch add <url> | watch list | watch rm <id> | watch run <id> | watch pause <id> | watch resume <id>',
  },
};

/** Curated shorthand-alias rows shown above the schema-derived table. */
const TOOL_ALIAS_ROWS: Partial<Record<ToolCommand, string[]>> = {
  search: [
    '  --limit=N                  Max results (alias of --max-results)',
    '  --domains=a,b              Restrict to these domains',
    '  --exclude-domains=a,b      Drop these domains',
    '  --from=YYYY-MM-DD          Earliest publish date',
    '  --to=YYYY-MM-DD            Latest publish date',
    '  --no-content               Skip full-content enrichment',
  ],
  'find-similar': [
    '  --limit=N                  Max results',
    '  --domains=a,b              Restrict to these domains',
    '  --no-cache                 Skip the local cache side',
    '  --no-web                   Skip the live-web side',
  ],
  find_similar: [
    '  --limit=N                  Max results',
    '  --domains=a,b              Restrict to these domains',
    '  --no-cache                 Skip the local cache side',
    '  --no-web                   Skip the live-web side',
  ],
  research: ['  --max-sources=N            Source cap', '  --domains=a,b              Restrict to these domains'],
  crawl: ['  --depth=N                  Max crawl depth (alias of --max-depth)', '  --max-pages=N              Page cap'],
  agent: ['  --urls=u1,u2               Seed URLs', '  --max-pages=N              Page budget', '  --max-time=MS              Time budget (ms)'],
  extract: ['  --selector=CSS             CSS selector (selector mode)'],
  watch: ['  --interval=SECONDS         Poll interval', '  --selector=CSS             Watch a page region', '  --notify=URL               Webhook on change'],
};

/** Build the full `--help` text for one tool from its live schema. */
function buildToolHelp(cmd: ToolCommand): string {
  const { usage, blurb } = TOOL_USAGE[cmd];
  const lines: string[] = [usage, '', blurb, ''];

  const aliasRows = TOOL_ALIAS_ROWS[cmd];
  if (aliasRows && aliasRows.length > 0) {
    lines.push(...aliasRows);
  }

  for (const spec of toolFlagSpecs(cmd)) {
    if (HELP_PROPERTY_EXCLUSIONS.has(spec.key)) continue;
    const name = `--${spec.flag}${valueHint(spec)}`;
    const desc = spec.description ? sanitizeCapabilityText(spec.description) : '';
    const pad = name.length < 26 ? ' '.repeat(26 - name.length) : '  ';
    lines.push(`  ${name}${pad}${desc}`.trimEnd());
  }

  lines.push('  --json                     Emit machine-readable JSON');
  return lines.join('\n') + '\n';
}

/** Per-tool `--help` text. Keyed by every tool command incl. the alias. */
export const TOOL_HELP: Record<ToolCommand, string> = Object.fromEntries(
  TOOL_COMMANDS.map((cmd) => [cmd, buildToolHelp(cmd)]),
) as Record<ToolCommand, string>;

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
  skills <add|list|remove> [packs] [--global] [--agent id,...] [--dry-run] [--json]
                          Install/manage wigolo skill packs for coding agents
  shell                   Interactive REPL (scriptable; --json → NDJSON)
  serve [--port N]        Start HTTP daemon (protocol stream; no --json)
  health [--json]         Health check (exit code = status)
  verify [--json]         End-to-end capability smoke check
  auth [--json]           Manage site auth
  plugin [--json]         Manage plugins
  tune [--json]           Inspect/reset per-domain self-tuning (routing, backoff)
  dashboard               Open the settings dashboard (alias of config)
  uninstall [--yes] [--json] Remove wigolo install
  status [--json]         Show running daemon status
  backfill [--json]       Backfill embeddings for cached pages without them

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
  warmup [--all|--browser|--reranker|--embeddings]
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
