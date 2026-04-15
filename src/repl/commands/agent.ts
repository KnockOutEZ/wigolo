import type { AgentInput, AgentOutput } from '../../types.js';
import type { ParsedArgs } from '../parser.js';
import type { ReplDeps } from './types.js';
import { handleAgent } from '../../tools/agent.js';
import { createLogger } from '../../logger.js';

const log = createLogger('repl');

export async function executeAgent(args: ParsedArgs, deps: ReplDeps): Promise<AgentOutput> {
  try {
    const prompt = args.positional.join(' ').trim();
    if (!prompt) {
      return {
        result: '',
        sources: [],
        pages_fetched: 0,
        steps: [],
        total_time_ms: 0,
        sampling_supported: false,
        error: 'Usage: agent <prompt> [--urls=u1,u2] [--max-pages=N] [--max-time=MS]',
      };
    }

    const input: AgentInput = { prompt };

    if (args.flags.urls) {
      input.urls = args.flags.urls.split(',').map(u => u.trim());
    }
    if (args.flags['max-pages']) {
      input.max_pages = parseInt(args.flags['max-pages'], 10);
    }
    if (args.flags['max-time']) {
      input.max_time_ms = parseInt(args.flags['max-time'], 10);
    }
    if (args.flags['max-time-ms']) {
      input.max_time_ms = parseInt(args.flags['max-time-ms'], 10);
    }

    log.debug('executing agent command', { prompt, flags: args.flags });
    return await handleAgent(input, deps.engines, deps.router, deps.backendStatus);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('agent command failed', { error: msg });
    return {
      result: '',
      sources: [],
      pages_fetched: 0,
      steps: [],
      total_time_ms: 0,
      sampling_supported: false,
      error: msg,
    };
  }
}
