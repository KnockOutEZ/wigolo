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
  '--provider',
  '--search',
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

const VALID_PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;
const VALID_SEARCH_BACKENDS = ['core', 'searxng', 'hybrid'] as const;

function parseInitOnlyFlags(args: readonly string[]): { provider?: string; search?: string } {
  let provider: string | undefined;
  let search: string | undefined;

  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (!token) { i++; continue; }

    if (token.startsWith('--provider=')) {
      const value = token.slice('--provider='.length);
      if (!(VALID_PROVIDERS as readonly string[]).includes(value)) {
        throw new FlagParseError(
          'unknown-provider',
          `Unknown provider: ${value}. Valid: ${VALID_PROVIDERS.join(', ')}`,
        );
      }
      provider = value;
      i++;
      continue;
    }

    if (token === '--provider') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new FlagParseError('unknown-provider', `--provider requires a value. Valid: ${VALID_PROVIDERS.join(', ')}`);
      }
      if (!(VALID_PROVIDERS as readonly string[]).includes(next)) {
        throw new FlagParseError(
          'unknown-provider',
          `Unknown provider: ${next}. Valid: ${VALID_PROVIDERS.join(', ')}`,
        );
      }
      provider = next;
      i += 2;
      continue;
    }

    if (token.startsWith('--search=')) {
      const value = token.slice('--search='.length);
      if (!(VALID_SEARCH_BACKENDS as readonly string[]).includes(value)) {
        throw new FlagParseError(
          'unknown-search',
          `Unknown search backend: ${value}. Valid: ${VALID_SEARCH_BACKENDS.join(', ')}`,
        );
      }
      search = value;
      i++;
      continue;
    }

    if (token === '--search') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new FlagParseError('unknown-search', `--search requires a value. Valid: ${VALID_SEARCH_BACKENDS.join(', ')}`);
      }
      if (!(VALID_SEARCH_BACKENDS as readonly string[]).includes(next)) {
        throw new FlagParseError(
          'unknown-search',
          `Unknown search backend: ${next}. Valid: ${VALID_SEARCH_BACKENDS.join(', ')}`,
        );
      }
      search = next;
      i += 2;
      continue;
    }

    i++;
  }

  return { provider, search };
}

export function parseInitFlags(args: readonly string[]): InitFlags {
  const raw = parseCommon(args, INIT_KNOWN);
  const { provider, search } = parseInitOnlyFlags(args);
  return {
    nonInteractive: raw.nonInteractive,
    agents: raw.agents,
    skipVerify: raw.skipVerify,
    plain: raw.plain,
    help: raw.help,
    provider,
    search,
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
