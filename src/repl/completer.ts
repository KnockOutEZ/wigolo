import { toolFlagSpecs, booleanFlagsFor } from '../cli/flag-bridge.js';

/**
 * Pure readline completer for the interactive shell. Given the current input
 * line it returns `[matches, prefix]` where `prefix` is the token fragment being
 * completed and `matches` are the candidate completions for it. It never touches
 * I/O — the shell wires it into readline's `completer` option.
 *
 * Completion is inert inside an open quote (readline would insert into the
 * middle of a quoted argument), so those lines return no matches.
 */

/** Every command the shell accepts at position 0 (dispatch cases + meta). */
const COMMANDS: readonly string[] = [
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
  'help',
  'exit',
  'quit',
  '.json',
  '.history',
  '.clear',
  '.exit',
  '.help',
];

/** Subcommand verbs for the two verb-dispatched tools. */
const SUBCOMMAND_VERBS: Record<string, readonly string[]> = {
  cache: ['stats', 'search', 'clear'],
  watch: ['add', 'list', 'rm', 'delete', 'run', 'check', 'pause', 'resume'],
};

/** True when the line ends inside an unterminated single/double quote. */
function insideQuote(line: string): boolean {
  let inQuote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inQuote === '"') {
      escaped = true;
      continue;
    }
    if (ch === inQuote) {
      inQuote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && !inQuote) {
      inQuote = ch;
    }
  }
  return inQuote !== null;
}

/** All completable `--flag` names for a command (schema-derived + curated). */
function flagNamesFor(command: string): string[] {
  const specs = toolFlagSpecs(command);
  // An unknown command has no schema and thus no completable flags.
  if (specs.length === 0) return [];
  const names = new Set<string>();
  for (const spec of specs) {
    names.add(`--${spec.flag}`);
  }
  // booleanFlagsFor also surfaces curated boolean aliases + no- variants.
  for (const flag of booleanFlagsFor(command)) {
    names.add(`--${flag}`);
  }
  // Common curated value aliases usable on every tool command.
  for (const flag of ['limit', 'domains', 'exclude-domains', 'from', 'to', 'json']) {
    names.add(`--${flag}`);
  }
  return [...names];
}

export function complete(line: string): [string[], string] {
  if (insideQuote(line)) return [[], ''];

  // The fragment being completed is the text after the last unquoted space.
  const lastSpace = line.lastIndexOf(' ');
  const prefix = lastSpace >= 0 ? line.slice(lastSpace + 1) : line;
  const before = lastSpace >= 0 ? line.slice(0, lastSpace).trim() : '';

  // Position 0: completing the command itself.
  if (before === '') {
    return [COMMANDS.filter((c) => c.startsWith(prefix)), prefix];
  }

  const command = before.split(/\s+/)[0];

  // Completing a --flag for the active command.
  if (prefix.startsWith('--')) {
    const matches = flagNamesFor(command).filter((f) => f.startsWith(prefix)).sort();
    return [matches, prefix];
  }

  // Completing a subcommand verb (only right after the command word).
  const verbs = SUBCOMMAND_VERBS[command];
  if (verbs && before === command) {
    return [verbs.filter((v) => v.startsWith(prefix)), prefix];
  }

  return [[], prefix];
}
