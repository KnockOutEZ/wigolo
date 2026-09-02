import { describe, it, expect } from 'vitest';
import { createActHandler, keystrokeEvents, type ActControlToken } from '../../../src/studio/act.js';
import type { NavGrant } from '../../../src/studio/nav-policy.js';
import type { ControlParty } from '../../../src/studio/control-token.js';
import type { AgentInputEvent } from '../../../src/studio/input-events.js';
import { createResolver, type ResolveResult } from '../../../src/studio/perception/resolve.js';
import { HeldSnapshot } from '../../../src/studio/perception/held-snapshot.js';
import { buildSnapshot, type AxNode, type DomNode, type PerceptionCdp } from '../../../src/studio/perception/snapshot.js';
import { isStudioToolError, type StudioActOutput, type StudioToolError } from '../../../src/daemon/studio-dispatch.js';
import { SessionAuditLog } from '../../../src/studio/audit.js';
import { PreGrantStore } from '../../../src/studio/pre-grant.js';
import type { AuthSource, ParkedAction } from '../../../src/studio/act.js';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

function makeFakeBrowser(impl?: (url: string) => Promise<void>) {
  const gotos: string[] = [];
  return {
    browser: { navigate: async (url: string) => { gotos.push(url); if (impl) await impl(url); } },
    gotos,
  };
}

/**
 * Fake control token. `epochs` is the sequence returned by successive `.epoch` reads,
 * so a test can simulate the epoch advancing mid-handler (the gate→nav-start window)
 * without needing to interleave a real flip into the synchronous handler body.
 */
function makeFakeToken(holder: ControlParty, epochs: number[] = [0]): ActControlToken {
  let i = 0;
  return {
    get holder() { return holder; },
    get epoch() { return epochs[Math.min(i++, epochs.length - 1)]; },
    assertCanDrive: (party) =>
      party === holder ? { ok: true } : { ok: false, reason: 'not_holder', currentEpoch: epochs[0] },
  };
}

const denyGrant: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: false };
const allowGrant: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: true };

// Navigate never touches resolve/channel — these defaults satisfy the (required) deps
// so the navigate proofs below stay byte-for-byte in their assertions.
const noResolve = async (): Promise<ResolveResult> => ({ error: 'element_no_longer_present' });
const noChannel = { dispatchAgentUnit: async () => true, viewportCenter: () => ({ x: 0, y: 0 }) };
const base = { resolve: noResolve, channel: noChannel };

const fixedResolve = (r: ResolveResult) => async () => r;

/** A fake agent input channel that records every unit + the epoch it was stamped with,
 *  and lets a test decide per-call whether the unit "lands" (the epoch fence's verdict). */
function recordingChannel(lands: (callIndex: number) => boolean = () => true) {
  const calls: Array<{ epoch: number; events: AgentInputEvent[]; landed: boolean }> = [];
  const announces: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    channel: {
      dispatchAgentUnit: async (epoch: number, events: AgentInputEvent[]) => {
        const landed = lands(n++);
        calls.push({ epoch, events, landed });
        return landed;
      },
      viewportCenter: () => ({ x: 400, y: 300 }),
      announce: (msg: Record<string, unknown>) => { announces.push(msg); },
    },
    calls,
    announces,
  };
}

/** S7: a pre-grant store seeded with the given entries (empty by default = the fail-closed baseline). */
function grantStore(...entries: Array<{ domain: string; actionType: string; riskTier: 'money' | 'credential' | 'destructive' }>): PreGrantStore {
  const s = new PreGrantStore();
  for (const e of entries) s.add(e);
  return s;
}

/** S7: records the actions parked for human batch review. */
function parkRecorder() {
  const parked: ParkedAction[] = [];
  return { parked, park: (i: ParkedAction) => parked.push(i) };
}

const asErr = (x: StudioActOutput | StudioToolError): StudioToolError => {
  expect(isStudioToolError(x)).toBe(true);
  return x as StudioToolError;
};

