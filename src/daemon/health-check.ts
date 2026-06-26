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
}

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'down';
  searxng: 'active' | 'unavailable' | 'not_initialized';
  browsers: 'ready' | 'not_initialized';
  cache: 'active' | 'unavailable' | 'not_initialized';
  uptime_seconds: number;
}

export function probeHealth(input: HealthProbeInput): HealthReport {
  const uptimeMs = Date.now() - input.startedAt;
  const uptimeSeconds = Math.round(uptimeMs / 1000);

  let searxng: HealthReport['searxng'];
  if (input.backendStatus === null) {
    searxng = 'not_initialized';
  } else if (input.backendStatus.isActive) {
    searxng = 'active';
  } else {
    searxng = 'unavailable';
  }

  const browsers: HealthReport['browsers'] = input.browserPool
    ? 'ready'
    : 'not_initialized';

  // Real cache-DB probe: absent ⇒ not initialized; a false return ⇒ open but unreachable.
  let cache: HealthReport['cache'];
  if (input.cacheProbe == null) {
    cache = 'not_initialized';
  } else {
    cache = input.cacheProbe() ? 'active' : 'unavailable';
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
