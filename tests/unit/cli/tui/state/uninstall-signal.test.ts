import { describe, it, expect, beforeEach, vi } from 'vitest';

// The signal is a process-scoped module singleton with no reset export, so each
// test re-imports a fresh module instance to assert state in isolation.
describe('uninstall-signal', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults to not-uninstalled on a fresh process', async () => {
    const { wasUninstalled } = await import('../../../../../src/cli/tui/state/uninstall-signal.js');
    expect(wasUninstalled()).toBe(false);
  });

  it('reports uninstalled after signalUninstall()', async () => {
    const { signalUninstall, wasUninstalled } = await import('../../../../../src/cli/tui/state/uninstall-signal.js');
    expect(wasUninstalled()).toBe(false);
    signalUninstall();
    expect(wasUninstalled()).toBe(true);
  });

  it('does not leak the signal into a fresh module load', async () => {
    // A new `wigolo init` process must start with no signal so warmup runs
    // normally — the skip only applies within the session that uninstalled.
    const first = await import('../../../../../src/cli/tui/state/uninstall-signal.js');
    first.signalUninstall();
    expect(first.wasUninstalled()).toBe(true);

    vi.resetModules();
    const second = await import('../../../../../src/cli/tui/state/uninstall-signal.js');
    expect(second.wasUninstalled()).toBe(false);
  });
});
