import { describe, it, expect } from 'vitest';
import { createActHandler, type ActControlToken } from '../../../src/studio/act.js';
import type { NavGrant } from '../../../src/studio/nav-policy.js';
import type { ControlParty } from '../../../src/studio/control-token.js';
import { isStudioToolError, type StudioActOutput, type StudioToolError } from '../../../src/daemon/studio-dispatch.js';

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

const asErr = (x: StudioActOutput | StudioToolError): StudioToolError => {
  expect(isStudioToolError(x)).toBe(true);
  return x as StudioToolError;
};

describe('createActHandler — navigate', () => {
  it('refuses when the human holds the token (gate before acting), returning currentEpoch for resync', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ browser: b.browser, controlToken: makeFakeToken('human', [7]), grant: denyGrant });
    const e = asErr(await act({ action: 'navigate', url: 'https://example.com/' }));
    expect(e.error_reason).toBe('not_holder');
    expect(e.currentEpoch).toBe(7);
    expect(b.gotos).toEqual([]); // never navigated
  });

  it('navigates a public URL when the agent holds', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ browser: b.browser, controlToken: makeFakeToken('agent', [3]), grant: denyGrant });
    const r = await act({ action: 'navigate', url: 'https://example.com/' });
    expect(isStudioToolError(r)).toBe(false);
    expect(r).toMatchObject({ ok: true, action: 'navigate', url: 'https://example.com/' });
    expect(b.gotos).toEqual(['https://example.com/']);
  });

  it('blocks the agent from cloud-metadata EVEN WITH the private-nav grant (no SSRF lane)', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ browser: b.browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    expect(asErr(await act({ action: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' })).error_reason).toBe('navigation_blocked');
    expect(asErr(await act({ action: 'navigate', url: 'http://metadata.google.internal/' })).error_reason).toBe('navigation_blocked');
    expect(b.gotos).toEqual([]);
  });

  it('blocks the agent from localhost/RFC1918 by default; allows it only with the grant', async () => {
    const blocked = makeFakeBrowser();
    const actNoGrant = createActHandler({ browser: blocked.browser, controlToken: makeFakeToken('agent', [1]), grant: denyGrant });
    expect(asErr(await actNoGrant({ action: 'navigate', url: 'http://localhost:3000/' })).error_reason).toBe('navigation_blocked');
    expect(blocked.gotos).toEqual([]);

    const allowed = makeFakeBrowser();
    const actGranted = createActHandler({ browser: allowed.browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    const r = await actGranted({ action: 'navigate', url: 'http://localhost:3000/' });
    expect(isStudioToolError(r)).toBe(false);
    expect(allowed.gotos).toEqual(['http://localhost:3000/']);
  });

  it('refuses non-http(s) schemes for the agent (scheme allowlist)', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ browser: b.browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    expect(asErr(await act({ action: 'navigate', url: 'file:///etc/passwd' })).error_reason).toBe('navigation_protocol');
    expect(asErr(await act({ action: 'navigate', url: 'javascript:alert(1)' })).error_reason).toBe('navigation_protocol');
    expect(b.gotos).toEqual([]);
  });

  it('EPOCH FENCE: a reclaim in the gate→nav-start window aborts WITHOUT navigating (aborted_reclaimed)', async () => {
    // gate passes at epoch 5; the fence re-reads the epoch right before the nav command
    // and sees 6 (a reclaim landed) → stand down, never navigate under the revoked grant.
    const b = makeFakeBrowser();
    const act = createActHandler({ browser: b.browser, controlToken: makeFakeToken('agent', [5, 6]), grant: allowGrant });
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
    const act = createActHandler({ browser: b.browser, controlToken: makeFakeToken('agent', [5, 5, 6]), grant: allowGrant });
    const e = asErr(await act({ action: 'navigate', url: 'https://example.com/' }));
    expect(e.error_reason).toBe('aborted_reclaimed');
    expect(b.gotos).toEqual(['https://example.com/']); // it did start before the abort
  });

  it('a genuine site failure (no reclaim) stays navigation_failed (not masked as a stand-down)', async () => {
    const b = makeFakeBrowser(async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); });
    const act = createActHandler({ browser: b.browser, controlToken: makeFakeToken('agent', [4]), grant: allowGrant });
    expect(asErr(await act({ action: 'navigate', url: 'https://nope.example/' })).error_reason).toBe('navigation_failed');
  });

  it('refuses non-navigate actions in this slice (navigate-only; click/type/scroll are a later slice)', async () => {
    const b = makeFakeBrowser();
    const act = createActHandler({ browser: b.browser, controlToken: makeFakeToken('agent', [1]), grant: allowGrant });
    expect(asErr(await act({ action: 'click', ref: 'e1' })).error_reason).toBe('action_not_supported');
    expect(b.gotos).toEqual([]);
  });
});
