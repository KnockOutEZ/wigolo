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

export const HELP_TEXT = `wigolo — local-first web intelligence MCP server

Usage:
  wigolo                  Start MCP server on stdio (default)
  wigolo <command>        Run a subcommand

Subcommands:
  init                    Set up wigolo: install components, wire into agents
  doctor                  Diagnose installation
  config                  Manage settings (TUI or --set K=V headless)
  setup mcp               Wire wigolo into MCP clients
  shell                   Interactive REPL
  serve                   Start HTTP daemon
  health                  Health check (exit code = status)
  auth                    Manage site auth
  plugin                  Manage plugins
  uninstall               Remove wigolo install
  status                  Show running daemon status
  backfill                Backfill embeddings for cached pages without them

Advanced:
  warmup [--all]          Re-run component downloads (CI / repair)

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
