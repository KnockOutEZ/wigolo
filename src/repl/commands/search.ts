import type { SearchInput, SearchOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleSearch } from '../../tools/search.js';
import { coerceFlags, mergeBridged } from '../../cli/flag-bridge.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

export async function executeSearch(args: ParsedArgs, deps: ReplDeps): Promise<SearchOutput> {
  try {
    const query = args.positional.join(' ').trim();
    if (!query) {
      return {
        results: [],
        query: '',
        engines_used: [],
        total_time_ms: 0,
        error: 'Usage: search <query> [--limit=N] [--domains=a,b] [--from=DATE] [--to=DATE]',
      };
    }

    const input: SearchInput = { query };

    const consumed = new Set<string>();
    if (args.flags.limit) {
      input.max_results = parseInt(args.flags.limit, 10);
      consumed.add('limit');
    }
    if (args.flags.domains) {
      input.include_domains = args.flags.domains.split(',').map(d => d.trim());
      consumed.add('domains');
    }
    if (args.flags['exclude-domains']) {
      input.exclude_domains = args.flags['exclude-domains'].split(',').map(d => d.trim());
      consumed.add('exclude-domains');
    }
    if (args.flags.from) {
      input.from_date = args.flags.from;
      consumed.add('from');
    }
    if (args.flags['from-date']) {
      input.from_date = args.flags['from-date'];
      consumed.add('from-date');
    }
    if (args.flags.to) {
      input.to_date = args.flags.to;
      consumed.add('to');
    }
    if (args.flags['to-date']) {
      input.to_date = args.flags['to-date'];
      consumed.add('to-date');
    }
    if (args.flags['no-content'] === 'true') {
      input.include_content = false;
      consumed.add('no-content');
    }

    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.flags)) {
      if (!consumed.has(k)) rest[k] = v;
    }
    const bridged = coerceFlags('search', rest);
    if (bridged.errors.length > 0) {
      return {
        results: [],
        query,
        engines_used: [],
        total_time_ms: 0,
        error: bridged.errors[0],
      };
    }
    mergeBridged(input, bridged.input);

    log.debug('executing search command', { query, flags: args.flags });
    const r = await handleSearch(input, deps.engines, deps.router, deps.backendStatus);
    if (!r.ok) {
      return {
        results: [],
        query,
        engines_used: [],
        total_time_ms: 0,
        error: r.error_reason,
      };
    }
    return r.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('search command failed', { error: msg });
    return {
      results: [],
      query: args.positional.join(' ') || '',
      engines_used: [],
      total_time_ms: 0,
      error: msg,
    };
  }
}
