import type { BackendStatus } from '../server/backend-status.js';
import type { MultiBrowserPool } from '../fetch/browser-pool.js';

export interface HealthProbeInput {
  backendStatus: BackendStatus | null;
  browserPool: MultiBrowserPool | null;
  startedAt: number;
  /**
   * Real cache-DB liveness probe (e.g. a trivial SELECT). Absent ⇒ the cache is not
   * initialized; returns false ⇒ the DB is open but unreachable/erroring. Replaces the
   * former cosmetic hardcoded 'active'.
   */
  cacheProbe?: (() => boolean) | null;
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
  cache: 'active' | 'unavailable' | 'not_initialized';
  uptime_seconds: number;
}

export function probeHealth(input: HealthProbeInput): HealthReport {
  const uptimeMs = Date.now() - input.startedAt;
  const uptimeSeconds = Math.round(uptimeMs / 1000);

  const browsers: HealthReport['browsers'] = input.browserPool
    ? 'ready'
    : 'not_initialized';

  // Real cache-DB probe: absent ⇒ not initialized; a false return ⇒ open but unreachable.
  // Computed once here so BOTH the no-sidecar path below and the sidecar path report the
  // measured value — health must never report a cosmetic 'active' for a dead cache.
  let cache: HealthReport['cache'];
  if (input.cacheProbe == null) {
    cache = 'not_initialized';
  } else {
    cache = input.cacheProbe() ? 'active' : 'unavailable';
  }

  // D1: on the default core backend the sidecar is intentionally absent —
  // health derives entirely from the browser pool + cache. No browser pool is down;
  // browsers ready with a live cache is healthy; a ready pool over a sick cache is
  // degraded (it serves, but not everything works).
  if (!input.searxngConfigured) {
    let status: HealthReport['status'];
    if (browsers !== 'ready') {
      status = 'down';
    } else if (cache === 'active') {
      status = 'healthy';
    } else {
      status = 'degraded';
    }
    return {
      status,
      searxng: 'not_configured',
      browsers,
      cache,
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
  if (browsers === 'not_initialized' && searxng !== 'active') {
    status = 'down';
  } else if (searxng === 'active' && browsers === 'ready' && cache === 'active') {
    status = 'healthy';
  } else {
    status = 'degraded';
  }

  return {
    status,
    searxng,
    browsers,
    cache,
    uptime_seconds: uptimeSeconds,
  };
}
