export type Command = 'mcp' | 'warmup' | 'serve' | 'health' | 'doctor' | 'auth';

export interface ParsedCommand {
  command: Command;
  args: string[];
}

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(['warmup', 'serve', 'health', 'doctor', 'auth']);

export function parseCommand(argv: string[]): ParsedCommand {
  const first = argv[0];

  if (first && KNOWN_COMMANDS.has(first)) {
    return { command: first as Command, args: argv.slice(1) };
  }

  return { command: 'mcp', args: [] };
}
