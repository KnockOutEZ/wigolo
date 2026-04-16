import {
  KNOWN_AGENT_IDS,
  FlagParseError,
  type InitFlags,
  type SetupMcpFlags,
} from './flags-types.js';

export { FlagParseError };

const INIT_KNOWN = new Set([
  '--non-interactive',
  '-y',
  '--agents',
  '--skip-verify',
  '--plain',
  '--help',
  '-h',
]);

const SETUP_KNOWN = new Set([
  '--non-interactive',
  '-y',
  '--agents',
  '--plain',
  '--help',
  '-h',
]);

interface Raw {
  nonInteractive: boolean;
  agents: string[];
  skipVerify: boolean;
  plain: boolean;
  help: boolean;
}

function parseAgentsValue(value: string): string[] {
  if (!value.trim()) {
    throw new FlagParseError('empty-agents', '--agents requires a comma-separated list of agent ids');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  if (ids.length === 0) {
    throw new FlagParseError('empty-agents', '--agents requires at least one agent id');
  }
  const unknown = ids.filter(id => !KNOWN_AGENT_IDS.includes(id));
  if (unknown.length > 0) {
    throw new FlagParseError(
      'unknown-agent',
      `Unknown agent id(s): ${unknown.join(', ')}. Valid: ${KNOWN_AGENT_IDS.join(', ')}`,
    );
  }
  return ids;
}

function parseCommon(args: readonly string[], known: ReadonlySet<string>): Raw {
  const raw: Raw = {
    nonInteractive: false,
    agents: [],
    skipVerify: false,
    plain: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (!token) { i++; continue; }

    if (token === '--non-interactive' || token === '-y') {
      raw.nonInteractive = true;
      i++;
      continue;
    }

    if (token === '--skip-verify') {
      raw.skipVerify = true;
      i++;
      continue;
    }

    if (token === '--plain') {
      raw.plain = true;
      i++;
      continue;
    }

    if (token === '--help' || token === '-h') {
      raw.help = true;
      i++;
      continue;
    }

    if (token.startsWith('--agents=')) {
      raw.agents = parseAgentsValue(token.slice('--agents='.length));
      i++;
      continue;
    }

    if (token === '--agents') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new FlagParseError('empty-agents', '--agents requires a comma-separated list of agent ids');
      }
      raw.agents = parseAgentsValue(next);
      i += 2;
      continue;
    }

    const base = token.startsWith('--') && token.includes('=') ? token.split('=')[0] : token;
    if (!known.has(base)) {
      throw new FlagParseError('unknown-flag', `Unknown flag: ${token}`);
    }
    i++;
  }

  return raw;
}

export function parseInitFlags(args: readonly string[]): InitFlags {
  const raw = parseCommon(args, INIT_KNOWN);
  return {
    nonInteractive: raw.nonInteractive,
    agents: raw.agents,
    skipVerify: raw.skipVerify,
    plain: raw.plain,
    help: raw.help,
  };
}

export function parseSetupMcpFlags(args: readonly string[]): SetupMcpFlags {
  const rest = args[0] === 'mcp' ? args.slice(1) : args;
  const raw = parseCommon(rest, SETUP_KNOWN);
  if (raw.skipVerify) {
    throw new FlagParseError('unknown-flag', 'Unknown flag: --skip-verify');
  }
  return {
    nonInteractive: raw.nonInteractive,
    agents: raw.agents,
    plain: raw.plain,
    help: raw.help,
  };
}
