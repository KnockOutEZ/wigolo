import { describe, it, expect, vi } from 'vitest';
import {
  LoginHandoff,
  meaningfulStorageDelta,
  type HandoffControlToken,
  type HandoffTimers,
  type HandoffCompletionContext,
  type LoginHandoffDeps,
} from '../../../src/studio/handoff.js';
import { StudioEventQueue } from '../../../src/studio/event-queue.js';
import type { StorageStateOut } from '../../../src/studio/session-browser.js';

// ── fakes ─────────────────────────────────────────────────────────────────────
// The real ControlToken satisfies HandoffControlToken structurally; this fake records
// reclaim/grant so a LOCKED-state mutation (a stray grant('agent')) is observable.
function fakeToken(initial: 'human' | 'agent' = 'agent') {
  const calls: string[] = [];
  let holder: 'human' | 'agent' = initial;
  return {
    get holder() {
      return holder;
    },
    reclaim() {
      calls.push('reclaim');
      holder = 'human';
    },
    grant(to: 'human' | 'agent') {
      calls.push('grant:' + to);
      holder = to;
    },
    calls,
  } satisfies HandoffControlToken & { calls: string[] };
}

// Manual timers: capture every setTimer(fn,ms) in creation order so a test fires the
// deadline (calls[0]) / poll (calls[1]) callback deterministically, and asserts clears.
function fakeTimers() {
  const calls: Array<{ handle: number; fn: () => void; ms: number }> = [];
  const cleared: number[] = [];
  let id = 0;
  const timers: HandoffTimers & { calls: typeof calls; cleared: number[] } = {
    setTimer(fn, ms) {
      const handle = ++id;
      calls.push({ handle, fn, ms });
      return handle;
    },
    clearTimer(h) {
      cleared.push(h as number);
    },
    calls,
    cleared,
  };
  return timers;
}

const cookie = (name: string, domain: string, value = 'v'): StorageStateOut['cookies'][number] => ({
  name,
  value,
  domain,
  path: '/',
  expires: -1,
  httpOnly: false,
  secure: false,
  sameSite: 'Lax',
});
const ss = (cookies: StorageStateOut['cookies'], origins: StorageStateOut['origins'] = []): StorageStateOut => ({ cookies, origins });
const lsOrigin = (origin: string, kv: Record<string, string>): StorageStateOut['origins'][number] => ({
  origin,
  localStorage: Object.entries(kv).map(([name, value]) => ({ name, value })),
});

const WALL_URL = 'https://acme.example/login';
const WALL_ORIGIN = 'https://acme.example';

interface SetupOver {
  token?: ReturnType<typeof fakeToken>;
  cred?: boolean; // is the live page a credential context (pageContext probe)
  storage?: StorageStateOut; // current storageState read-back
  currentUrl?: string | undefined;
  onComplete?: LoginHandoffDeps['onComplete'];
  timeoutMs?: number;
}
function setup(over: SetupOver = {}) {
  const token = over.token ?? fakeToken('agent');
  const queue = new StudioEventQueue(100);
  const timers = fakeTimers();
  const state = { cred: over.cred ?? true, storage: over.storage ?? ss([]) };
  const onComplete = over.onComplete ?? vi.fn();
  const recordAuthenticatedOrigin = vi.fn();
  const handoff = new LoginHandoff({
    controlToken: token,
    eventQueue: queue,
    pageContext: async () => state.cred,
    storageState: async () => state.storage,
    currentUrl: () => (over.currentUrl === undefined ? WALL_URL : over.currentUrl),
    onComplete,
    recordAuthenticatedOrigin,
    timeoutMs: over.timeoutMs ?? 60_000,
    timers,
  });
  return {
    handoff,
    token,
    queue,
    timers,
    onComplete,
    recordAuthenticatedOrigin,
    setCred: (c: boolean) => {
      state.cred = c;
    },
    setStorage: (s: StorageStateOut) => {
      state.storage = s;
    },
  };
}

