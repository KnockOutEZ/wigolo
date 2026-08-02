import type { ExtractInput, ExtractOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleExtract } from '../../tools/extract.js';
import { coerceFlags, mergeBridged } from '../../cli/flag-bridge.js';
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

    const consumed = new Set<string>();
    if (args.flags.selector) {
      input.css_selector = args.flags.selector;
      consumed.add('selector');
    }
    if (args.flags.multiple === 'true') {
      input.multiple = true;
      consumed.add('multiple');
    }

    // --mode (enum) and everything else validate through the schema bridge.
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.flags)) {
      if (!consumed.has(k)) rest[k] = v;
    }
    const bridged = coerceFlags('extract', rest);
    if (bridged.errors.length > 0) {
      return { data: {}, mode: input.mode ?? 'metadata', error: bridged.errors[0] };
    }
    mergeBridged(input, bridged.input);

    log.debug('executing extract command', { url, flags: args.flags });
    // REPL is a human-initiated entry — may reach a local dev server (P6-a source policy).
    const r = await handleExtract(input, deps.router, 'human');
    if (!r.ok) {
      return {
        data: {},
        mode: input.mode ?? 'metadata',
        error: r.error_reason,
      };
    }
    return r.data;
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
