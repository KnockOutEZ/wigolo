import type { ResearchInput, ResearchOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleResearch } from '../../tools/research.js';
import { coerceFlags, mergeBridged } from '../../cli/flag-bridge.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

export async function executeResearch(args: ParsedArgs, deps: ReplDeps): Promise<ResearchOutput> {
  try {
    const question = args.positional.join(' ').trim();
    if (!question) {
      return {
        report: '',
        citations: [],
        sources: [],
        sub_queries: [],
        depth: 'standard',
        total_time_ms: 0,
        sampling_supported: false,
        error: 'Usage: research <question> [--depth=quick|standard|comprehensive] [--max-sources=N] [--domains=a,b]',
      };
    }

    const input: ResearchInput = { question };

    const consumed = new Set<string>();
    if (args.flags['max-sources']) {
      input.max_sources = parseInt(args.flags['max-sources'], 10);
      consumed.add('max-sources');
    }
    if (args.flags.domains) {
      input.include_domains = args.flags.domains.split(',').map(d => d.trim());
      consumed.add('domains');
    }
    if (args.flags['exclude-domains']) {
      input.exclude_domains = args.flags['exclude-domains'].split(',').map(d => d.trim());
      consumed.add('exclude-domains');
    }

    // --depth (enum) and everything else validate through the schema bridge.
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.flags)) {
      if (!consumed.has(k)) rest[k] = v;
    }
    const bridged = coerceFlags('research', rest);
    if (bridged.errors.length > 0) {
      return {
        report: '',
        citations: [],
        sources: [],
        sub_queries: [],
        depth: input.depth ?? 'standard',
        total_time_ms: 0,
        sampling_supported: false,
        error: bridged.errors[0],
      };
    }
    mergeBridged(input, bridged.input);

    log.debug('executing research command', { question, flags: args.flags });
    const r = await handleResearch(input, deps.engines, deps.router, deps.backendStatus);
    if (!r.ok) {
      return {
        report: '',
        citations: [],
        sources: [],
        sub_queries: [],
        depth: input.depth ?? 'standard',
        total_time_ms: 0,
        sampling_supported: false,
        error: r.error_reason,
      };
    }
    return r.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('research command failed', { error: msg });
    return {
      report: '',
      citations: [],
      sources: [],
      sub_queries: [],
      depth: 'standard',
      total_time_ms: 0,
      sampling_supported: false,
      error: msg,
    };
  }
}
