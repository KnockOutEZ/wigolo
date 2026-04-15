import type { ResearchInput, ResearchOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleResearch } from '../../tools/research.js';
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

    if (args.flags.depth) {
      input.depth = args.flags.depth as ResearchInput['depth'];
    }
    if (args.flags['max-sources']) {
      input.max_sources = parseInt(args.flags['max-sources'], 10);
    }
    if (args.flags.domains) {
      input.include_domains = args.flags.domains.split(',').map(d => d.trim());
    }
    if (args.flags['exclude-domains']) {
      input.exclude_domains = args.flags['exclude-domains'].split(',').map(d => d.trim());
    }

    log.debug('executing research command', { question, flags: args.flags });
    return await handleResearch(input, deps.engines, deps.router, deps.backendStatus);
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
