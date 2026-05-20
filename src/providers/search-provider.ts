import type { SearchInput, SearchOutput, StageResult, ProgressCallback, SearchEngine } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { BackendStatus } from '../server/backend-status.js';
import type { SamplingCapableServer } from '../search/sampling.js';
import { createLogger } from '../logger.js';

const log = createLogger('providers');

/**
 * Runtime dependencies the legacy SearxNG orchestrator needs. These are wired
 * at server boot (search engines, fetch router) and per-call (sampling server,
 * progress callback). The provider interface accepts them so the tool handler
 * can remain a thin pass-through.
 */
export interface SearchContext {
  engines: SearchEngine[];
  router: SmartRouter;
  backendStatus?: BackendStatus;
  samplingServer?: SamplingCapableServer;
  onProgress?: ProgressCallback;
}

export interface SearchProvider {
  search(input: SearchInput, ctx: SearchContext): Promise<StageResult<SearchOutput>>;
  /** Best-effort name for telemetry/logging. */
  readonly name: 'searxng' | 'v1';
}

let cached: Promise<SearchProvider> | null = null;

export function getSearchProvider(): Promise<SearchProvider> {
  if (cached) return cached;
  // Read the raw env directly so unknown values surface to the caller. Config
  // narrows unknown to 'searxng' for safe downstream consumption, but here we
  // want explicit visibility per the v1-engine plan.
  const raw = process.env.WIGOLO_SEARCH;
  const which = raw === undefined || raw === '' ? 'searxng' : raw;
  if (which === 'searxng') {
    cached = import('../search/legacy/searxng-provider.js').then(
      m => {
        log.info('search provider selected', { provider: 'searxng' });
        return new m.LegacySearxngProvider();
      },
      err => { cached = null; throw err; },
    );
  } else if (which === 'v1') {
    cached = import('../search/v1/stub-provider.js').then(
      m => {
        log.info('search provider selected', { provider: 'v1' });
        return new m.V1StubProvider();
      },
      err => { cached = null; throw err; },
    );
  } else {
    return Promise.reject(new Error(
      `Unknown WIGOLO_SEARCH value: ${which}. Use 'v1' or 'searxng'.`,
    ));
  }
  return cached;
}

export function _resetSearchProviderForTest(): void {
  cached = null;
}
