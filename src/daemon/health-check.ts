import type { BackendStatus } from '../server/backend-status.js';
import type { MultiBrowserPool } from '../fetch/browser-pool.js';

export interface HealthProbeInput {
  backendStatus: BackendStatus | null;
  browserPool: MultiBrowserPool | null;
  startedAt: number;
}

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'down';
  searxng: 'active' | 'unavailable' | 'not_initialized';
  browsers: 'ready' | 'not_initialized';
  cache: 'active' | 'not_initialized';
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

  const cache: HealthReport['cache'] = 'active';

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
    uptime_seconds: uptimeSeconds,
  };
}
