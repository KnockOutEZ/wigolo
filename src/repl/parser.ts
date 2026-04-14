import { createLogger } from '../logger.js';

const log = createLogger('repl');

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
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
      continue;
    }

    if ((ch === ' ' || ch === '\t') && !inQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function parseArgs(tokens: string[]): ParsedArgs {
  if (tokens.length === 0) {
    return { command: '', positional: [], flags: {} };
  }

  const command = tokens[0];
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token.startsWith('--')) {
      const withoutDashes = token.slice(2);
      const eqIndex = withoutDashes.indexOf('=');

      if (eqIndex >= 0) {
        const key = withoutDashes.slice(0, eqIndex);
        const value = withoutDashes.slice(eqIndex + 1);
        flags[key] = value;
        i++;
      } else {
        const key = withoutDashes;
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i += 2;
        } else {
          flags[key] = 'true';
          i++;
        }
      }
    } else {
      positional.push(token);
      i++;
    }
  }

  log.debug('parsed command', { command, positional, flags });
  return { command, positional, flags };
}

export function parseLine(input: string): ParsedArgs {
  return parseArgs(tokenize(input));
}
