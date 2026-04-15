import { describe, it, expect } from 'vitest';
import { BackendStatus } from '../../../src/server/backend-status.js';

describe('BackendStatus — bootstrapping warning', () => {
  it('markBootstrapping surfaces a startup-specific warning', () => {
    const s = new BackendStatus();
    s.markBootstrapping();
    const warning = s.consumeWarning();
    expect(warning).toBeDefined();
    expect(warning!).toMatch(/starting up/i);
    expect(warning!).toMatch(/warmup --all/);
  });

  it('bootstrapping warning distinguishes from failure warning', () => {
    const bootstrapping = new BackendStatus();
    bootstrapping.markBootstrapping();
    const failed = new BackendStatus();
    failed.markUnhealthy('SearXNG bootstrap failed');

    const bw = bootstrapping.consumeWarning()!;
    const fw = failed.consumeWarning()!;

    expect(bw).not.toBe(fw);
    expect(bw).toMatch(/starting up/i);
    expect(fw).toMatch(/unavailable/i);
  });

  it('bootstrapping warning is one-shot', () => {
    const s = new BackendStatus();
    s.markBootstrapping();
    expect(s.consumeWarning()).toBeDefined();
    expect(s.consumeWarning()).toBeUndefined();
  });

  it('markHealthy clears bootstrapping state', () => {
    const s = new BackendStatus();
    s.markBootstrapping();
    s.markHealthy();
    expect(s.isActive).toBe(true);
    expect(s.consumeWarning()).toBeUndefined();
  });

  it('markBootstrapping keeps isActive false', () => {
    const s = new BackendStatus();
    s.markBootstrapping();
    expect(s.isActive).toBe(false);
  });
});
