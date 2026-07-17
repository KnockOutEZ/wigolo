import type { FetchInput, FetchOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleFetch } from '../../tools/fetch.js';
import { coerceFlags, mergeBridged } from '../../cli/flag-bridge.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

function errEnvelope(url: string, reason: string): FetchOutput {
  return {
    url,
    title: '',
    markdown: '',
    metadata: {},
    links: [],
    images: [],
    cached: false,
    error: reason,
  };
}

export async function executeFetch(args: ParsedArgs, deps: ReplDeps): Promise<FetchOutput> {
  try {
    const url = args.positional[0];
    if (!url) {
      return errEnvelope('', 'Usage: fetch <URL> [--mode=raw|markdown|cache|default|stealth]');
    }

    const input: FetchInput = { url };

    // --mode is value-dispatched across two schemas: raw/markdown map to the
    // render_js render mode; cache/default/stealth map to the schema `mode`
    // routing property. Anything else fails loudly.
    const consumed = new Set<string>();
    if (args.flags.mode !== undefined) {
      consumed.add('mode');
      const mode = args.flags.mode;
      if (mode === 'raw') {
        input.render_js = 'never';
      } else if (mode === 'markdown') {
        input.render_js = 'auto';
      } else if (mode === 'cache' || mode === 'default' || mode === 'stealth') {
        input.mode = mode;
      } else {
        return errEnvelope(
          url,
          `--mode: '${mode}' is not valid (allowed: raw, markdown, cache, default, stealth)`,
        );
      }
    }

    // Curated mappings kept for the friendly shorthands.
    if (args.flags['max-chars']) {
      input.max_chars = parseInt(args.flags['max-chars'], 10);
      consumed.add('max-chars');
    }
    if (args.flags.section) {
      input.section = args.flags.section;
      consumed.add('section');
    }
    if (args.flags.screenshot === 'true') {
      input.screenshot = true;
      consumed.add('screenshot');
    }

    // Everything else flows through the schema-driven bridge; curated keys win.
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.flags)) {
      if (!consumed.has(k)) rest[k] = v;
    }
    const bridged = coerceFlags('fetch', rest);
    if (bridged.errors.length > 0) {
      return errEnvelope(url, bridged.errors[0]);
    }
    // Curated keys already set above win over bridge-derived values.
    mergeBridged(input, bridged.input);

    log.debug('executing fetch command', { url, flags: args.flags });
    const r = await handleFetch(input, deps.router);
    if (!r.ok) {
      return errEnvelope(url, r.error_reason);
    }
    return r.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('fetch command failed', { error: msg });
    return errEnvelope(args.positional[0] || '', msg);
  }
}
