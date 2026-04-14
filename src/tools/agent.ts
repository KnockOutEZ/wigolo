import { createLogger } from '../logger.js';
import { runAgentPipeline } from '../agent/pipeline.js';
import type { AgentInput, AgentOutput, SearchEngine } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { BackendStatus } from '../server/backend-status.js';

const log = createLogger('agent');

const MAX_PAGES_LIMIT = 100;
const MAX_TIME_LIMIT_MS = 600000;

export async function handleAgent(
  input: AgentInput,
  engines: SearchEngine[],
  router: SmartRouter,
  backendStatus?: BackendStatus,
  server?: unknown,
): Promise<AgentOutput> {
  const start = Date.now();

  try {
    if (!input.prompt || typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      return errorResult('prompt is required and must be a non-empty string', start);
    }

    if (input.max_pages !== undefined) {
      if (typeof input.max_pages !== 'number' || input.max_pages < 1) {
        return errorResult('max_pages must be a positive number', start);
      }
      if (input.max_pages > MAX_PAGES_LIMIT) {
        return errorResult(`max_pages must be at most ${MAX_PAGES_LIMIT}`, start);
      }
    }

    if (input.max_time_ms !== undefined) {
      if (typeof input.max_time_ms !== 'number' || input.max_time_ms < 1) {
        return errorResult('max_time_ms must be a positive number', start);
      }
      if (input.max_time_ms > MAX_TIME_LIMIT_MS) {
        return errorResult(`max_time_ms must be at most ${MAX_TIME_LIMIT_MS}`, start);
      }
    }

    if (input.urls && input.urls.length > 0) {
      for (const url of input.urls) {
        try {
          new URL(url);
        } catch {
          return errorResult(`Invalid url in urls array: "${url}"`, start);
        }
      }
    }

    log.info('agent request received', {
      prompt: input.prompt.slice(0, 100),
      max_pages: input.max_pages,
      max_time_ms: input.max_time_ms,
      urlCount: input.urls?.length ?? 0,
      hasSchema: !!input.schema,
    });

    const result = await runAgentPipeline(
      input,
      engines,
      router,
      server as any,
    );

    return result;
  } catch (err) {
    log.error('agent handler failed', {
      prompt: input.prompt?.slice(0, 100),
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResult(
      err instanceof Error ? err.message : String(err),
      start,
    );
  }
}

function errorResult(error: string, start: number): AgentOutput {
  return {
    result: '',
    sources: [],
    pages_fetched: 0,
    steps: [],
    total_time_ms: Date.now() - start,
    sampling_supported: false,
    error,
  };
}
