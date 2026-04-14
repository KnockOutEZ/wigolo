import type { SearchInput, SearchOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleSearch } from '../../tools/search.js';
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

    if (args.flags.limit) {
      input.max_results = parseInt(args.flags.limit, 10);
    }
    if (args.flags.domains) {
      input.include_domains = args.flags.domains.split(',').map(d => d.trim());
    }
    if (args.flags['exclude-domains']) {
      input.exclude_domains = args.flags['exclude-domains'].split(',').map(d => d.trim());
    }
    if (args.flags.from) {
      input.from_date = args.flags.from;
    }
    if (args.flags['from-date']) {
      input.from_date = args.flags['from-date'];
    }
    if (args.flags.to) {
      input.to_date = args.flags.to;
    }
    if (args.flags['to-date']) {
      input.to_date = args.flags['to-date'];
    }
    if (args.flags.category) {
      input.category = args.flags.category as SearchInput['category'];
    }
    if (args.flags['time-range']) {
      input.time_range = args.flags['time-range'] as SearchInput['time_range'];
    }
    if (args.flags['no-content'] === 'true') {
      input.include_content = false;
    }

    log.debug('executing search command', { query, flags: args.flags });
    return await handleSearch(input, deps.engines, deps.router, deps.backendStatus);
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
