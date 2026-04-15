import type { FindSimilarInput, FindSimilarOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleFindSimilar } from '../../tools/find-similar.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

export async function executeFindSimilar(
  args: ParsedArgs,
  deps: ReplDeps,
): Promise<FindSimilarOutput> {
  try {
    const target = args.positional[0];
    if (!target) {
      return {
        results: [],
        method: 'fts5',
        cache_hits: 0,
        search_hits: 0,
        embedding_available: false,
        total_time_ms: 0,
        error: 'Usage: find-similar <url-or-concept> [--limit=N] [--domains=a,b] [--no-cache] [--no-web]',
      };
    }

    const input: FindSimilarInput = {};

    try {
      new URL(target);
      input.url = target;
    } catch {
      input.concept = target;
    }

    if (args.positional.length > 1 && !input.concept) {
      input.concept = args.positional.slice(input.url ? 1 : 0).join(' ').trim() || undefined;
    }

    if (args.flags.limit) {
      input.max_results = parseInt(args.flags.limit, 10);
    }
    if (args.flags.domains) {
      input.include_domains = args.flags.domains.split(',').map(d => d.trim());
    }
    if (args.flags['exclude-domains']) {
      input.exclude_domains = args.flags['exclude-domains'].split(',').map(d => d.trim());
    }
    if (args.flags['no-cache'] === 'true') {
      input.include_cache = false;
    }
    if (args.flags['no-web'] === 'true') {
      input.include_web = false;
    }

    log.debug('executing find-similar command', { target, flags: args.flags });
    return await handleFindSimilar(input, deps.engines, deps.router, deps.backendStatus);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('find-similar command failed', { error: msg });
    return {
      results: [],
      method: 'fts5',
      cache_hits: 0,
      search_hits: 0,
      embedding_available: false,
      total_time_ms: 0,
      error: msg,
    };
  }
}
