import { describe, it, expect } from 'vitest';
import { LoginHandoff, type LoginHandoffDeps } from '../../../src/studio/handoff.js';
import type { StorageStateOut } from '../../../src/studio/session-browser.js';

const EMPTY: StorageStateOut = { cookies: [], origins: [] };

function deps(over: Partial<LoginHandoffDeps> = {}): LoginHandoffDeps {
  let holder: 'human' | 'agent' = 'agent';
  return {
    controlToken: {
      get holder() {
        return holder;
      },
      reclaim: () => {
        holder = 'human';
      },
      grant: (to) => {
        holder = to;
      },
    },
    eventQueue: { enqueue: () => {} },
    pageContext: async () => true, // a credential context (wall present)
    storageState: async () => EMPTY,
    currentUrl: () => 'https://example.com/login',
    timers: { setTimer: () => 0, clearTimer: () => {} }, // inert timers — drive transitions manually
    ...over,
  };
}

describe('LoginHandoff onSignalChange', () => {
  it('fires in_progress on wall-detect (detectWall site)', async () => {
    const seen: (string | null)[] = [];
    const h = new LoginHandoff(deps({ onSignalChange: (s) => seen.push(s ? s.state : null) }));
    await h.afterAgentAct(); // agent-driving + credential context → detectWall → in_progress
    expect(seen).toEqual(['in_progress']);
    expect(h.state).toBe('human-holding');
  });

  it('fires completed on a detected completion (settleCompleted site)', async () => {
    const seen: (string | null)[] = [];
    let credential = true; // credential context until "login" finishes
    let reads = 0; // baseline (read #1 at detectWall) is EMPTY; post-login reads carry the sid cookie → a real delta
    const sid = {
      name: 'sid',
      value: 'x',
      domain: 'example.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
    };
    const h = new LoginHandoff(
      deps({
        onSignalChange: (s) => seen.push(s ? s.state : null),
        pageContext: async () => credential,
        storageState: async () => ({ cookies: ++reads === 1 ? [] : [sid], origins: [] }),
      }),
    );
    await h.detectWall(); // baseline read #1 → [] (no sid yet), signal in_progress
    credential = false; // human finished: left the credential context
    await h.checkCompletion(); // read #2 → [sid]; AND-gate (left credential ctx + meaningful delta) → completed
    expect(seen).toEqual(['in_progress', 'completed']);
    expect(h.state).toBe('completed');
  });

  it('fires failed on the abort deadline (settleFailed site)', async () => {
    const seen: string[] = [];
    const h = new LoginHandoff(deps({ onSignalChange: (s) => { if (s) seen.push(s.state); } }));
    await h.detectWall();
    h.onTimeout();
    expect(seen).toEqual(['in_progress', 'failed']);
    expect(h.state).toBe('aborted');
  });

  it('fires null when the human hands control back mid-window (onControlChange site)', async () => {
    const seen: (string | null)[] = [];
    const h = new LoginHandoff(deps({ onSignalChange: (s) => seen.push(s ? s.state : null) }));
    await h.detectWall(); // in_progress
    h.onControlChange('agent'); // explicit human grant back → window ends WITHOUT completion → signal null
    expect(seen).toEqual(['in_progress', null]);
    expect(h.state).toBe('idle');
  });

  it('is optional — omitting it never throws', async () => {
    const h = new LoginHandoff(deps());
    await expect(h.detectWall()).resolves.toBeUndefined();
  });
});
