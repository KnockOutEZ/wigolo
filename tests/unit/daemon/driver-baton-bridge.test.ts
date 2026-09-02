import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { createRunWithTail, runEventListenerCount } from '../../../src/studio/run-bus.js';
import { eventsSince, getRun, type Driver, type Run } from '../../../src/studio/run-store.js';
import { ControlToken } from '../../../src/studio/control-token.js';
import { grantWheel, releaseWheel, requestWheel, takeWheel } from '../../../src/daemon/driver-baton.js';
import { createBatonTokenBridge, toControlParty, type BatonTokenBridge } from '../../../src/daemon/driver-baton-bridge.js';

/**
 * SD2 §1.6 — the baton sits ABOVE the control token and delegates to it (A-51-1).
 *
 * The two answer different questions: the baton says who has authority over a RUN, the token says
 * whose keystrokes reach a SESSION right now. This file is about the one-way projection between
 * them and the one-way reflection back, and about the thing that ruling buys — the token's fence,
 * its epoch and the credential arc all keep working untouched.
 *
 * The load-bearing row is the agent↔agent swap: `cli` → `sdk` changes who owns the run and changes
 * NOTHING about whose hands are on the browser, so the epoch must not move. An epoch bump there
 * would invalidate every in-flight input for a change that has no input meaning.
 */

let dir: string;
let db: Database.Database;
let bridge: BatonTokenBridge | undefined;

const AGENT: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const SDK: Driver = { kind: 'sdk', client: { name: 'wigolo-sdk', version: '0.4.0' } };
const HUMAN: Driver = { kind: 'human' };

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-bridge-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
});

afterEach(() => {
  bridge?.dispose();
  bridge = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function newRun(driver: Driver = AGENT): Run {
  return createRunWithTail(db, { task: 'compare two monitors', driver });
}

/** Run the microtask the reflection defers onto (see the bridge header on why it defers). */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A real `ControlToken` with every bridge-visible call recorded.
 *
 * The count is the point, not the epoch: `flipTo` already no-ops a redundant flip, so "the epoch did
 * not move" is true whether the bridge asked or not. What §1.6 actually promises for an agent↔agent
 * swap is that the bridge does not TOUCH the token, and only a spy can tell the difference.
 */
function spyToken(initialHolder: 'human' | 'agent'): { token: ControlToken; calls: string[] } {
  const real = new ControlToken({ initialHolder });
  const calls: string[] = [];
  const token = Object.create(real) as ControlToken;
  Object.defineProperties(token, {
    reclaim: { value: () => { calls.push('reclaim'); real.reclaim(); } },
    grant: { value: (to: 'human' | 'agent') => { calls.push(`grant:${to}`); real.grant(to); } },
    holder: { get: () => real.holder },
    epoch: { get: () => real.epoch },
    onChange: { value: (cb: (s: { holder: 'human' | 'agent'; epoch: number }) => void) => real.onChange(cb) },
  });
  return { token, calls };
}

function wire(run: Run, token: ControlToken, takeoverReason?: () => string | undefined): BatonTokenBridge {
  bridge = createBatonTokenBridge({
    token,
    runId: run.id,
    openDb: () => db,
    ...(takeoverReason ? { takeoverReason } : {}),
  });
  return bridge;
}

function driverChanges(runId: string): Record<string, unknown>[] {
  return eventsSince(db, runId, 0, 200).filter((e) => e.type === 'driver.changed').map((e) => e.payload);
}

describe('the projection: baton → token', () => {
  it('reclaims the session for the human when the run`s driver becomes human', async () => {
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'agent' });
    wire(run, token);

    takeWheel(db, run.id, { by: HUMAN, reason: 'I will do the checkout' });
    await settle();

    expect(token.holder).toBe('human');
    expect(token.epoch).toBe(1);
  });

  it('grants the session back to the agent when the wheel returns to a machine driver', async () => {
    const run = newRun(HUMAN);
    const token = new ControlToken({ initialHolder: 'human' });
    wire(run, token);

    grantWheel(db, run.id, { by: HUMAN, to: SDK });
    await settle();

    expect(token.holder).toBe('agent');
    expect(token.epoch).toBe(1);
  });

  it('leaves the token and its epoch ALONE on an agent↔agent swap', async () => {
    const run = newRun(AGENT);
    const { token, calls } = spyToken('agent');
    wire(run, token);

    requestWheel(db, run.id, { by: SDK, requestId: 'wr_sdk' });
    grantWheel(db, run.id, { by: AGENT, requestId: 'wr_sdk' });
    await settle();

    expect(getRun(db, run.id)!.driver.kind).toBe('sdk'); // run authority DID move
    expect(calls).toEqual([]); // the token was never asked — not merely asked for a no-op
    expect(token.holder).toBe('agent'); // input gating did not change
    expect(token.epoch).toBe(0); // …and nothing in flight was invalidated
  });

  it('DOES ask the token when the projection genuinely changes — the control arm for the swap row', async () => {
    const run = newRun(AGENT);
    const { token, calls } = spyToken('agent');
    wire(run, token);

    takeWheel(db, run.id, { by: HUMAN });
    await settle();

    expect(calls).toEqual(['reclaim']);
  });

  it('does not append a second takeover for the flip it caused itself', async () => {
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'agent' });
    wire(run, token);

    takeWheel(db, run.id, { by: HUMAN });
    await settle();

    expect(driverChanges(run.id)).toHaveLength(1);
  });

  it('does not even SCHEDULE a reflection for its own flip — which is what stops it stealing the wheel back', async () => {
    // Forcing the condition the self-suppression exists for. The baton core absorbs a redundant
    // takeover as a no-op, so a reflection scheduled for the bridge's own reclaim looks harmless —
    // right up until the wheel moves on again before that deferred append runs, at which point it
    // silently drags an sdk-driven run back to `human`. N clean runs would never show it, so the
    // deferral is held here and released late on purpose.
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'agent' });
    const held: Array<() => void> = [];
    bridge = createBatonTokenBridge({ token, runId: run.id, openDb: () => db, defer: (fn) => held.push(fn) });

    takeWheel(db, run.id, { by: HUMAN }); // the bridge reclaims the session for the human
    grantWheel(db, run.id, { by: HUMAN, to: SDK }); // …and the human immediately hands it to the sdk
    for (const fn of held.splice(0)) fn();

    expect(held).toEqual([]);
    expect(getRun(db, run.id)!.driver).toEqual(SDK);
  });
});

