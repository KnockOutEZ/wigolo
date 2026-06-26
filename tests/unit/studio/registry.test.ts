import { describe, it, expect } from 'vitest';
import { SessionRegistry, startIdleSweeper } from '../../../src/studio/registry.js';

describe('studio/SessionRegistry', () => {
  it('create/get/list round-trips a session', () => {
    const reg = new SessionRegistry();
    const s = reg.create({ endpoint: 'http://127.0.0.1:7777' });
    expect(reg.get(s.id)).toBe(s);
    expect(reg.list()).toContain(s);
    expect(reg.size).toBe(1);
  });

  it('active() returns the sole open session; undefined when none or ambiguous', () => {
    const reg = new SessionRegistry();
    expect(reg.active()).toBeUndefined();
    const s1 = reg.create({ endpoint: 'e1' });
    expect(reg.active()).toBe(s1);
    reg.create({ endpoint: 'e2' });
    expect(reg.active()).toBeUndefined(); // two open → caller must pass session_id
  });

  it('close removes a session and marks it closed; closeAll empties and closes each', () => {
    const reg = new SessionRegistry();
    const s1 = reg.create({ endpoint: 'e1' });
    const s2 = reg.create({ endpoint: 'e2' });
    reg.close(s1.id);
    expect(reg.get(s1.id)).toBeUndefined();
    expect(s1.status).toBe('closed');
    reg.closeAll();
    expect(reg.size).toBe(0);
    expect(s2.status).toBe('closed');
  });

  it('sweepIdle evicts only clientless sessions idle past idleMs', () => {
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, now: () => t });
    const idle = reg.create({ endpoint: 'idle' });
    const busy = reg.create({ endpoint: 'busy' });
    busy.attach(); // a client is attached → must not be evicted
    t = 2000; // both are now 2000ms old (> 1000 idleMs)
    const evicted = reg.sweepIdle();
    expect(evicted).toEqual([idle.id]);
    expect(reg.get(idle.id)).toBeUndefined();
    expect(idle.status).toBe('closed');
    expect(reg.get(busy.id)).toBe(busy);
  });

  it('sweepIdle keeps a recently-touched session', () => {
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, now: () => t });
    const s = reg.create({ endpoint: 'e' });
    t = 500;
    s.touch();
    t = 1200; // age 700 < 1000
    expect(reg.sweepIdle()).toEqual([]);
    expect(reg.get(s.id)).toBe(s);
  });

  it('rejects create over maxSessions with studio_session_limit; flipping the cap admits the same Nth', () => {
    // max=N: N creates succeed, the (N+1)th is rejected by the named admission error.
    const cap = new SessionRegistry({ maxSessions: 2 });
    cap.create({ endpoint: 'e1' });
    cap.create({ endpoint: 'e2' });
    let err: unknown;
    try {
      cap.create({ endpoint: 'e3' });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string } | undefined)?.code).toBe('studio_session_limit');
    expect(cap.size).toBe(2); // over-cap create did NOT admit

    // Flip max=N+1: the SAME 3rd create now succeeds — diverging value proves the cap is the gate.
    const wider = new SessionRegistry({ maxSessions: 3 });
    wider.create({ endpoint: 'e1' });
    wider.create({ endpoint: 'e2' });
    const third = wider.create({ endpoint: 'e3' });
    expect(wider.size).toBe(3);
    expect(third.id).toBeTruthy();
  });

  it('the WIRED idle sweeper evicts an idle clientless session on its lifecycle tick', () => {
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, now: () => t, maxSessions: 10 });
    const s = reg.create({ endpoint: 'e' });
    // Capture the scheduled tick instead of a wall-clock timer so we fire the REAL
    // lifecycle callback (not a direct reg.sweepIdle() call) deterministically.
    let tick: (() => void) | undefined;
    const sweeper = startIdleSweeper(reg, 500, {
      schedule: (cb) => {
        tick = cb;
        return () => { tick = undefined; };
      },
    });
    t = 2000; // session is now 2000ms idle (> 1000 idleMs), clientless
    tick?.(); // the wired tick fires → must evict via sweepIdle
    expect(reg.get(s.id)).toBeUndefined();
    expect(s.status).toBe('closed');
    sweeper.stop();
  });

  it('the WIRED sweeper NEVER evicts a client-attached session, however old (dangerous-direction invariant)', () => {
    // Load-bearing safety pin: a connected human/agent client must survive the sweep regardless of age.
    // Driven through the WIRED tick (not a direct sweepIdle call). NON-VACUITY: drop the clientless guard
    // in sweepIdle → this old attached session is evicted → RED (evicted vs survives).
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, now: () => t, maxSessions: 10 });
    const attached = reg.create({ endpoint: 'attached' });
    attached.attach(); // a client is connected
    let tick: (() => void) | undefined;
    const sweeper = startIdleSweeper(reg, 500, {
      schedule: (cb) => {
        tick = cb;
        return () => { tick = undefined; };
      },
    });
    t = 1_000_000; // absurdly old — far past idleMs, yet a client is attached
    tick?.(); // wired lifecycle tick fires
    expect(reg.get(attached.id)).toBe(attached); // SURVIVES — never evicted while a client is attached
    expect(attached.status).not.toBe('closed');
    sweeper.stop();
  });
});
