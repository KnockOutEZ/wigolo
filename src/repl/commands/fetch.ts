import type { FetchInput, FetchOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleFetch } from '../../tools/fetch.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

export async function executeFetch(args: ParsedArgs, deps: ReplDeps): Promise<FetchOutput> {
  try {
    const url = args.positional[0];
    if (!url) {
      return {
        url: '',
        title: '',
        markdown: '',
        metadata: {},
        links: [],
        images: [],
        cached: false,
        error: 'Usage: fetch <URL> [--mode=raw|markdown]',
      };
    }

    const input: FetchInput = { url };

    if (args.flags.mode === 'raw') {
      input.render_js = 'never';
    } else if (args.flags.mode === 'markdown') {
      input.render_js = 'auto';
    }

    if (args.flags['max-chars']) {
      input.max_chars = parseInt(args.flags['max-chars'], 10);
    }
    if (args.flags.section) {
      input.section = args.flags.section;
    }
    if (args.flags.screenshot === 'true') {
      input.screenshot = true;
    }

    log.debug('executing fetch command', { url, flags: args.flags });
    return await handleFetch(input, deps.router);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('fetch command failed', { error: msg });
    return {
      url: args.positional[0] || '',
      title: '',
      markdown: '',
      metadata: {},
      links: [],
      images: [],
      cached: false,
      error: msg,
    };
  }
}
