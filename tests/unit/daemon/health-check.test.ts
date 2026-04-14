import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probeHealth } from '../../../src/daemon/health-check.js';
import type { HealthProbeInput } from '../../../src/daemon/health-check.js';

function makeInput(overrides?: Partial<HealthProbeInput>): HealthProbeInput {
  return {
    backendStatus: null,
    browserPool: null,
    startedAt: Date.now() - 60000,
    ...overrides,
  };
}

describe('probeHealth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns status=healthy when backend is active and browser pool exists', () => {
    const report = probeHealth(makeInput({
      backendStatus: { isActive: true } as any,
      browserPool: {} as any,
    }));
    expect(report.status).toBe('healthy');
  });

  it('returns status=degraded when SearXNG backend is unhealthy', () => {
    const report = probeHealth(makeInput({
      backendStatus: { isActive: false } as any,
      browserPool: {} as any,
    }));
    expect(report.status).toBe('degraded');
  });

  it('returns status=degraded when backend is null (not yet bootstrapped)', () => {
    const report = probeHealth(makeInput({
      backendStatus: null,
      browserPool: {} as any,
    }));
    expect(report.status).toBe('degraded');
  });

  it('returns status=down when both backend and browser pool are null', () => {
    const report = probeHealth(makeInput({
      backendStatus: null,
      browserPool: null,
    }));
    expect(report.status).toBe('down');
  });

  it('includes searxng field', () => {
    const report = probeHealth(makeInput());
    expect(report).toHaveProperty('searxng');
    expect(typeof report.searxng).toBe('string');
  });

  it('searxng is "active" when backend is healthy', () => {
    const report = probeHealth(makeInput({
      backendStatus: { isActive: true } as any,
    }));
    expect(report.searxng).toBe('active');
  });

  it('searxng is "unavailable" when backend is unhealthy', () => {
    const report = probeHealth(makeInput({
      backendStatus: { isActive: false } as any,
    }));
    expect(report.searxng).toBe('unavailable');
  });

  it('searxng is "not_initialized" when backend is null', () => {
    const report = probeHealth(makeInput({
      backendStatus: null,
    }));
    expect(report.searxng).toBe('not_initialized');
  });

  it('includes browsers field', () => {
    const report = probeHealth(makeInput());
    expect(report).toHaveProperty('browsers');
    expect(typeof report.browsers).toBe('string');
  });

  it('browsers is "ready" when pool exists', () => {
    const report = probeHealth(makeInput({
      browserPool: {} as any,
    }));
    expect(report.browsers).toBe('ready');
  });

  it('browsers is "not_initialized" when pool is null', () => {
    const report = probeHealth(makeInput({
      browserPool: null,
    }));
    expect(report.browsers).toBe('not_initialized');
  });

  it('includes cache field', () => {
    const report = probeHealth(makeInput());
    expect(report).toHaveProperty('cache');
    expect(typeof report.cache).toBe('string');
  });

  it('includes uptime_seconds as a number', () => {
    const report = probeHealth(makeInput({
      startedAt: Date.now() - 120000,
    }));
    expect(report.uptime_seconds).toBeGreaterThanOrEqual(119);
    expect(report.uptime_seconds).toBeLessThanOrEqual(125);
  });

  it('uptime_seconds is 0 when startedAt is now', () => {
    const report = probeHealth(makeInput({
      startedAt: Date.now(),
    }));
    expect(report.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(report.uptime_seconds).toBeLessThanOrEqual(2);
  });

  it('returns correct HealthReport shape', () => {
    const report = probeHealth(makeInput());
    expect(report).toHaveProperty('status');
    expect(report).toHaveProperty('searxng');
    expect(report).toHaveProperty('browsers');
    expect(report).toHaveProperty('cache');
    expect(report).toHaveProperty('uptime_seconds');
    expect(['healthy', 'degraded', 'down']).toContain(report.status);
  });

  it('handles startedAt=0 gracefully', () => {
    const report = probeHealth(makeInput({
      startedAt: 0,
    }));
    expect(report.uptime_seconds).toBeGreaterThan(0);
  });
});