describe('createActHandler — navigate', () => {
  it('refuses when the human holds the token (gate before acting), returning currentEpoch for resync', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ ...base, browser: b.browser, controlToken: makeFakeToken('human', [7]), grant: denyGrant });
    const e = asErr(await act({ action: 'navigate', url: 'https://example.com/' }));
    expect(e.error_reason).toBe('not_holder');
    expect(e.currentEpoch).toBe(7);
    expect(b.gotos).toEqual([]); // never navigated
  });

  it('navigates a public URL when the agent holds', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ ...base, browser: b.browser, controlToken: makeFakeToken('agent', [3]), grant: denyGrant });
    const r = await act({ action: 'navigate', url: 'https://example.com/' });
    expect(isStudioToolError(r)).toBe(false);
    expect(r).toMatchObject({ ok: true, action: 'navigate', url: 'https://example.com/' });
    expect(b.gotos).toEqual(['https://example.com/']);
  });

  it('blocks the agent from cloud-metadata EVEN WITH the private-nav grant (no SSRF lane)', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ ...base, browser: b.browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    expect(asErr(await act({ action: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' })).error_reason).toBe('navigation_blocked');
    expect(asErr(await act({ action: 'navigate', url: 'http://metadata.google.internal/' })).error_reason).toBe('navigation_blocked');
    expect(b.gotos).toEqual([]);
  });

  it('blocks the agent from localhost/RFC1918 by default; allows it only with the grant', async () => {
    const blocked = makeFakeBrowser();
    const actNoGrant = createActHandler({ ...base, browser: blocked.browser, controlToken: makeFakeToken('agent', [1]), grant: denyGrant });
    expect(asErr(await actNoGrant({ action: 'navigate', url: 'http://localhost:3000/' })).error_reason).toBe('navigation_blocked');
    expect(blocked.gotos).toEqual([]);

    const allowed = makeFakeBrowser();
    const actGranted = createActHandler({ ...base, browser: allowed.browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    const r = await actGranted({ action: 'navigate', url: 'http://localhost:3000/' });
    expect(isStudioToolError(r)).toBe(false);
    expect(allowed.gotos).toEqual(['http://localhost:3000/']);
  });

  it('refuses non-http(s) schemes for the agent (scheme allowlist)', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ ...base, browser: b.browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    expect(asErr(await act({ action: 'navigate', url: 'file:///etc/passwd' })).error_reason).toBe('navigation_protocol');
    expect(asErr(await act({ action: 'navigate', url: 'javascript:alert(1)' })).error_reason).toBe('navigation_protocol');
    expect(b.gotos).toEqual([]);
  });

  it('EPOCH FENCE: a reclaim in the gate→nav-start window aborts WITHOUT navigating (aborted_reclaimed)', async () => {
    // gate passes at epoch 5; the fence re-reads the epoch right before the nav command
    // and sees 6 (a reclaim landed) → stand down, never navigate under the revoked grant.
    const b = makeFakeBrowser();
    const act = createActHandler({ ...base, browser: b.browser, controlToken: makeFakeToken('agent', [5, 6]), grant: allowGrant });
    const e = asErr(await act({ action: 'navigate', url: 'https://example.com/' }));
    expect(e.error_reason).toBe('aborted_reclaimed');
    expect(b.gotos).toEqual([]); // the CDP nav command never went out
  });

  it('reclaim-abort gets its OWN reason: an in-flight reclaim is reclassified aborted_reclaimed, not navigation_failed', async () => {
    // Fence passes (epoch 5 == 5); the nav starts; an in-flight reclaim aborts it (goto
    // rejects) and the epoch advances to 6 → the handler must NOT surface a generic
    // navigation_failed (which the agent would retry, fighting the human) — it returns
    // the distinct stand-down reason.
    const b = makeFakeBrowser(async () => { throw new Error('net::ERR_ABORTED'); });
    const act = createActHandler({ ...base, browser: b.browser, controlToken: makeFakeToken('agent', [5, 5, 6]), grant: allowGrant });
    const e = asErr(await act({ action: 'navigate', url: 'https://example.com/' }));
    expect(e.error_reason).toBe('aborted_reclaimed');
    expect(b.gotos).toEqual(['https://example.com/']); // it did start before the abort
  });

  it('a genuine site failure (no reclaim) stays navigation_failed (not masked as a stand-down)', async () => {
    const b = makeFakeBrowser(async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); });
    const act = createActHandler({ ...base, browser: b.browser, controlToken: makeFakeToken('agent', [4]), grant: allowGrant });
    expect(asErr(await act({ action: 'navigate', url: 'https://nope.example/' })).error_reason).toBe('navigation_failed');
  });

  it('wait_for_human is run coordination and does no browser work, even while the human holds page control', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ ...base, browser: b.browser, controlToken: makeFakeToken('human', [7]), grant: denyGrant });
    const result = await act({ action: 'wait_for_human', reason: 'Which account should I use?' });
    expect(result).toEqual({ ok: true, action: 'wait_for_human' });
    expect(b.gotos).toEqual([]);
  });

  it('refuses wait_for_human without a bounded, non-empty reason', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ ...base, browser: b.browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    expect(asErr(await act({ action: 'wait_for_human' })).error_reason).toBe('invalid_wait_reason');
    expect(asErr(await act({ action: 'wait_for_human', reason: 'x'.repeat(4001) })).error_reason).toBe('invalid_wait_reason');
    expect(b.gotos).toEqual([]);
  });

  it('refuses an action that is not navigate|click|type|scroll|wait_for_human', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ ...base, browser: b.browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    expect(asErr(await act({ action: 'frobnicate' } as unknown as { action: 'navigate' })).error_reason).toBe('action_not_supported');
    expect(b.gotos).toEqual([]);
  });
});

describe('createActHandler — click', () => {
  it('resolves LIVE then clicks the resolved centre via the gated channel (one mouse-down+up unit at the page-px centre, stamped the gate epoch)', async () => {
    const b = makeFakeBrowser();
    const ch = recordingChannel();
    const act = createActHandler({
      browser: b.browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 42, y: 84 } }), channel: ch.channel,
    });
    const r = await act({ action: 'click', ref: 'e9' });
    expect(isStudioToolError(r)).toBe(false);
    expect(r).toMatchObject({ ok: true, action: 'click' });
    expect(ch.calls).toHaveLength(1);
    expect(ch.calls[0].epoch).toBe(5); // stamped with the gate epoch captured after the gate
    expect(ch.calls[0].events).toEqual([
      { kind: 'mouse', type: 'mousePressed', x: 42, y: 84, button: 'left', buttons: 1, clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: 42, y: 84, button: 'left', buttons: 0, clickCount: 1 },
    ]);
  });

  it('refuses when the human holds (gate before resolving), returning currentEpoch; never resolves, never dispatches', async () => {
    const ch = recordingChannel();
    let resolved = 0;
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('human', [9]), grant: allowGrant,
      resolve: async () => { resolved++; return { error: 'element_no_longer_present' }; }, channel: ch.channel,
    });
    const e = asErr(await act({ action: 'click', ref: 'e1' }));
    expect(e.error_reason).toBe('not_holder');
    expect(e.currentEpoch).toBe(9);
    expect(resolved).toBe(0); // gated BEFORE the live resolve
    expect(ch.calls).toHaveLength(0);
  });

  it('surfaces an occlusion as element_occluded with a re-observe/vision hint; never dispatches a click into the overlay', async () => {
    const ch = recordingChannel();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant,
      resolve: fixedResolve({ error: 'element_occluded' }), channel: ch.channel,
    });
    const e = asErr(await act({ action: 'click', ref: 'e1' }));
    expect(e.error_reason).toBe('element_occluded');
    expect(e.hint.toLowerCase()).toContain('cover'); // points at the overlay covering it / re-observe
    expect(ch.calls).toHaveLength(0);
  });

  it('maps a stale ref and an ambiguous ref to their own reasons (never a wrong-element click)', async () => {
    const mk = (r: ResolveResult) => createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant,
      resolve: fixedResolve(r), channel: recordingChannel().channel,
    });
    expect(asErr(await mk({ error: 'element_no_longer_present' })({ action: 'click', ref: 'e1' })).error_reason).toBe('element_no_longer_present');
    expect(asErr(await mk({ error: 'element_low_confidence' })({ action: 'click', ref: 'e1' })).error_reason).toBe('element_low_confidence');
  });

  it('a dropped unit (the epoch fence won the race against a reclaim) returns aborted_reclaimed, not a retryable error', async () => {
    const ch = recordingChannel(() => false); // the channel drops the unit (stale epoch)
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 1, y: 2 } }), channel: ch.channel,
    });
    expect(asErr(await act({ action: 'click', ref: 'e1' })).error_reason).toBe('aborted_reclaimed');
  });

  it('refuses a click with no ref', async () => {
    const act = createActHandler({ ...base, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    expect(asErr(await act({ action: 'click' })).error_reason).toBe('missing_ref');
  });
});

