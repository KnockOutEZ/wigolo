import { describe, it, expect } from 'vitest';
import { BackendStatus } from '../../../src/server/backend-status.js';

describe('BackendStatus', () => {
  it('starts inactive', () => {
    const s = new BackendStatus();
    expect(s.isActive).toBe(false);
  });

  it('consumeWarning returns text once, then undefined', () => {
    const s = new BackendStatus();
    s.markUnhealthy('SearXNG /healthz unreachable');
    const first = s.consumeWarning();
    expect(first).toBeDefined();
    expect(first).toContain('SearXNG');
    expect(first).toContain('warmup --force');
    expect(first).toContain('doctor');
    expect(first).toContain('SearXNG /healthz unreachable');
    expect(s.consumeWarning()).toBeUndefined();
  });

  it('markHealthy then markUnhealthy resets one-shot', () => {
    const s = new BackendStatus();
    s.markUnhealthy('reason 1');
    expect(s.consumeWarning()).toBeDefined();
    expect(s.consumeWarning()).toBeUndefined();

    s.markHealthy();
    s.markUnhealthy('reason 2');
    const next = s.consumeWarning();
    expect(next).toBeDefined();
    expect(next).toContain('reason 2');
  });

  it('consumeWarning returns undefined when active', () => {
    const s = new BackendStatus();
    s.markHealthy();
    expect(s.consumeWarning()).toBeUndefined();
  });

  it('markHealthy makes isActive true', () => {
    const s = new BackendStatus();
    s.markHealthy();
    expect(s.isActive).toBe(true);
  });
});