// ── transitions ────────────────────────────────────────────────────────────────
describe('LoginHandoff — wall detection opens the human-holding window', () => {
  it('detectWall reclaims to the human, arms the timeout, captures a baseline, and signals in_progress', async () => {
    const { handoff, token, timers } = setup();
    expect(handoff.state).toBe('idle');
    expect(handoff.signal()).toBeNull();

    await handoff.detectWall();

    expect(token.calls).toEqual(['reclaim']); // RECLAIM — instant human takeover, the only token op on wall-detect
    expect(token.holder).toBe('human');
    expect(handoff.state).toBe('human-holding');
    expect(handoff.active).toBe(true);
    expect(handoff.signal()).toEqual({ state: 'in_progress', doNotRetry: true });
    expect(timers.calls.length).toBeGreaterThanOrEqual(1); // timeout (and poll) armed
    expect(timers.calls[0].ms).toBe(60_000); // the abort deadline
  });

  it('detectWall is idempotent — a second wall while already holding does NOT re-reclaim or re-arm', async () => {
    const { handoff, token, timers } = setup();
    await handoff.detectWall();
    const armed = timers.calls.length;
    await handoff.detectWall(); // already human-holding
    expect(token.calls).toEqual(['reclaim']); // not reclaimed twice
    expect(timers.calls.length).toBe(armed); // not re-armed
  });

  it('afterAgentAct opens the window ONLY when the agent was driving AND the post-act page is a credential context', async () => {
    // agent driving + credential page → detect
    const a = setup({ token: fakeToken('agent'), cred: true });
    await a.handoff.afterAgentAct();
    expect(a.handoff.state).toBe('human-holding');

    // agent driving + NON-credential page → no wall
    const b = setup({ token: fakeToken('agent'), cred: false });
    await b.handoff.afterAgentAct();
    expect(b.handoff.state).toBe('idle');
    expect(b.token.calls).toEqual([]); // never reclaimed

    // human already holds (the act was refused not_holder) + credential page → nothing to hand off
    const c = setup({ token: fakeToken('human'), cred: true });
    await c.handoff.afterAgentAct();
    expect(c.handoff.state).toBe('idle');
    expect(c.token.calls).toEqual([]);
  });
});