describe('the reflection: token → baton', () => {
  it('reports a direct human grab upward as driver.changed {cause: takeover}', async () => {
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'agent' });
    wire(run, token);

    token.reclaim(); // the human grabbed the browser, not the run
    await settle();

    expect(driverChanges(run.id)).toEqual([
      expect.objectContaining({ cause: 'takeover', to: expect.objectContaining({ kind: 'human' }) }),
    ]);
    expect(getRun(db, run.id)!.driver).toEqual(HUMAN);
  });

  it('carries the reason the session can name — the credential wall says sign-in needs you', async () => {
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'agent' });
    let atWall = false;
    wire(run, token, () => (atWall ? 'sign-in needs you' : undefined));

    // The login machine reclaims FIRST and marks itself human-holding immediately afterwards, which
    // is why the bridge asks for the reason on the next microtask rather than inside the callback.
    token.reclaim();
    atWall = true;
    await settle();

    expect(driverChanges(run.id)[0]).toMatchObject({ cause: 'takeover', reason: 'sign-in needs you' });
  });

  it('reflects nothing when the run already says a human drives', async () => {
    const run = newRun(HUMAN);
    const token = new ControlToken({ initialHolder: 'agent' });
    wire(run, token);

    token.reclaim();
    await settle();

    expect(driverChanges(run.id)).toHaveLength(0);
  });

  it('does not reflect a flip TO the agent — only a human grab is authority the run did not know about', async () => {
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'human' });
    wire(run, token);

    token.grant('agent');
    await settle();

    expect(driverChanges(run.id)).toHaveLength(0);
  });
});

describe('the bridge is inert where it has nothing to bridge', () => {
  it('subscribes to nothing and appends nothing without a run bound to the session', async () => {
    const token = new ControlToken({ initialHolder: 'agent' });
    bridge = createBatonTokenBridge({ token, runId: undefined, openDb: () => db });

    token.reclaim();
    await settle();

    expect(token.holder).toBe('human'); // the token is untouched either way
  });

  it('releases its run-log subscription on dispose', () => {
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'agent' });
    const b = wire(run, token);
    expect(runEventListenerCount(run.id)).toBe(1);
    b.dispose();
    expect(runEventListenerCount(run.id)).toBe(0);
  });

  it('stops reflecting after dispose — a disposed bridge must not outlive its session', async () => {
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'agent' });
    wire(run, token).dispose();

    token.reclaim();
    await settle();

    expect(driverChanges(run.id)).toHaveLength(0);
  });

  it('survives a run-store failure without unwinding into the token flip', async () => {
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'agent' });
    bridge = createBatonTokenBridge({ token, runId: run.id, openDb: () => { throw new Error('db is gone'); } });

    expect(() => token.reclaim()).not.toThrow();
    await settle();
    expect(token.holder).toBe('human');
  });
});

describe('toControlParty is the whole of the projection', () => {
  it('maps every machine driver kind to agent and only human to human', () => {
    expect(toControlParty({ kind: 'human' })).toBe('human');
    for (const kind of ['cli', 'sdk', 'api', 'studio'] as const) {
      expect(toControlParty({ kind })).toBe('agent');
    }
  });
});

describe('the two behaviours §1.6 promises survive, by name', () => {
  it('leaves the credential arc`s reclaim/re-grant working end to end', async () => {
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'agent' });
    let atWall = false;
    wire(run, token, () => (atWall ? 'sign-in needs you' : undefined));

    // The wall: the machine reclaims. The run learns of it; the token is the human's.
    token.reclaim();
    atWall = true;
    await settle();
    expect(token.holder).toBe('human');
    expect(getRun(db, run.id)!.driver).toEqual(HUMAN);

    // Completion: the machine re-grants. The token flips back and the bridge does not fight it.
    atWall = false;
    token.grant('agent');
    await settle();
    expect(token.holder).toBe('agent');
    expect(token.epoch).toBe(2);
    expect(driverChanges(run.id)).toHaveLength(1); // still just the one takeover
  });

  it('fires every other onChange subscriber the session installed', async () => {
    const run = newRun(AGENT);
    const token = new ControlToken({ initialHolder: 'agent' });
    const seen: string[] = [];
    token.onChange((s) => seen.push(`before:${s.holder}`)); // e.g. approvals.abortPending
    wire(run, token);
    token.onChange((s) => seen.push(`after:${s.holder}`)); // e.g. loginHandoff.onControlChange

    releaseWheel(db, run.id, { by: AGENT });
    await settle();

    expect(seen).toEqual(['before:human', 'after:human']);
  });
});
