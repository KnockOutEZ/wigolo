import type { CrawlInput, CrawlOutput, MapOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleCrawl } from '../../tools/crawl.js';
import { coerceFlags, mergeBridged } from '../../cli/flag-bridge.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

export async function executeCrawl(
  args: ParsedArgs,
  deps: ReplDeps,
): Promise<CrawlOutput | (MapOutput & { crawled: number })> {
  try {
    const url = args.positional[0];
    if (!url) {
      return {
        pages: [],
        total_found: 0,
        crawled: 0,
        error: 'Usage: crawl <URL> [--depth N] [--max-pages N] [--strategy=bfs|dfs|sitemap|map]',
      };
    }

    const input: CrawlInput = { url };

    const consumed = new Set<string>();
    if (args.flags.depth) {
      input.max_depth = parseInt(args.flags.depth, 10);
      consumed.add('depth');
    }
    if (args.flags['max-depth']) {
      input.max_depth = parseInt(args.flags['max-depth'], 10);
      consumed.add('max-depth');
    }
    if (args.flags['max-pages']) {
      input.max_pages = parseInt(args.flags['max-pages'], 10);
      consumed.add('max-pages');
    }
    if (args.flags.strategy) {
      input.strategy = args.flags.strategy as CrawlInput['strategy'];
      consumed.add('strategy');
    }

    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.flags)) {
      if (!consumed.has(k)) rest[k] = v;
    }
    const bridged = coerceFlags('crawl', rest);
    if (bridged.errors.length > 0) {
      return { pages: [], total_found: 0, crawled: 0, error: bridged.errors[0] };
    }
    mergeBridged(input, bridged.input);

    log.debug('executing crawl command', { url, flags: args.flags });
    // REPL is a human-initiated entry — may reach a local dev server (P6-a source policy).
    return await handleCrawl(input, deps.router, 'human');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('crawl command failed', { error: msg });
    return {
      pages: [],
      total_found: 0,
      crawled: 0,
      error: msg,
    };
  }
}