// ── completion detection: the AND gate ──────────────────────────────────────────
describe('LoginHandoff — completion detection requires BOTH (left credential context) AND (meaningful delta)', () => {
  it('left credential context + a NEW session cookie → completing: onComplete fires with the host storageState + wall origin', async () => {
    const onComplete = vi.fn();
    const s = setup({ onComplete, storage: ss([]) }); // baseline: no cookies
    await s.handoff.detectWall();
    s.setCred(false); // human finished login → page is no longer a credential context
    s.setStorage(ss([cookie('session', 'acme.example')])); // a real new cookie for the wall origin

    await s.handoff.checkCompletion();

    expect(s.handoff.state).toBe('completed');
    expect(s.handoff.signal()).toEqual({ state: 'completed' });
    expect(onComplete).toHaveBeenCalledTimes(1);
    const ctx = onComplete.mock.calls[0][0] as HandoffCompletionContext;
    expect(ctx.wallOrigin).toBe(WALL_ORIGIN);
    expect(ctx.storageState.cookies.some((c) => c.name === 'session')).toBe(true); // the host-side blob 5e-b will persist
  });

  it('left credential context but NO storageState delta → NOT complete (stays human-holding; onComplete never fires)', async () => {
    // MUTATION (drop the delta requirement — complete on left-context ALONE): an abandoned, no-auth
    // login that merely left the credential screen would complete → fire onComplete → 5e-b would
    // persist a no-auth session → both asserts RED. This pins the DELTA half of completion (L3-2 line 1),
    // distinct from Mutation 4 (which pins abort/vanish-no-hook).
    const onComplete = vi.fn();
    const s = setup({ onComplete, storage: ss([cookie('x', 'acme.example')]) });
    await s.handoff.detectWall(); // baseline captured WITH cookie x
    s.setCred(false); // left the credential screen…
    s.setStorage(ss([cookie('x', 'acme.example')])); // …but storage is unchanged (no new entry)

    await s.handoff.checkCompletion();

    expect(s.handoff.state).toBe('human-holding'); // not complete — an empty/unchanged delta never completes
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('still in a credential context (even WITH a delta) → NOT complete — the cred gate wins', async () => {
    const onComplete = vi.fn();
    const s = setup({ onComplete, storage: ss([]) });
    await s.handoff.detectWall();
    s.setCred(true); // still on a credential screen (a multi-step login)
    s.setStorage(ss([cookie('session', 'acme.example')])); // a delta exists…

    await s.handoff.checkCompletion();

    expect(s.handoff.state).toBe('human-holding'); // …but we have not left the credential context yet
    expect(onComplete).not.toHaveBeenCalled();
  });
});

// ── completion gates the hook (supports L3-2) ────────────────────────────────────
describe('LoginHandoff — onComplete fires ONLY on detected completion, never on abandon/timeout/vanish', () => {
  it('an abandoned login (timeout, no completion) does NOT fire onComplete', async () => {
    // MUTATION (fire-on-handoff-end, ignoring completion): make onTimeout invoke onComplete →
    // this abandoned login fires the hook → RED. The guard: only settleCompleted invokes it.
    const onComplete = vi.fn();
    const s = setup({ onComplete });
    await s.handoff.detectWall();
    s.handoff.onTimeout(); // deadline with no completion
    expect(s.handoff.state).toBe('aborted');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('a vanished client does NOT fire onComplete', async () => {
    const onComplete = vi.fn();
    const s = setup({ onComplete });
    await s.handoff.detectWall();
    s.handoff.onClientGone();
    expect(s.handoff.state).toBe('vanished');
    expect(onComplete).not.toHaveBeenCalled();
  });
});

// ── L3-3: vanish / timeout → LOCKED (no auto re-grant, hook not invoked) ──────────
describe('LoginHandoff — L3-3: a timeout or a vanish LOCKS the handoff (token stays human, NO re-grant)', () => {
  it('timeout → aborted + LOCKED: the token is NEVER granted to the agent, only the initial reclaim stands', async () => {
    // MUTATION (onTimeout → grant("agent")): the token flips to the agent on timeout → RED.
    const s = setup();
    await s.handoff.detectWall();
    s.handoff.onTimeout();
    expect(s.handoff.state).toBe('aborted');
    expect(s.handoff.signal()).toEqual({ state: 'failed' });
    expect(s.token.holder).toBe('human'); // stays human
    expect(s.token.calls).toEqual(['reclaim']); // NO grant('agent') — re-grant never fires from a timeout
  });

  it('onClientGone → vanished + LOCKED: the token is NEVER granted to the agent', async () => {
    // MUTATION (onClientGone → grant("agent")): the disconnect resumes the agent → RED.
    const s = setup();
    await s.handoff.detectWall();
    s.handoff.onClientGone();
    expect(s.handoff.state).toBe('vanished');
    expect(s.handoff.signal()).toEqual({ state: 'failed' });
    expect(s.token.holder).toBe('human');
    expect(s.token.calls).toEqual(['reclaim']); // NO grant('agent')
  });

  it('a settled terminal disarms the timers (the abort deadline + poll are cleared)', async () => {
    const s = setup();
    await s.handoff.detectWall();
    expect(s.timers.cleared).toEqual([]);
    s.handoff.onClientGone();
    expect(s.timers.cleared.length).toBeGreaterThanOrEqual(1); // timers cleared on settle
  });
});

// ── Phase 5e-c: the deferred re-grant — a detected completion hands the wheel back so the agent ──
// resumes driving the now-authenticated LIVE session. The grant is on the COMPLETING path ONLY;
// settleFailed (abort/vanish) NEVER grants (the L3-3 pins above stay green — validated by mutation).
describe('LoginHandoff — 5e-c: completion re-grants the agent (live-session continuity)', () => {
  it('a detected completion re-grants the agent → it resumes driving the now-authenticated session', async () => {
    // MUTATION (drop controlToken.grant('agent') from settleCompleted): completing no longer re-grants
    // → the agent stays locked out of the live authed session → RED. The re-grant is the completing fill.
    const s = setup({ storage: ss([]) });
    await s.handoff.detectWall();
    expect(s.token.holder).toBe('human'); // reclaimed to the human for the login

    s.setCred(false); // left the credential context…
    s.setStorage(ss([cookie('session', 'acme.example')])); // …with a real new wall-origin cookie

    await s.handoff.checkCompletion();

    expect(s.handoff.state).toBe('completed');
    expect(s.handoff.signal()).toEqual({ state: 'completed' }); // login_handoff:completed rides the next observe
    expect(s.token.calls).toEqual(['reclaim', 'grant:agent']); // the only token ops: wall reclaim, then completion re-grant
    expect(s.token.holder).toBe('agent'); // the agent holds again → resumes driving the live session
  });

  it('the re-grant fires strictly AFTER onComplete (the 5e-b persist) resolves — never before', async () => {
    // Ordering: while the persist is still in flight, the wheel must NOT have been handed back yet.
    // Explicit signals (no microtask guessing): `entered` fires when onComplete is reached; `persisting`
    // gates its resolution. So the assertion runs with onComplete provably mid-flight.
    let releasePersist!: () => void;
    const persisting = new Promise<void>((resolve) => { releasePersist = resolve; });
    let enteredPersist!: () => void;
    const entered = new Promise<void>((resolve) => { enteredPersist = resolve; });
    const onComplete = vi.fn(async () => { enteredPersist(); await persisting; });
    const s = setup({ onComplete, storage: ss([]) });
    await s.handoff.detectWall();
    s.setCred(false);
    s.setStorage(ss([cookie('session', 'acme.example')]));

    const completing = s.handoff.checkCompletion();
    await entered; // onComplete is now mid-flight (entered, awaiting the persist gate)
    expect(s.token.calls).not.toContain('grant:agent'); // persist still in flight → the wheel is NOT handed back yet

    releasePersist();
    await completing;
    expect(s.token.calls).toContain('grant:agent'); // …granted only AFTER onComplete resolved (await ordering)
  });

  it('a persist (onComplete) failure STILL re-grants the live session AND surfaces the failure (never silent)', async () => {
    // SEED decision: the live context is authenticated regardless of the persist write (persist = FUTURE
    // reuse). A transient disk/keychain failure must NOT strand the agent — the re-grant fires in `finally`.
    // The rejection is NOT swallowed (it propagates) so a persist failure can never be invisible.
    const onComplete = vi.fn(async () => { throw new Error('persist failed'); });
    const s = setup({ onComplete, storage: ss([]) });
    await s.handoff.detectWall();
    s.setCred(false);
    s.setStorage(ss([cookie('session', 'acme.example')]));

    await expect(s.handoff.checkCompletion()).rejects.toThrow('persist failed'); // surfaced, not swallowed
    expect(s.token.calls).toContain('grant:agent'); // …and the live session was STILL handed back (continuity)
    expect(s.token.holder).toBe('agent');
  });

  it('idempotent: two completion checks re-grant the agent EXACTLY once (no double-grant / re-entry)', async () => {
    // MUTATION (drop the `state !== human-holding` guard in checkCompletion): the second check re-enters
    // settleCompleted → a SECOND grant('agent') → RED. The state guard makes completion settle exactly once.
    const s = setup({ storage: ss([]) });
    await s.handoff.detectWall();
    s.setCred(false);
    s.setStorage(ss([cookie('session', 'acme.example')]));

    await s.handoff.checkCompletion();
    await s.handoff.checkCompletion(); // second check — already 'completed'

    expect(s.token.calls.filter((c) => c === 'grant:agent').length).toBe(1);
  });
});

// ── re-grant only from completing OR an explicit human WS grant — never disconnect/timeout ──
describe('LoginHandoff — onControlChange: an explicit human grant-to-agent ends the window; the machine itself never grants', () => {
  it('a human WS grant to the agent (holder flips to agent) ends the window without firing onComplete', async () => {
    const onComplete = vi.fn();
    const s = setup({ onComplete });
    await s.handoff.detectWall();
    expect(s.handoff.active).toBe(true);
    s.handoff.onControlChange('agent'); // the human chose to hand back to the agent
    expect(s.handoff.state).toBe('idle'); // window ended
    expect(s.handoff.signal()).toBeNull();
    expect(onComplete).not.toHaveBeenCalled(); // manual hand-back is not a detected completion
    expect(s.timers.cleared.length).toBeGreaterThanOrEqual(1); // disarmed
  });

  it('onControlChange(human) during the window is a no-op (the machine\'s own reclaim must not end the window)', async () => {
    const s = setup();
    await s.handoff.detectWall();
    s.handoff.onControlChange('human');
    expect(s.handoff.state).toBe('human-holding'); // still holding for the login
  });
});

// ── L-5e0-1: content events generated during the window are DROPPED at source ────
describe('LoginHandoff — L-5e0-1: content events during the window are dropped (never enqueued); the signal IS delivered', () => {
  it('a mark made during the window (a displayed secret in its name) never enters the queue — not now, not on a later drain', async () => {
    // MUTATION (enqueueContentEvent ignores `active` and always enqueues): the secret-named mark
    // enters the queue → leaks on the post-window drain → RED.
    const s = setup();
    await s.handoff.detectWall();
    expect(s.handoff.active).toBe(true);

    s.handoff.enqueueContentEvent({ type: 'mark', markId: 'm1', name: '123456', role: 'link' }); // secret name
    s.handoff.enqueueContentEvent({ type: 'navigation', url: 'https://acme.example/login/step2' });
    expect(s.queue.pending).toBe(0); // dropped at source — never buffered, so a long login can't accumulate them

    // End the window, then drain as the agent would post-handoff: the window content is GONE.
    s.handoff.onClientGone();
    const drained = s.queue.drainSince(0);
    expect(JSON.stringify(drained.events)).not.toContain('123456'); // the secret never reaches the agent
    expect(drained.events).toEqual([]);
  });

  it('outside the window (idle) enqueueContentEvent is a pass-through — normal human events still reach the agent', async () => {
    const s = setup();
    expect(s.handoff.active).toBe(false);
    s.handoff.enqueueContentEvent({ type: 'navigation', url: 'https://example.com/' });
    expect(s.queue.pending).toBe(1); // normal browsing event delivered as before
  });

  it('the login_handoff signal IS delivered during the window (so the agent waits, does not retry)', async () => {
    const s = setup();
    await s.handoff.detectWall();
    expect(s.handoff.signal()).toEqual({ state: 'in_progress', doNotRetry: true });
  });
});

// ── the bounded poll wires to checkCompletion + the deadline wires to onTimeout ──
describe('LoginHandoff — armed timers drive the right transitions', () => {
  it('the armed deadline callback drives onTimeout (→ aborted)', async () => {
    const s = setup();
    await s.handoff.detectWall();
    s.timers.calls[0].fn(); // fire the deadline
    expect(s.handoff.state).toBe('aborted');
  });

  it('the bounded poll callback drives a completion check (a poll tick can complete a no-nav SPA login)', async () => {
    const s = setup({ storage: ss([]) });
    await s.handoff.detectWall();
    s.setCred(false);
    s.setStorage(ss([cookie('session', 'acme.example')]));
    // calls[1] is the poll (calls[0] is the deadline); firing it runs checkCompletion.
    s.timers.calls[1].fn();
    await Promise.resolve(); // let the async check settle
    await Promise.resolve();
    expect(s.handoff.state).toBe('completed');
  });
});

// ── the conservative storageState delta ─────────────────────────────────────────
describe('meaningfulStorageDelta — conservative: a real NEW entry, scoped to the wall origin', () => {
  it('a NEW cookie for the wall origin → delta', () => {
    expect(meaningfulStorageDelta(ss([]), ss([cookie('session', 'acme.example')]), WALL_ORIGIN)).toBe(true);
  });
  it('a leading-dot cookie domain matching the wall host → delta', () => {
    expect(meaningfulStorageDelta(ss([]), ss([cookie('session', '.acme.example')]), WALL_ORIGIN)).toBe(true);
  });
  it('identical storage → NO delta (an unchanged read never completes)', () => {
    const base = ss([cookie('x', 'acme.example')]);
    expect(meaningfulStorageDelta(base, ss([cookie('x', 'acme.example')]), WALL_ORIGIN)).toBe(false);
  });
  it('a NEW cookie for a DIFFERENT origin (e.g. an analytics domain) is scoped out → NO delta', () => {
    expect(meaningfulStorageDelta(ss([]), ss([cookie('ga', 'tracker.example')]), WALL_ORIGIN)).toBe(false);
  });
  it('a value change on an EXISTING cookie is not an addition → NO delta (conservative)', () => {
    const base = ss([cookie('x', 'acme.example', 'old')]);
    expect(meaningfulStorageDelta(base, ss([cookie('x', 'acme.example', 'new')]), WALL_ORIGIN)).toBe(false);
  });
  it('a NEW localStorage key for the wall origin → delta', () => {
    const base = ss([], [lsOrigin(WALL_ORIGIN, {})]);
    expect(meaningfulStorageDelta(base, ss([], [lsOrigin(WALL_ORIGIN, { token: 'abc' })]), WALL_ORIGIN)).toBe(true);
  });
  it('with an UNKNOWN wall origin, any new cookie counts (fail-open to detecting the login)', () => {
    expect(meaningfulStorageDelta(ss([]), ss([cookie('session', 'whatever.example')]), undefined)).toBe(true);
  });
});

// ── S9 / F5 clause (a): the ledger write on the COMPLETING terminal ──────────────
describe('LoginHandoff — records the wall origin in the authenticated-origin ledger', () => {
  it('records on COMPLETING — this is the one moment the host KNOWS a human logged in', async () => {
    const s = setup({ storage: ss([]) });
    await s.handoff.detectWall();
    s.setCred(false);
    s.setStorage(ss([cookie('session', 'acme.example')]));

    await s.handoff.checkCompletion();

    expect(s.handoff.state).toBe('completed');
    expect(s.recordAuthenticatedOrigin).toHaveBeenCalledWith(WALL_ORIGIN);
  });

  it('does NOT record on a LOCKED terminal — an abandoned login is not a login', async () => {
    const s = setup();
    await s.handoff.detectWall();
    s.handoff.onTimeout(); // deadline passes with no completion → aborted 🔒
    expect(s.handoff.state).toBe('aborted');
    expect(s.recordAuthenticatedOrigin).not.toHaveBeenCalled();
  });

  it('a throwing ledger writer never strands the agent mid-handoff — the re-grant still happens', async () => {
    // The ledger is a convenience that makes a future card fire; the live session is authenticated either
    // way. Letting a disk error abort settleCompleted would leave the human logged in and the agent frozen.
    const s = setup({ storage: ss([]) });
    s.recordAuthenticatedOrigin.mockImplementation(() => { throw new Error('disk full'); });
    await s.handoff.detectWall();
    s.setCred(false);
    s.setStorage(ss([cookie('session', 'acme.example')]));

    await s.handoff.checkCompletion();

    expect(s.handoff.state).toBe('completed');
    expect(s.token.holder).toBe('agent'); // 5e-c re-grant survived the ledger failure
  });
});
