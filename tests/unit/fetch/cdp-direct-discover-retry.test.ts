import { describe, it, expect } from 'vitest';
import { discoverPageTargetWithRetry } from '../../../src/fetch/cdp-direct.js';

// WHY: Chrome exposes the HTTP debug port BEFORE its first page target registers
// (~1-2s gap on Chrome 150). A single-shot discover races that gap and finds
// nothing, making the rung fall back on every fresh spawn. The poll survives it.
// Injected clock/discover keep it deterministic.
describe('discoverPageTargetWithRetry', () => {
  it('polls until a page target registers (closes the spawn→discover race)', async () => {
    let t = 0;
    let calls = 0;
    const target = await discoverPageTargetWithRetry({
      discover: async () => {
        calls++;
        return calls < 3 ? [] : [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/ABC' }];
      },
      sleep: async (ms) => { t += ms; },
      now: () => t,
      deadlineMs: 6000,
      intervalMs: 250,
    });
    expect(target).toBe('ws://127.0.0.1:9/devtools/page/ABC');
    expect(calls).toBe(3);
  });

  it('returns null when no target registers within the budget (graceful fallback)', async () => {
    let t = 0;
    let calls = 0;
    const target = await discoverPageTargetWithRetry({
      discover: async () => { calls++; return []; },
      sleep: async (ms) => { t += ms; },
      now: () => t,
      deadlineMs: 1000,
      intervalMs: 250,
    });
    expect(target).toBeNull();
    expect(calls).toBeGreaterThan(1);
  });

  it('aborts promptly on an already-aborted signal (no discover)', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const target = await discoverPageTargetWithRetry({
      discover: async () => { calls++; return [{ webSocketDebuggerUrl: 'ws://x' }]; },
      sleep: async () => {},
      now: () => 0,
      signal: ac.signal,
    });
    expect(target).toBeNull();
    expect(calls).toBe(0);
  });
});