describe('createActHandler — type', () => {
  it('focuses the resolved element then types each char as its own gated unit; reports charsLanded = text length', async () => {
    const ch = recordingChannel();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [3]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 10, y: 20 } }), channel: ch.channel,
    });
    const r = await act({ action: 'type', ref: 'e1', text: 'hi' });
    expect(r).toMatchObject({ ok: true, action: 'type', charsLanded: 2 });
    // unit 0 = the focus click at the resolved centre; units 1,2 = the keystrokes.
    expect(ch.calls).toHaveLength(3);
    expect(ch.calls[0].events[0]).toMatchObject({ kind: 'mouse', type: 'mousePressed', x: 10, y: 20 });
    expect(ch.calls[1].events.map((e) => (e as { text?: string }).text).filter(Boolean)).toEqual(['h']);
    expect(ch.calls[2].events.map((e) => (e as { text?: string }).text).filter(Boolean)).toEqual(['i']);
    expect(ch.calls.every((c) => c.epoch === 3)).toBe(true); // every unit stamped with the ONE gate epoch
  });

  it('a reclaim mid-type drops the REMAINING chars and reports the chars that landed (aborted_reclaimed)', async () => {
    // lands focus(0) + 'a'(1) + 'b'(2); the fence drops 'c'(3) onward.
    const ch = recordingChannel((n) => n < 3);
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 0, y: 0 } }), channel: ch.channel,
    });
    const e = asErr(await act({ action: 'type', ref: 'e1', text: 'abcde' }));
    expect(e.error_reason).toBe('aborted_reclaimed');
    expect(e.charsLanded).toBe(2); // 'a','b' landed; 'c','d','e' dropped
  });

  it('a reclaim before the focus click lands → aborted_reclaimed with charsLanded 0', async () => {
    const ch = recordingChannel(() => false); // even the focus unit is dropped
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 0, y: 0 } }), channel: ch.channel,
    });
    const e = asErr(await act({ action: 'type', ref: 'e1', text: 'abc' }));
    expect(e.error_reason).toBe('aborted_reclaimed');
    expect(e.charsLanded).toBe(0);
  });

  it('surfaces a resolve error (e.g. occlusion) before typing — never focuses, never types', async () => {
    const ch = recordingChannel();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant,
      resolve: fixedResolve({ error: 'element_occluded' }), channel: ch.channel,
    });
    expect(asErr(await act({ action: 'type', ref: 'e1', text: 'hi' })).error_reason).toBe('element_occluded');
    expect(ch.calls).toHaveLength(0);
  });

  it('refuses when the human holds; never resolves', async () => {
    const ch = recordingChannel();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('human', [4]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 0, y: 0 } }), channel: ch.channel,
    });
    expect(asErr(await act({ action: 'type', ref: 'e1', text: 'hi' })).error_reason).toBe('not_holder');
    expect(ch.calls).toHaveLength(0);
  });

  it('refuses a type with no ref', async () => {
    const act = createActHandler({ ...base, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    expect(asErr(await act({ action: 'type', text: 'hi' })).error_reason).toBe('missing_ref');
  });
});

describe('createActHandler — scroll', () => {
  it('dispatches ONE wheel event at the viewport centre; positive deltaY for direction down', async () => {
    const ch = recordingChannel();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [2]), grant: allowGrant,
      resolve: noResolve, channel: ch.channel,
    });
    const r = await act({ action: 'scroll', direction: 'down', amount: 500 });
    expect(r).toMatchObject({ ok: true, action: 'scroll' });
    expect(ch.calls).toHaveLength(1);
    expect(ch.calls[0].events).toEqual([{ kind: 'mouse', type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 500 }]);
  });

  it('direction up → negative deltaY; a default amount applies when omitted', async () => {
    const ch = recordingChannel();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [2]), grant: allowGrant,
      resolve: noResolve, channel: ch.channel,
    });
    await act({ action: 'scroll', direction: 'up' });
    const wheel = ch.calls[0].events[0] as { deltaY: number };
    expect(wheel.deltaY).toBeLessThan(0);
  });

  it('a dropped wheel (reclaim) returns aborted_reclaimed', async () => {
    const ch = recordingChannel(() => false);
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [2]), grant: allowGrant,
      resolve: noResolve, channel: ch.channel,
    });
    expect(asErr(await act({ action: 'scroll', direction: 'down' })).error_reason).toBe('aborted_reclaimed');
  });
});

