export type Command =
  | 'mcp'
  | 'warmup'
  | 'serve'
  | 'studio'
  | 'health'
  | 'doctor'
  | 'auth'
  | 'plugin'
  | 'shell'
  | 'init'
  | 'config'
  | 'dashboard'
  | 'uninstall'
  | 'setup'
  | 'status'
  | 'backfill'
  | 'verify'
  | 'help'
  | 'version'
  | 'unknown';

export interface ParsedCommand {
  command: Command;
  args: string[];
}

const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  'mcp',
  'warmup',
  'serve',
  'studio',
  'health',
  'doctor',
  'auth',
  'plugin',
  'shell',
  'init',
  'config',
  'dashboard',
  'uninstall',
  'setup',
  'status',
  'backfill',
  'verify',
]);

const HELP_ALIASES: ReadonlySet<string> = new Set(['--help', '-h', 'help']);
const VERSION_ALIASES: ReadonlySet<string> = new Set(['--version', '-V', 'version']);

export function parseCommand(argv: string[]): ParsedCommand {
  const first = argv[0];

  if (!first) {
    return { command: 'mcp', args: [] };
  }

  if (HELP_ALIASES.has(first)) {
    return { command: 'help', args: [] };
  }

  if (VERSION_ALIASES.has(first)) {
    return { command: 'version', args: [] };
  }

  if (KNOWN_COMMANDS.has(first)) {
    return { command: first as Command, args: argv.slice(1) };
  }

  return { command: 'unknown', args: [first] };
}
