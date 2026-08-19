import type { IndexInput, IndexOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import { handleIndex } from '../../tools/index.js';
import { coerceFlags, mergeBridged } from '../../cli/flag-bridge.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

/**
 * One-shot index: `wigolo index <path> [--namespace=docs] [--glob=*.md] …`
 * Positional path maps to `source`; remaining schema flags go through the bridge.
 */
export async function executeIndex(args: ParsedArgs): Promise<IndexOutput> {
  const empty: IndexOutput = {
    indexed: 0,
    skipped: 0,
    failed: 0,
    namespace: 'docs',
    files: [],
  };

  try {
    const positionalSource = args.positional.join(' ').trim();
    const input: IndexInput = {
      source: positionalSource || args.flags.source || '',
    };

    const consumed = new Set(['source']);
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.flags)) {
      if (!consumed.has(k)) rest[k] = v;
    }
    const bridged = coerceFlags('index', rest);
    if (bridged.errors.length > 0) {
      return { ...empty, error: bridged.errors[0] };
    }
    mergeBridged(input, bridged.input);
    if (positionalSource) input.source = positionalSource;

    if (!input.source) {
      return {
        ...empty,
        error: 'Usage: wigolo index <path> [--namespace=docs] [--glob=*.md] [--tags=a,b]',
      };
    }

    log.debug('executing index command', { source: input.source, flags: args.flags });
    return await handleIndex(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('index command failed', { error: msg });
    return { ...empty, error: msg };
  }
}