describe('createActHandler — audit log (Phase 6b: every agent action is recorded with its outcome)', () => {
  const fixedClock = { now: () => 1000 };

  it('records a successful navigate with the url target and an ok outcome', async () => {
    const audit = new SessionAuditLog(fixedClock);
    const act = createActHandler({ ...base, audit, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [3]), grant: denyGrant });
    await act({ action: 'navigate', url: 'https://example.com/' });
    expect(audit.entries()).toEqual([
      { seq: 1, ts: 1000, action: 'navigate', epoch: 3, target: { url: 'https://example.com/' }, outcome: { ok: true } },
    ]);
  });

  it('records a REFUSED action (human holds) with the not_holder outcome — refusals are audited too', async () => {
    const audit = new SessionAuditLog(fixedClock);
    const act = createActHandler({ ...base, audit, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('human', [7]), grant: denyGrant });
    await act({ action: 'navigate', url: 'https://example.com/' });
    expect(audit.entries()).toEqual([
      { seq: 1, ts: 1000, action: 'navigate', epoch: 7, target: { url: 'https://example.com/' }, outcome: { ok: false, error_reason: 'not_holder' } },
    ]);
  });

  it('records a click that resolved to an occlusion (error outcome, ref target)', async () => {
    const audit = new SessionAuditLog(fixedClock);
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [2]), grant: allowGrant,
      resolve: fixedResolve({ error: 'element_occluded' }), channel: recordingChannel().channel, audit,
    });
    await act({ action: 'click', ref: 'e9' });
    expect(audit.entries()).toEqual([
      { seq: 1, ts: 1000, action: 'click', epoch: 2, target: { ref: 'e9' }, outcome: { ok: false, error_reason: 'element_occluded' } },
    ]);
  });

  it('records a partial type with charsLanded on the aborted_reclaimed outcome', async () => {
    const audit = new SessionAuditLog(fixedClock);
    const ch = recordingChannel((n) => n < 2); // focus(0) + 'a'(1) land, 'b'(2) dropped
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 0, y: 0 } }), channel: ch.channel, audit,
    });
    await act({ action: 'type', ref: 'e1', text: 'ab' });
    expect(audit.entries()).toEqual([
      { seq: 1, ts: 1000, action: 'type', epoch: 5, target: { ref: 'e1' }, outcome: { ok: false, error_reason: 'aborted_reclaimed', charsLanded: 1 } },
    ]);
  });

  it('records an UNKNOWN action verb (rejected, but never silently dropped from the trail)', async () => {
    const audit = new SessionAuditLog(fixedClock);
    const act = createActHandler({ ...base, audit, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    await act({ action: 'frobnicate' } as unknown as { action: 'navigate' });
    expect(audit.entries()).toEqual([
      { seq: 1, ts: 1000, action: 'frobnicate', epoch: 1, outcome: { ok: false, error_reason: 'action_not_supported' } },
    ]);
  });

  it('records EVERY action in order across a session — replay is the full ordered sequence', async () => {
    const audit = new SessionAuditLog(fixedClock);
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [4]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 1, center: { x: 1, y: 1 } }), channel: recordingChannel().channel, audit,
    });
    await act({ action: 'navigate', url: 'https://a/' });
    await act({ action: 'scroll', direction: 'down', amount: 600 });
    await act({ action: 'click', ref: 'e1' });
    await act({ action: 'type', ref: 'e2', text: 'hi' });
    expect(audit.entries().map((e) => ({ seq: e.seq, action: e.action, outcome: e.outcome }))).toEqual([
      { seq: 1, action: 'navigate', outcome: { ok: true } },
      { seq: 2, action: 'scroll', outcome: { ok: true } },
      { seq: 3, action: 'click', outcome: { ok: true } },
      { seq: 4, action: 'type', outcome: { ok: true, charsLanded: 2 } }, // success-path charsLanded is audited too
    ]);
  });
});

describe('createActHandler — S7 pre-grant authorization gate', () => {
  const moneyUrl = () => 'https://shop.example/checkout'; // domain shop.example
  const loginUrl = () => 'https://acme.example/login'; // domain acme.example
  const benignUrl = () => 'https://en.wikipedia.org/wiki/Cat';
  const resolvedAt = (c = { x: 1, y: 2 }) => fixedResolve({ backendNodeId: 7, center: c });

  // PIN — empty pre-grant (the fail-closed default): a risky click PARKS, never executes, and is enqueued.
  // Mutation that REDs: default the scope to non-empty → the action authorizes + dispatches instead of parking.
  it('S7 PIN(empty-default): a risky click with an EMPTY pre-grant PARKS (parked_for_review), never dispatched', async () => {
    const ch = recordingChannel();
    const pk = parkRecorder();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: resolvedAt(), channel: ch.channel, currentUrl: moneyUrl, preGrant: new PreGrantStore(), park: pk.park,
    });
    expect(asErr(await act({ action: 'click', ref: 'e9' })).error_reason).toBe('parked_for_review');
    expect(ch.calls).toHaveLength(0); // NOT executed
    expect(pk.parked).toHaveLength(1); // enqueued for the human's batch review
    expect(pk.parked[0]).toMatchObject({ action: 'click', risk: 'money', domain: 'shop.example' });
  });

  // PIN — a MATCHING pre-grant authorizes WITHOUT a human verdict (executes), never parks.
  // Mutation that REDs: break the match key (wrong domain) → falls to park (authorized/parked diverge).
  it('S7 PIN(match): a risky click MATCHING a pre-grant is authorized (no verdict wait) and dispatched', async () => {
    const ch = recordingChannel();
    const pk = parkRecorder();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: resolvedAt(), channel: ch.channel, currentUrl: moneyUrl,
      preGrant: grantStore({ domain: 'shop.example', actionType: 'click', riskTier: 'money' }), park: pk.park,
    });
    const r = await act({ action: 'click', ref: 'e9' });
    expect(r).toMatchObject({ ok: true, action: 'click' });
    expect(ch.calls).toHaveLength(1); // authorized → executed
    expect(pk.parked).toHaveLength(0); // never parked
  });

  // PIN — a pre-grant for a DIFFERENT domain does NOT authorize (the wrong-domain mutation of the match pin).
  it('S7 PIN(no-match): a pre-grant for a different domain does not authorize — the action PARKS, not executes', async () => {
    const ch = recordingChannel();
    const pk = parkRecorder();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: resolvedAt(), channel: ch.channel, currentUrl: moneyUrl,
      preGrant: grantStore({ domain: 'other.example', actionType: 'click', riskTier: 'money' }), park: pk.park,
    });
    expect(asErr(await act({ action: 'click', ref: 'e9' })).error_reason).toBe('parked_for_review');
    expect(ch.calls).toHaveLength(0);
    expect(pk.parked).toHaveLength(1);
  });

  // A grant is action-type + risk-tier scoped: a 'click' grant does not authorize a 'type', and a 'money' grant
  // does not cover a 'credential'-risk action.
  it('S7: a credential-context type with no matching grant parks (action-type/risk scoped)', async () => {
    const ch = recordingChannel();
    const pk = parkRecorder();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 1, y: 2 }, semantics: { tag: 'input', type: 'text', name: 'Username' } }),
      channel: ch.channel, currentUrl: loginUrl,
      // a click/money grant on this domain does NOT cover a type/credential action
      preGrant: grantStore({ domain: 'acme.example', actionType: 'click', riskTier: 'money' }), park: pk.park,
    });
    expect(asErr(await act({ action: 'type', ref: 'e1', text: 'alice' })).error_reason).toBe('parked_for_review');
    expect(ch.calls).toHaveLength(0); // never focused, never typed
    expect(pk.parked[0]).toMatchObject({ action: 'type', risk: 'credential' });
  });

  it('S7: a SAFE click is NOT gated — dispatched normally, never parked (co-browsing stays usable)', async () => {
    const ch = recordingChannel();
    const pk = parkRecorder();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 1, y: 2 }, role: 'link', name: 'References' }),
      channel: ch.channel, currentUrl: benignUrl, preGrant: new PreGrantStore(), park: pk.park,
    });
    const r = await act({ action: 'click', ref: 'e9' });
    expect(r).toMatchObject({ ok: true, action: 'click' });
    expect(ch.calls).toHaveLength(1);
    expect(pk.parked).toHaveLength(0); // safe → never parked
  });

  // PIN — the authorization SOURCE is audited through the single choke point: 'pre-grant' on a match,
  // 'parked' on a no-match. Mutation that REDs: drop the source from the gate's resolution → the audit
  // entry loses its approval flag.
  it('S7 PIN(audit-source): pre-grant-authorized → approval:pre-grant; parked → approval:parked (single choke point)', async () => {
    const fixedClock = { now: () => 1000 };
    const grantedAudit = new SessionAuditLog(fixedClock);
    await createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: resolvedAt(), channel: recordingChannel().channel, currentUrl: moneyUrl,
      preGrant: grantStore({ domain: 'shop.example', actionType: 'click', riskTier: 'money' }), park: () => {}, audit: grantedAudit,
    })({ action: 'click', ref: 'e9' });
    expect(grantedAudit.entries()).toEqual([
      { seq: 1, ts: 1000, action: 'click', epoch: 5, target: { ref: 'e9' }, outcome: { ok: true }, risk: 'money', approval: 'pre-grant' },
    ]);

    const parkedAudit = new SessionAuditLog(fixedClock);
    await createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: resolvedAt(), channel: recordingChannel().channel, currentUrl: moneyUrl,
      preGrant: new PreGrantStore(), park: () => {}, audit: parkedAudit,
    })({ action: 'click', ref: 'e9' });
    expect(parkedAudit.entries()).toEqual([
      { seq: 1, ts: 1000, action: 'click', epoch: 5, target: { ref: 'e9' }, outcome: { ok: false, error_reason: 'parked_for_review' }, risk: 'money', approval: 'parked' },
    ]);
  });
});

