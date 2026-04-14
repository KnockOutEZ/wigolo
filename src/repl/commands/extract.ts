import type { ExtractInput, ExtractOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleExtract } from '../../tools/extract.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

export async function executeExtract(args: ParsedArgs, deps: ReplDeps): Promise<ExtractOutput> {
  try {
    const url = args.positional[0];
    if (!url) {
      return {
        data: {},
        mode: 'metadata',
        error: 'Usage: extract <URL> [--mode=selector|tables|metadata|schema] [--selector=CSS]',
      };
    }

    const input: ExtractInput = { url };

    if (args.flags.mode) {
      input.mode = args.flags.mode as ExtractInput['mode'];
    }
    if (args.flags.selector) {
      input.css_selector = args.flags.selector;
    }
    if (args.flags.multiple === 'true') {
      input.multiple = true;
    }

    log.debug('executing extract command', { url, flags: args.flags });
    return await handleExtract(input, deps.router);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('extract command failed', { error: msg });
    return {
      data: {},
      mode: (args.flags.mode as ExtractOutput['mode']) ?? 'metadata',
      error: msg,
    };
  }
}
