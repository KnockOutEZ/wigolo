import { describe, it, expect } from 'vitest';
import { createSessionDrive, type DriveControlToken, type SessionDriveDeps } from '../../../src/studio/session-drive.js';
import { OriginBudget } from '../../../src/studio/origin-budget.js';
import type { NavigableBrowser } from '../../../src/studio/nav.js';
import type { ControlParty } from '../../../src/studio/control-token.js';

/**
 * D19 — the session DRIVE SEAM gate, ISOLATED per layer. The integration pin (studio-session-target) proves
 * the end-to-end not_holder verdict through the real daemon; these two unit pins isolate the TWO INDEPENDENT
 * blocking layers of gatedNavigate so a regression in either is caught even though the other still blocks:
 *
 *   (1) the CONTROL-TOKEN gate (assertCanDrive) — proven with the epoch fence held in its ALLOW state
 *       (live holder='agent'), so the GATE is the SOLE blocker: skip assertCanDrive ⇒ it navigates.
 *   (2) the EPOCH FENCE backstop (beforeNavigate) — proven with the control gate held OPEN
 *       (assertCanDrive ⇒ ok), so the FENCE is the SOLE blocker: remove the fence ⇒ it navigates.
 *
 * Without this split a single pin only proves "blocked by SOMETHING" — the two layers could drift apart
 * (e.g. assertCanDrive deleted, only the fence catching) and an error-string-agnostic test would stay green.
 */

interface FakeBrowser extends NavigableBrowser {
  calls: string[];
}
function fakeBrowser(): FakeBrowser {
  const calls: string[] = [];
  return {
    calls,
    navigate: async (url: string) => {
      calls.push(url);
    },
  };
}

/** A control token whose gate verdict + live holder/epoch are set INDEPENDENTLY, so each gatedNavigate layer is isolatable. */
function fakeToken(opts: {
  holder: ControlParty;
  epoch: number;
  gate: { ok: true } | { ok: false; reason: string; currentEpoch: number };
}): DriveControlToken {
  return { holder: opts.holder, epoch: opts.epoch, assertCanDrive: () => opts.gate };
}

function makeDrive(token: DriveControlToken, browser: NavigableBrowser) {
  const deps: SessionDriveDeps = {
    browser,
    controlToken: token,
    grant: { humanAllowPrivate: true, agentAllowPrivate: true },
    currentUrl: () => 'https://example.com',
    readHtml: async () => '<html></html>',
    insert: async () => ({ id: 1, inserted: true, contentHash: 'x' }),
    isCredentialContext: async () => false,
    // A budget generous enough to be irrelevant here: these two cases isolate the control gate and the epoch
    // fence, so D9 must not be the thing that blocks them.
    driveGate: { budget: new OriginBudget({ limit: 1000 }) },
  };
  return createSessionDrive(deps);
}

describe('createSessionDrive.gatedNavigate — isolated control-gate + epoch-fence layers', () => {
  it('CONTROL GATE: a non-holder is refused not_holder and never navigates — fence held OPEN, so the gate is the sole blocker', async () => {
    // live holder='agent' would let the epoch fence (holder==='agent') PASS — so the ONLY thing that can block
    // here is the control-token gate. assertCanDrive is decoupled to return not_holder.
    const browser = fakeBrowser();
    const token = fakeToken({ holder: 'agent', epoch: 0, gate: { ok: false, reason: 'not_holder', currentEpoch: 0 } });
    const r = await makeDrive(token, browser).gatedNavigate('https://example.com');
    expect(r, 'the CONTROL-TOKEN gate (not the fence) blocks a non-holder').toEqual({ ok: false, reason: 'not_holder', currentEpoch: 0 });
    expect(browser.calls, 'no navigation when the control gate refuses').toEqual([]);
    // MUTATION (skip assertCanDrive in session-drive.ts gatedNavigate): the fence is held open (holder='agent')
    // ⇒ removing the control gate NAVIGATES ⇒ r becomes {ok:true} and browser.calls === ['https://example.com']
    // ⇒ both assertions RED. The control gate alone is proven (an epoch-fence block would never satisfy these).
  });

  it('EPOCH FENCE: a gate-passing nav whose live holder is no longer the agent stands down aborted_reclaimed — gate held OPEN, so the fence is the sole blocker', async () => {
    // assertCanDrive returns ok (the control gate is held open), but the LIVE holder is 'human' ⇒ the ONLY thing
    // that can block here is the entry epoch fence (beforeNavigate: holder==='agent').
    const browser = fakeBrowser();
    const token = fakeToken({ holder: 'human', epoch: 0, gate: { ok: true } });
    const r = await makeDrive(token, browser).gatedNavigate('https://example.com');
    expect(r, 'the EPOCH FENCE stands the agent down when the live holder is not the agent').toEqual({ ok: false, reason: 'aborted_reclaimed' });
    expect(browser.calls, 'no navigation when the fence stands down').toEqual([]);
    // MUTATION (remove the beforeNavigate fence — e.g. beforeNavigate: () => true): the gate is held open ⇒
    // removing the fence NAVIGATES ⇒ r becomes {ok:true} and browser.calls === ['https://example.com'] ⇒ both
    // assertions RED. The epoch fence alone is proven (the control gate already passed).
  });
});