describe('createActHandler — the risky-action gate is pre-grant/park, with NO live approval round-trip', () => {
  /**
   * WHY THIS BLOCK EXISTS.
   *
   * `ActHandlerDeps` used to declare `approvals?: { request(...): Promise<ApprovalDecision> }`, documented as
   * "a risky action is HELD for human approval before firing". NOTHING read it: `createActHandler` never
   * destructured it, `applyRiskGate` never called it, and no host passed it (the Electron host wires
   * `preGrant`/`park`, and implements the D9 card with its own parked-card map). So the code advertised a
   * per-action human verdict that did not exist, and the program's canon read "approval gates intact" off
   * that declaration.
   *
   * A declared-but-unread gate is strictly worse than an absent one — it reads as protection to the next
   * person and protects nothing. The gate that IS real on this path is: classify (deterministic, code-only)
   * → matching human pre-grant authorizes → otherwise PARK, never execute. Plus the hard credential refusal,
   * plus the D9 drive gate on `navigate`.
   *
   * These pins keep that claim and the code in agreement. They fail if someone re-introduces an approval
   * seam here without wiring it end-to-end — which is precisely how this defect recurs.
   */

  // COMPILE-TIME PIN. `Record<AuthSource, true>` is exhaustive by construction: widening `AuthSource` back to
  // include an `ApprovalDecision` ('approved'/'refused'/'timeout'/'superseded') makes this object literal
  // missing-key and `npm run typecheck:studio` fails. A widened AuthSource is the type-level tell that a
  // verdict wait has been re-introduced, so the build is the right place to catch it.
  const AUTH_SOURCES: Record<AuthSource, true> = { 'pre-grant': true, parked: true };

  it('CLAIM-PIN(type): the only ways a risky action can be authorized are a pre-grant or a park', () => {
    // Asserted at runtime too, so the intent survives a reader who does not run the typechecker.
    expect(Object.keys(AUTH_SOURCES).sort()).toEqual(['parked', 'pre-grant']);
  });

  it('CLAIM-PIN(no-unread-seam): ActHandlerDeps declares no approval-request dependency', () => {
    // The defect was a DECLARATION that nothing honoured, so the pin is on the declaration itself. Scoped to
    // the ActHandlerDeps body and anchored to a property position, so the prose above it explaining WHY the
    // seam is absent does not satisfy (or trip) the check.
    const source = readFileSync(new URL('../../../src/studio/act.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export interface ActHandlerDeps');
    const end = source.indexOf('export function createActHandler');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const declared = source.slice(start, end);
    // Control: the slice really is the deps interface (a property we know is there), so a pass cannot come
    // from having sliced an empty/wrong region.
    expect(declared).toMatch(/^\s*preGrant\??:/m);
    expect(declared).not.toMatch(/^\s*approvals\??:/m);
  });

  it('CLAIM-PIN(behaviour): a risky action is refused with NO approval hook reachable — the park IS the gate', async () => {
    // The refusal proof. An agent acting through this handler on a money page with no pre-grant cannot
    // execute, and there is no seam it could have been let through by: the handler is constructed with the
    // full production-shaped dep set and still parks.
    const ch = recordingChannel();
    const pk = parkRecorder();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 1, y: 2 } }),
      channel: ch.channel, currentUrl: () => 'https://shop.example/checkout',
      preGrant: new PreGrantStore(), park: pk.park,
    });
    const r = asErr(await act({ action: 'click', ref: 'e9' }));
    expect(r.error_reason).toBe('parked_for_review');
    // Never executed — the refusal is real, not merely reported.
    expect(ch.calls).toHaveLength(0);
    // And it is a do-not-retry refusal, so the agent does not spin against the human.
    expect(r.hint).toMatch(/do not retry/i);
    expect(pk.parked).toHaveLength(1);
  });

  it('MUST-NOT-FIRE: the human-authorized path is untouched — a matching pre-grant still executes', async () => {
    // The other half. Removing the phantom approval seam must not have tightened anything for a user who
    // HAS authorized the action: a matching human pre-grant still authorizes, dispatches, and never parks.
    const ch = recordingChannel();
    const pk = parkRecorder();
    const act = createActHandler({
      browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [5]), grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 1, y: 2 } }),
      channel: ch.channel, currentUrl: () => 'https://shop.example/checkout',
      preGrant: grantStore({ domain: 'shop.example', actionType: 'click', riskTier: 'money' }), park: pk.park,
    });
    expect(await act({ action: 'click', ref: 'e9' })).toMatchObject({ ok: true, action: 'click' });
    expect(ch.calls).toHaveLength(1);
    expect(pk.parked).toHaveLength(0);
  });
});

