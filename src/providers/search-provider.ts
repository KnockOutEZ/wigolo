import type { SearchInput, SearchOutput, StageResult, ProgressCallback, SearchEngine } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { BackendStatus } from '../server/backend-status.js';
import type { SamplingCapableServer } from '../search/sampling.js';
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { searxngBackendAvailable } from '../searxng/enabled.js';

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
  readonly name: 'core' | 'searxng' | 'hybrid';
}

let cached: Promise<SearchProvider> | null = null;

export function getSearchProvider(): Promise<SearchProvider> {
  if (cached) return cached;
  // Resolve through getConfig() so a persisted `searchBackend` in config.json is
  // honored at runtime (env still wins — precedence is handled in config.ts).
  const raw = getConfig().searchBackend;
  let which = raw === null || raw === undefined || raw === '' ? 'core' : raw;
  if (which === 'v1') {
    log.warn('WIGOLO_SEARCH=v1 is deprecated, use WIGOLO_SEARCH=core (alias kept for one release)');
    which = 'core';
  }
  if (which === 'searxng') {
    cached = import('../search/legacy/searxng-provider.js').then(
      m => {
        log.info('search provider selected', { provider: 'searxng' });
        return new m.LegacySearxngProvider();
      },
      err => { cached = null; throw err; },
    );
  } else if (which === 'core') {
    cached = import('../search/core/core-provider.js').then(
      m => {
        log.info('search provider selected', { provider: 'core' });
        return new m.CoreSearchProvider();
      },
      err => { cached = null; throw err; },
    );
  } else if (which === 'hybrid') {
    cached = (async () => {
      try {
        const [coreMod, sxMod, hybridMod] = await Promise.all([
          import('../search/core/core-provider.js'),
          import('../search/legacy/searxng-provider.js'),
          import('../search/hybrid/router.js'),
        ]);
        // D1: in hybrid mode the fallback tier runs only when the sidecar can
        // actually serve (external URL or an installed, ready process). When it
        // can't, the hybrid provider skips the fallback and surfaces an
        // actionable per-request warning instead of searching empty engines.
        const available = searxngBackendAvailable(getConfig());
        log.info('search provider selected', { provider: 'hybrid', searxngAvailable: available });
        return new hybridMod.HybridSearchProvider(
          new coreMod.CoreSearchProvider(),
          new sxMod.LegacySearxngProvider(),
          available,
        );
      } catch (err) {
        cached = null;
        throw err;
      }
    })();
  } else {
    return Promise.reject(new Error(
      `Unknown WIGOLO_SEARCH value: ${which}. Use 'core' (default), 'searxng', or 'hybrid'.`,
    ));
  }
  return cached;
}

export function _resetSearchProviderForTest(): void {
  cached = null;
}
