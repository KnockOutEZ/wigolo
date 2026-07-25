import type { BackendStatus } from '../server/backend-status.js';
import type { MultiBrowserPool } from '../fetch/browser-pool.js';
import { getEmbedderStatus, type EmbedderState } from '../embedding/embedder-status.js';

export interface HealthProbeInput {
  backendStatus: BackendStatus | null;
  browserPool: MultiBrowserPool | null;
  startedAt: number;
  /**
   * Whether the search-engine sidecar is opted into (searxng/hybrid backend or
   * external URL). D1: when false, the default core backend is in use — the
   * sidecar is intentionally absent, so it reports `not_configured` and overall
   * health derives from the browser pool + cache, not from the sidecar.
   */
  searxngConfigured: boolean;
}

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'down';
  searxng: 'active' | 'unavailable' | 'not_initialized' | 'not_configured';
  browsers: 'ready' | 'not_initialized';
  cache: 'active' | 'not_initialized';
  /**
   * Vector-ranking availability. `unknown` until something first needs the
   * model (it loads lazily on first use, so a freshly started daemon has not
   * probed it yet). `unavailable` means search is running without vector
   * signals — the container-level failure that #231 made reportable.
   *
   * It deliberately does NOT drive `status`: the product still answers
   * correctly without embeddings, so this is a quality signal, not an outage.
   */
  embedder: EmbedderState;
  uptime_seconds: number;
}

export function probeHealth(input: HealthProbeInput): HealthReport {
  const uptimeMs = Date.now() - input.startedAt;
  const uptimeSeconds = Math.round(uptimeMs / 1000);

  const browsers: HealthReport['browsers'] = input.browserPool
    ? 'ready'
    : 'not_initialized';

  const cache: HealthReport['cache'] = 'active';

  const embedder = getEmbedderStatus().state;

  // D1: on the default core backend the sidecar is intentionally absent —
  // health derives entirely from the browser pool + cache. A default daemon
  // with browsers ready is healthy; with no browser pool it is down.
  if (!input.searxngConfigured) {
    const status: HealthReport['status'] = browsers === 'ready' ? 'healthy' : 'down';
    return {
      status,
      searxng: 'not_configured',
      browsers,
      cache,
      embedder,
      uptime_seconds: uptimeSeconds,
    };
  }

  let searxng: HealthReport['searxng'];
  if (input.backendStatus === null) {
    searxng = 'not_initialized';
  } else if (input.backendStatus.isActive) {
    searxng = 'active';
  } else {
    searxng = 'unavailable';
  }

  let status: HealthReport['status'];
  if (searxng === 'active' && browsers === 'ready') {
    status = 'healthy';
  } else if (browsers === 'not_initialized' && searxng !== 'active') {
    status = 'down';
  } else {
    status = 'degraded';
  }

  return {
    status,
    searxng,
    browsers,
    cache,
    embedder,
    uptime_seconds: uptimeSeconds,
  };
}