describe('keystrokeEvents — unit composition (modifier wrap is atomic)', () => {
  it('a lowercase char → keyDown / char / keyUp with NO modifier (nothing held)', () => {
    expect(keystrokeEvents('a')).toEqual([
      { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA' },
      { kind: 'key', type: 'char', key: 'a', text: 'a' },
      { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA' },
    ]);
  });

  it('an uppercase char is wrapped in a balanced Shift down/up, the letter carrying the Shift modifier — so no Shift is stranded between units', () => {
    const evs = keystrokeEvents('B');
    expect(evs[0]).toEqual({ kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft' });
    expect(evs[evs.length - 1]).toEqual({ kind: 'key', type: 'keyUp', key: 'Shift', code: 'ShiftLeft' });
    const inner = evs.slice(1, -1);
    expect(inner.every((e) => (e as { modifiers?: number }).modifiers === 8)).toBe(true); // Shift bit on every inner event
    expect(inner.find((e) => e.type === 'char')).toMatchObject({ text: 'B' });
  });

  it('a digit gets its Digit<n> code, no modifier', () => {
    expect(keystrokeEvents('5')).toEqual([
      { kind: 'key', type: 'keyDown', key: '5', code: 'Digit5' },
      { kind: 'key', type: 'char', key: '5', text: '5' },
      { kind: 'key', type: 'keyUp', key: '5', code: 'Digit5' },
    ]);
  });

  it('a non-alphanumeric char (e.g. space) carries NO physical key code (so it is never tracked as a held key)', () => {
    const evs = keystrokeEvents(' ');
    // code is omitted (undefined), not the empty string — the trackKey `code == null`
    // guard then skips it, so a space never lands in the held-key map.
    expect(evs.map((e) => (e as { code?: string }).code)).toEqual([undefined, undefined, undefined]);
    expect(evs[1]).toMatchObject({ type: 'char', text: ' ' });
  });
});

// --- Slice 5a: hard credential-input refusal ------------------------------------------------
// These drive the agent's REAL type path (createActHandler → typeAct → gateAndResolve) over the
// REAL buildSnapshot + REAL createResolver with a fake CDP page — only the input channel + control
// token are faked. So the credential decision reads the element's TRUE pierced-DOM semantics, not a
// stubbed verdict: a stubbed `resolve` would make (iii) shadow-pierce and (iv) unresolvable vacuous.

/** content quad for a 20x10 box at (100,200) → centre (110,205); reused for every resolved target. */
const CRED_BOX = [100, 200, 120, 200, 120, 210, 100, 210];

interface FieldSpec { be: number; role: string; name: string; attrs?: Record<string, string>; tag?: string; shadow?: 'closed'; }

/** Build a getFullAXTree + DOM.getDocument(pierce:true) pair (mirrors the snapshot-test builder; adds a `tag` override + closed-shadow nesting). */
function buildAxDom(specs: FieldSpec[]): { axNodes: AxNode[]; root: DomNode } {
  const axNodes: AxNode[] = specs.map((s) => ({ ignored: false, role: { value: s.role }, name: { value: s.name }, backendDOMNodeId: s.be }));
  const light: DomNode[] = [];
  const closed: DomNode[] = [];
  for (const s of specs) {
    const tag = s.tag ?? (s.role === 'textbox' ? 'input' : s.role === 'link' ? 'a' : 'button');
    const node: DomNode = { backendNodeId: s.be, localName: tag, attributes: Object.entries(s.attrs ?? {}).flat() };
    (s.shadow === 'closed' ? closed : light).push(node);
  }
  const closedHost: DomNode[] = closed.length
    ? [{ backendNodeId: 90, localName: 'closed-widget', shadowRoots: [{ backendNodeId: 91, shadowRootType: 'closed', children: closed }] }]
    : [];
  const body: DomNode = { backendNodeId: 2, localName: 'body', children: [...light, ...closedHost] };
  return { axNodes, root: { backendNodeId: 1, localName: 'html', children: [body] } };
}

/** Fake CDP for the resolver's coordinate path: a box for the target be, target = topmost (no occlusion), scroll 0. */
function resolveCdp(targetBe: number): PerceptionCdp {
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.getBoxModel') return (params?.backendNodeId as number) === targetBe ? { model: { content: CRED_BOX } } : {};
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: targetBe };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      return {};
    },
  };
}

/** Drive a studio_act TYPE against `targetBe` through the real snapshot+resolver; returns the tool result + the recording channel. */
async function typeAtTarget(opts: { specs: FieldSpec[]; targetBe: number; url?: string; text?: string }): Promise<{ result: StudioActOutput | StudioToolError; ch: ReturnType<typeof recordingChannel> }> {
  const { axNodes, root } = buildAxDom(opts.specs);
  const snapshot = async () => buildSnapshot(axNodes, root, { tokenBudget: 4000 });
  const ref = [...(await snapshot()).refMap.entries()].find(([, be]) => be === opts.targetBe)?.[0];
  if (!ref) throw new Error(`target be ${opts.targetBe} not in snapshot`);
  const ch = recordingChannel();
  const act = createActHandler({
    browser: makeFakeBrowser().browser,
    controlToken: makeFakeToken('agent', [1]),
    grant: allowGrant,
    resolve: createResolver({ snapshot, cdp: resolveCdp(opts.targetBe) }),
    channel: ch.channel,
    ...(opts.url ? { currentUrl: () => opts.url } : {}),
  });
  const result = await act({ action: 'type', ref, text: opts.text ?? 'secret' });
  return { result, ch };
}

/** Direct value read (not asErr) so the RED — TDD AND the mutation — surfaces as a clean value-flip: "expected 'credential_field_refused', got undefined" (the type landed). */
const expectCredentialRefused = (x: StudioActOutput | StudioToolError): void => {
  expect((x as StudioToolError).error_reason).toBe('credential_field_refused');
};

describe('createActHandler — type: hard credential-field refusal (Slice 5a)', () => {
  it('(i) REFUSES input[type=password] on an OFF-login URL with a BLANK a11y name (reads true semantics, not the label)', async () => {
    const { result, ch } = await typeAtTarget({
      specs: [{ be: 100, role: 'textbox', name: '', attrs: { type: 'password' } }],
      targetBe: 100,
      url: 'https://example.com/app/settings',
      text: 'hunter2',
    });
    expectCredentialRefused(result);
    expect(ch.calls).toHaveLength(0); // never focused, never typed a character
  });

  it('(ii) REFUSES autocomplete=one-time-code on a TEXT input (the heuristic NAME gate would miss "Enter code")', async () => {
    const { result, ch } = await typeAtTarget({
      specs: [{ be: 101, role: 'textbox', name: 'Enter code', attrs: { type: 'text', autocomplete: 'one-time-code' } }],
      targetBe: 101,
      url: 'https://example.com/app',
      text: '123456',
    });
    expectCredentialRefused(result);
    expect(ch.calls).toHaveLength(0);
  });

  it('(iii) REFUSES a credential field nested in a CLOSED shadow root (the privileged snapshot pierces → credential)', async () => {
    const { result, ch } = await typeAtTarget({
      specs: [{ be: 102, role: 'textbox', name: '', attrs: { type: 'password' }, shadow: 'closed' }],
      targetBe: 102,
      url: 'https://example.com/app',
      text: 'hunter2',
    });
    expectCredentialRefused(result);
    expect(ch.calls).toHaveLength(0);
  });

  it('(iv) FAIL-CLOSED: an unresolvable target (custom web component) in a credential CONTEXT (login URL) is refused', async () => {
    const { result, ch } = await typeAtTarget({
      specs: [{ be: 103, role: 'textbox', name: '', tag: 'acme-secure-field' }],
      targetBe: 103,
      url: 'https://acme.example/login',
      text: 'hunter2',
    });
    expectCredentialRefused(result);
    expect(ch.calls).toHaveLength(0);
  });

  it('(iv) FAIL-CLOSED: an unresolvable target on a non-login page is refused when a credential field is present (context = field, not URL)', async () => {
    const { result, ch } = await typeAtTarget({
      specs: [
        { be: 104, role: 'textbox', name: '', tag: 'acme-secure-field' }, // ambiguous target
        { be: 105, role: 'textbox', name: '', attrs: { type: 'password' } }, // a credential field elsewhere on the page
      ],
      targetBe: 104,
      url: 'https://example.com/account', // NOT a login URL — the context is the password field present
      text: 'hunter2',
    });
    expectCredentialRefused(result);
    expect(ch.calls).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: a plain search input on a non-credential page TYPES (guards over-refusal)', async () => {
    const { result, ch } = await typeAtTarget({
      specs: [{ be: 200, role: 'textbox', name: 'Search', attrs: { type: 'search' } }],
      targetBe: 200,
      url: 'https://example.com/',
      text: 'hi',
    });
    expect(result).toMatchObject({ ok: true, action: 'type', charsLanded: 2 });
    expect(ch.calls).toHaveLength(3); // focus click + 2 keystrokes
  });

  it('NEGATIVE CONTROL: an unresolvable target OUTSIDE a credential context TYPES (rule 2 does not over-refuse ambiguous fields everywhere)', async () => {
    const { result, ch } = await typeAtTarget({
      specs: [{ be: 201, role: 'textbox', name: 'Comment', tag: 'rich-editor' }],
      targetBe: 201,
      url: 'https://example.com/post',
      text: 'hi',
    });
    expect(result).toMatchObject({ ok: true, action: 'type', charsLanded: 2 });
    expect(ch.calls).toHaveLength(3);
  });
});

describe('audit persistence — guard pins through the act choke (P6-b)', () => {
  it('(a) EVERY action through the choke is persisted — successes, refusals, AND unknown verbs', async () => {
    const db = migratedDb();
    const audit = new SessionAuditLog({ db, sessionId: 'sess-C' });
    const human = createActHandler({ browser: makeFakeBrowser().browser, controlToken: makeFakeToken('human'), grant: denyGrant, ...base, audit });
    await human({ action: 'navigate', url: 'https://x/' }); // refused (human holds) — still recorded
    await human({ action: 'frobnicate' } as unknown as { action: 'navigate' }); // unknown verb — still recorded
    const agent = createActHandler({ browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent'), grant: allowGrant, ...base, audit });
    await agent({ action: 'navigate', url: 'https://y/' }); // success
    // Read from a FRESH log — proves all three durably persisted, in order.
    const persisted = new SessionAuditLog({ db, sessionId: 'sess-C' }).entries();
    expect(persisted.map((e) => e.action)).toEqual(['navigate', 'frobnicate', 'navigate']);
    expect(persisted.map((e) => e.outcome.ok)).toEqual([false, false, true]);
    db.close();
  });

  it('(b) a typeAct secret value is NEVER persisted — only metadata (charsLanded)', async () => {
    const db = migratedDb();
    const audit = new SessionAuditLog({ db, sessionId: 'sess-R' });
    const SECRET = 'SUPERSECRETVALUE-123';
    const ch = recordingChannel();
    const handler = createActHandler({
      browser: makeFakeBrowser().browser,
      controlToken: makeFakeToken('agent'),
      grant: allowGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 1, y: 1 } }),
      channel: ch.channel,
      audit,
      currentUrl: () => 'https://example.com/search',
    });
    const r = await handler({ action: 'type', ref: 'e1', text: SECRET });
    expect(r).toMatchObject({ ok: true, action: 'type', charsLanded: SECRET.length });
    // The secret is in NEITHER the hydrated entries NOR the raw columns; only charsLanded survives.
    const replayed = new SessionAuditLog({ db, sessionId: 'sess-R' }).entries();
    expect(replayed).toHaveLength(1);
    expect(JSON.stringify(replayed)).not.toContain(SECRET);
    expect(replayed[0].outcome).toMatchObject({ ok: true, charsLanded: SECRET.length });
    const rawRows = db.prepare('SELECT * FROM studio_audit WHERE session_id = ?').all('sess-R');
    expect(JSON.stringify(rawRows)).not.toContain(SECRET);
    db.close();
  });
});

