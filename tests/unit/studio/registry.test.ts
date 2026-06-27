import { describe, it, expect } from 'vitest';
import { SessionRegistry, startIdleSweeper } from '../../../src/studio/registry.js';
import { sessionMeta, type SessionMeta } from '../../../src/studio/session.js';

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

  it('the WIRED sweep tick fires the sessions delta WITHOUT the evicted clientless session (no switcher ghost)', () => {
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, now: () => t, maxSessions: 10 });
    // Mirror the production onChange closure (studio.ts: hub.broadcastAll({t:'sessions', sessions: list().map(sessionMeta)})).
    const deltas: SessionMeta[][] = [];
    reg.onChange = () => deltas.push(reg.list().map(sessionMeta));
    const ghost = reg.create({ endpoint: 'ghost' }); // clientless
    const live = reg.create({ endpoint: 'live' });
    live.attach(); // a connected client elsewhere
    let tick: (() => void) | undefined;
    const sweeper = startIdleSweeper(reg, 500, {
      schedule: (cb) => {
        tick = cb;
        return () => { tick = undefined; };
      },
    });
    t = 2000; // ghost is now idle past idleMs
    deltas.length = 0; // ignore create-time deltas; focus on the sweep
    tick?.(); // wired tick → sweepIdle evicts ghost → MUST fire onChange so the switcher list refreshes
    expect(deltas.length).toBeGreaterThan(0); // the sweep fired a switcher delta (no ghost lingering)
    const lastIds = deltas.at(-1)!.map((m) => m.id);
    expect(lastIds).not.toContain(ghost.id); // evicted session is gone from the broadcast list
    expect(lastIds).toContain(live.id); // the live session is retained
    sweeper.stop();
  });

  // ── S4: background keep-alive (all driven through the REAL wired sweepIdle tick) ──
  // A helper that wires the real lifecycle tick (not a direct sweepIdle call), mirroring the harness above.
  function wireTick(reg: SessionRegistry) {
    let tick: (() => void) | undefined;
    const sweeper = startIdleSweeper(reg, 500, { schedule: (cb) => { tick = cb; return () => { tick = undefined; }; } });
    return { fire: () => tick?.(), stop: () => sweeper.stop() };
  }

  // S4 PIN — clientless + keepAlive + WITHIN max-lifetime SURVIVES the idle sweep. Mutation that REDs:
  // drop the `!keepAlive` term from the idle condition → the keepAlive session evicts on idle → RED (survives vs evicted).
  it('S4: a clientless keepAlive session WITHIN max-lifetime survives the wired sweep (idle does not evict it)', () => {
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, backgroundMaxMs: 100_000, now: () => t, maxSessions: 10 });
    const bg = reg.create({ endpoint: 'bg' });
    bg.setKeepAlive(true);
    const w = wireTick(reg);
    t = 2000; // idle past idleMs (1000) but well within backgroundMaxMs (100000), clientless
    w.fire();
    expect(reg.get(bg.id)).toBe(bg); // SURVIVES — keepAlive lifts idle eviction
    expect(bg.status).not.toBe('closed');
    w.stop();
  });

  // S4 PIN — clientless + !keepAlive STILL EVICTS on idle (default behavior unchanged). Mutation that REDs:
  // flip the keepAlive DEFAULT to true → a normal clientless session wrongly survives → RED (evicted vs survives).
  it('S4: a normal clientless (!keepAlive) session still evicts on idle; keepAlive defaults OFF', () => {
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, backgroundMaxMs: 100_000, now: () => t, maxSessions: 10 });
    const normal = reg.create({ endpoint: 'n' });
    expect(normal.keepAlive).toBe(false); // default OFF — the keepAlive-default→true mutation reds this AND the eviction below
    const w = wireTick(reg);
    t = 2000;
    w.fire();
    expect(reg.get(normal.id)).toBeUndefined(); // evicted — unchanged idle behavior
    expect(normal.status).toBe('closed');
    w.stop();
  });

  // S4 PIN — clientless + keepAlive + PAST max-lifetime IS EVICTED by the backstop (abandoned-session leak guard).
  // Mutation that REDs: remove the backstop (backstopEvict) → the keepAlive session leaks forever → RED (evicted vs survives).
  it('S4: a clientless keepAlive session PAST max-lifetime is evicted by the backstop', () => {
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, backgroundMaxMs: 100_000, now: () => t, maxSessions: 10 });
    const bg = reg.create({ endpoint: 'bg' });
    bg.setKeepAlive(true);
    const w = wireTick(reg);
    t = 200_000; // past backgroundMaxMs (100000) since createdAt=0 → abandoned background session
    w.fire();
    expect(reg.get(bg.id)).toBeUndefined(); // backstop evicts even a keepAlive session
    expect(bg.status).toBe('closed');
    w.stop();
  });

  // S4 PIN (F1c stays GREEN) — a client-attached keepAlive session past BOTH clocks STILL survives (the clients===0
  // first term is never weakened). Mutation that REDs: weaken the `clients !== 0` guard → an attached session evicts → RED.
  it('S4: a client-attached session past idle AND max-lifetime still survives (F1c attached-guard intact)', () => {
    let t = 0;
    const reg = new SessionRegistry({ idleMs: 1000, backgroundMaxMs: 100_000, now: () => t, maxSessions: 10 });
    const attached = reg.create({ endpoint: 'attached' });
    attached.setKeepAlive(true);
    attached.attach(); // a client is connected
    const w = wireTick(reg);
    t = 1_000_000; // far past both clocks
    w.fire();
    expect(reg.get(attached.id)).toBe(attached); // SURVIVES — attached guard unchanged
    expect(attached.status).not.toBe('closed');
    w.stop();
  });
});
