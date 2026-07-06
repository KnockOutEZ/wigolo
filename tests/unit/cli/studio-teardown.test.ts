import { describe, it, expect } from 'vitest';
import { teardownStudioHost, type StudioTeardownTarget } from '../../../src/cli/studio.js';

// Spies for the injected module side-effects so the test never deletes the real
// ~/.wigolo handle or closes the shared browser.
const noopDeps = { removeHandle: () => {}, closeDaemonBrowser: async () => {} };

function makeHost(order: string[], overrides: Partial<StudioTeardownTarget> = {}): StudioTeardownTarget {
  return {
    idleSweeper: { stop: () => void order.push('idleSweeper.stop') },
    hub: { closeAll: () => void order.push('hub.closeAll') },
    navInterceptor: { stop: async () => void order.push('navInterceptor.stop') },
    sessionBrowser: { close: async () => void order.push('sessionBrowser.close') },
    registry: { closeAll: () => void order.push('registry.closeAll') },
    daemon: { stop: async () => void order.push('daemon.stop') },
    ...overrides,
  };
}

describe('teardownStudioHost', () => {
  it('PIN A (load-bearing order): navInterceptor.stop runs BEFORE sessionBrowser.close', async () => {
    // The nav interceptor issues CDP calls against the session browser, so it must stop while the browser is
    // still open. Reordering sessionBrowser.close ahead of it is a dirty teardown → this pin REDs.
    const order: string[] = [];
    await teardownStudioHost(makeHost(order), noopDeps);
    const browserClose = order.indexOf('sessionBrowser.close');
    expect(browserClose).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('navInterceptor.stop')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('navInterceptor.stop')).toBeLessThan(browserClose);
  });

  it('PIN B (isolation like safeSnapshot): one stage throwing does NOT abort the subsequent stages', async () => {
    // Remove a stage's .catch wrap and its rejection aborts the chain, leaking every later
    // stage's resources → this pin REDs.
    const order: string[] = [];
    const host = makeHost(order, { navInterceptor: { stop: async () => { throw new Error('boom'); } } });
    await teardownStudioHost(host, noopDeps);
    expect(order).toContain('sessionBrowser.close'); // a throwing navInterceptor.stop does not abort the later stages
    expect(order).toContain('registry.closeAll');
    expect(order).toContain('daemon.stop');
  });
});