describe('createActHandler — co-drive announce (P4 ghost cursor + narration)', () => {
  it('click emits an unconditional {t:act} banner event AND a {t:point} ghost-cursor event at the resolved centre', async () => {
    const ch = recordingChannel();
    const act = createActHandler({
      ...base, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [3]), grant: denyGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 42, y: 84 } }), channel: ch.channel,
    });
    await act({ action: 'click', ref: 'e1', narration: 'opening FAQ' });
    // banner event fires FIRST (wrapper top), regardless of verdict; then the ghost-cursor point after resolve.
    expect(ch.announces[0]).toEqual({ t: 'act', action: 'click', narration: 'opening FAQ' });
    expect(ch.announces).toContainEqual({ t: 'point', center: { x: 42, y: 84 }, caption: 'opening FAQ' });
  });

  it('a GATE-refused act (human holds) still emits the {t:act} banner event but NO {t:point} (no cursor move, matches the salvaged unconditional-narration contract)', async () => {
    const ch = recordingChannel();
    const act = createActHandler({
      ...base, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('human', [9]), grant: denyGrant,
      resolve: fixedResolve({ backendNodeId: 7, center: { x: 1, y: 2 } }), channel: ch.channel,
    });
    const r = await act({ action: 'click', ref: 'e1', narration: 'trying to click' });
    expect((r as StudioToolError).error_reason).toBe('not_holder');
    expect(ch.announces).toContainEqual({ t: 'act', action: 'click', narration: 'trying to click' });
    expect(ch.announces.some((a) => a.t === 'point')).toBe(false); // never resolved → no ghost point
  });

  it('NEGATIVE: on a credential-page type refusal, NO page-derived field ever rides the announce (only {t,action,narration}/{t,center,caption})', async () => {
    const { result, ch } = await typeAtTarget({
      specs: [{ be: 100, role: 'textbox', name: 'Password', attrs: { type: 'password' } }],
      targetBe: 100, url: 'https://acme.example/login', text: 'hunter2',
    });
    expectCredentialRefused(result); // the type itself is refused…
    // …but the announce still fired (unconditional banner + post-resolve point). Lock that it carries no secret.
    const allowed = new Set(['t', 'action', 'narration', 'center', 'caption']);
    for (const a of ch.announces) {
      for (const k of Object.keys(a)) expect(allowed.has(k), `announce key '${k}' must not carry page-derived content`).toBe(true);
    }
  });
});

