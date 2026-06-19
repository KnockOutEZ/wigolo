import { describe, it, expect } from 'vitest';
import { createActHandler, keystrokeEvents, type ActControlToken } from '../../../src/studio/act.js';
import type { NavGrant } from '../../../src/studio/nav-policy.js';
import type { ControlParty } from '../../../src/studio/control-token.js';
import type { AgentInputEvent } from '../../../src/studio/input.js';
import type { ResolveResult } from '../../../src/studio/perception/resolve.js';
import { isStudioToolError, type StudioActOutput, type StudioToolError } from '../../../src/daemon/studio-dispatch.js';
import { SessionAuditLog } from '../../../src/studio/audit.js';

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
  let n = 0;
  return {
    channel: {
      dispatchAgentUnit: async (epoch: number, events: AgentInputEvent[]) => {
        const landed = lands(n++);
        calls.push({ epoch, events, landed });
        return landed;
      },
      viewportCenter: () => ({ x: 400, y: 300 }),
    },
    calls,
  };
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

  it('refuses an action that is not navigate|click|type|scroll', async () => {
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
    expect(audit.replay()).toEqual([
      { seq: 1, ts: 1000, action: 'navigate', epoch: 3, target: { url: 'https://example.com/' }, outcome: { ok: true } },
    ]);
  });

  it('records a REFUSED action (human holds) with the not_holder outcome — refusals are audited too', async () => {
    const audit = new SessionAuditLog(fixedClock);
    const act = createActHandler({ ...base, audit, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('human', [7]), grant: denyGrant });
    await act({ action: 'navigate', url: 'https://example.com/' });
    expect(audit.replay()).toEqual([
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
    expect(audit.replay()).toEqual([
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
    expect(audit.replay()).toEqual([
      { seq: 1, ts: 1000, action: 'type', epoch: 5, target: { ref: 'e1' }, outcome: { ok: false, error_reason: 'aborted_reclaimed', charsLanded: 1 } },
    ]);
  });

  it('records an UNKNOWN action verb (rejected, but never silently dropped from the trail)', async () => {
    const audit = new SessionAuditLog(fixedClock);
    const act = createActHandler({ ...base, audit, browser: makeFakeBrowser().browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    await act({ action: 'frobnicate' } as unknown as { action: 'navigate' });
    expect(audit.replay()).toEqual([
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
    expect(audit.replay().map((e) => ({ seq: e.seq, action: e.action, outcome: e.outcome }))).toEqual([
      { seq: 1, action: 'navigate', outcome: { ok: true } },
      { seq: 2, action: 'scroll', outcome: { ok: true } },
      { seq: 3, action: 'click', outcome: { ok: true } },
      { seq: 4, action: 'type', outcome: { ok: true, charsLanded: 2 } }, // success-path charsLanded is audited too
    ]);
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
