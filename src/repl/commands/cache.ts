import type { CacheInput, CacheOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import { handleCache } from '../../tools/cache.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

export async function executeCache(args: ParsedArgs): Promise<CacheOutput> {
  try {
    const subcommand = args.positional[0];

    let input: CacheInput;

    if (subcommand === 'stats' || (!subcommand && !args.flags.query)) {
      input = { stats: true };
    } else if (subcommand === 'clear') {
      input = {
        clear: true,
        query: args.flags.query,
        url_pattern: args.flags['url-pattern'],
        since: args.flags.since,
      };
    } else if (subcommand === 'search') {
      const query = args.positional.slice(1).join(' ').trim() || args.flags.query;
      input = {
        query,
        url_pattern: args.flags['url-pattern'],
        since: args.flags.since,
      };
    } else {
      const query = args.positional.join(' ').trim();
      input = {
        query: query || args.flags.query,
        url_pattern: args.flags['url-pattern'],
        since: args.flags.since,
      };
    }

    log.debug('executing cache command', { subcommand, flags: args.flags });
    return await handleCache(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('cache command failed', { error: msg });
    return { error: msg };
  }
}