describe('§7 row 1 — a ref minted from a human-edited snapshot is refused as an act target', () => {
  const heldWith = () => {
    const held = new HeldSnapshot();
    held.hold({
      id: 's1', elements: [{ ref: 'e1', role: 'button', name: 'Pay' }], tokenCount: 1,
      overBudget: false, domTruncated: false, refMap: new Map([['e1', 9]]), groupByRef: new Map(), domParent: new Map(),
    });
    return held;
  };
  const landed = fixedResolve({ backendNodeId: 9, center: { x: 5, y: 6 } } as ResolveResult);

  it('the act result carries §7 row 1 verbatim, and does NOT dispatch', async () => {
    // The agent holds `e1` from a snapshot the human has since typed into: acting on it would act
    // on an address that no longer means what the agent read. MUT: drop the held check in
    // gateAndResolve → the click dispatches and this goes RED on both arms.
    const held = heldWith();
    held.humanEdit('key');
    const rec = recordingChannel();
    const act = createActHandler({
      ...base, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]),
      grant: denyGrant, resolve: landed, channel: rec.channel, held,
    });
    const e = asErr(await act({ action: 'click', ref: 'e1' }));
    expect(e.error_reason).toBe('page_changed_by_human');
    expect(e.hint).toContain('page changed by human — re-read');
    expect(rec.calls).toEqual([]);
  });

  it('EVERY ref-taking action is refused, not just the click that reveals it', async () => {
    for (const action of ['click', 'type'] as const) {
      const held = heldWith();
      held.humanEdit('paste');
      const rec = recordingChannel();
      const act = createActHandler({
        ...base, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]),
        grant: denyGrant, resolve: landed, channel: rec.channel, held,
      });
      expect(asErr(await act({ action, ref: 'e1', text: 'x' })).error_reason, action).toBe('page_changed_by_human');
      expect(rec.calls, action).toEqual([]);
    }
  });

  it('the ref-LESS actions are untouched — a mark is what goes stale, not the viewport', async () => {
    // scroll aims at the viewport centre and navigate takes a URL: neither addresses an element the
    // agent read, so refusing them would block progress without protecting anything. Pinning this
    // keeps the refusal narrow to §5's claim ("the stale snapshot's MARKS are refused").
    const held = heldWith();
    held.humanEdit('key');
    const rec = recordingChannel();
    const act = createActHandler({
      ...base, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]),
      grant: allowGrant, resolve: landed, channel: rec.channel, held,
    });
    expect(isStudioToolError(await act({ action: 'scroll', direction: 'down' }))).toBe(false);
    expect(isStudioToolError(await act({ action: 'navigate', url: 'https://example.com/' }))).toBe(false);
  });

  it('a live snapshot, or no holder at all, acts exactly as before', async () => {
    for (const held of [heldWith(), undefined]) {
      const rec = recordingChannel();
      const act = createActHandler({
        ...base, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]),
        grant: denyGrant, resolve: landed, channel: rec.channel, held,
      });
      expect(isStudioToolError(await act({ action: 'click', ref: 'e1' }))).toBe(false);
      expect(rec.calls.length).toBe(1);
    }
  });

  it('the refusal is audited as a refusal, so the run log shows why the act did not run', async () => {
    const db = migratedDb();
    const audit = new SessionAuditLog({ db, sessionId: 'sess-page-changed' });
    const held = heldWith();
    held.humanEdit('form_change');
    const act = createActHandler({
      ...base, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]),
      grant: denyGrant, resolve: landed, channel: recordingChannel().channel, held, audit,
    });
    await act({ action: 'click', ref: 'e1' });
    const rows = audit.entries();
    expect(rows.at(-1)).toMatchObject({ outcome: { ok: false, error_reason: 'page_changed_by_human' } });
    db.close();
  });
});
