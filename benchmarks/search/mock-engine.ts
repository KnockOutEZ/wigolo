import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../src/logger.js';
import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../src/types.js';
import type { PrerecordedResponse } from './types.js';

const log = createLogger('search');

export interface MockEngineOptions {
  simulateLatencyMs?: number;
  simulateError?: boolean;
}

export function loadPrerecordedResponses(responsesDir: string): Map<string, PrerecordedResponse> {
  try {
    if (!existsSync(responsesDir)) {
      throw new Error(`Responses directory not found: ${responsesDir}`);
    }

    const files = readdirSync(responsesDir);
    const responses = new Map<string, PrerecordedResponse>();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const raw = readFileSync(join(responsesDir, file), 'utf-8');
        const parsed = JSON.parse(raw) as PrerecordedResponse;
        if (parsed.queryId && Array.isArray(parsed.results)) {
          responses.set(parsed.queryId, parsed);
        }
      } catch (err) {
        log.warn('skipping malformed response file', { file, error: String(err) });
      }
    }

    return responses;
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) throw err;
    log.error('loadPrerecordedResponses failed', { error: String(err) });
    throw err;
  }
}

export class MockSearchEngine implements SearchEngine {
  name = 'mock';

  constructor(
    private readonly responses: Map<string, PrerecordedResponse>,
    private readonly queryId: string,
    private readonly options: MockEngineOptions = {},
  ) {}

  async search(query: string, options?: SearchEngineOptions): Promise<RawSearchResult[]> {
    try {
      if (this.options.simulateError) {
        throw new Error('Simulated search engine error');
      }

      if (this.options.simulateLatencyMs && this.options.simulateLatencyMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.options.simulateLatencyMs));
      }

      const response = this.responses.get(this.queryId);
      if (!response) {
        log.debug('no prerecorded response for queryId', { queryId: this.queryId });
        return [];
      }

      let results = response.results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        relevance_score: r.relevance_score,
        engine: 'mock' as const,
      }));

      if (options?.maxResults && options.maxResults < results.length) {
        results = results.slice(0, options.maxResults);
      }

      return results;
    } catch (err) {
      if (this.options.simulateError) throw err;
      log.error('MockSearchEngine.search failed', { error: String(err) });
      return [];
    }
  }
}
