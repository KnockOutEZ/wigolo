import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `activationNextStepLines` is the first-run block shared by BOTH init paths
 * (PX2 mini-spec §8, rewritten for PX brief §0a.1-3).
 *
 * WHAT IT USED TO BE. A single "Next step: run `wigolo register` to activate this
 * install" line, whose justification was that without it setup reported success and
 * the user's first tool call was refused with no clue what to do. §0a.1 removed the
 * refusal, so that justification is gone and the line would now be a lie: nothing
 * is pending. The never-registered arm returns an OFFER instead — what an account
 * would add — and the two arms that still have an imperative are the ones where the
 * user already has an account and something they were promised stopped working.
 *
 * The gate is mocked so each refusal reason can be driven without minting a signed
 * entitlement token; the never-registered arm runs the REAL gate against a real empty
 * data directory, which is the shape a fresh install actually has.
 */
const { evaluateActivationMock } = vi.hoisted(() => ({ evaluateActivationMock: vi.fn() }));

vi.mock('../../../src/account/gate.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/account/gate.js')>(
    '../../../src/account/gate.js',
  );
  return { ...actual, evaluateActivation: evaluateActivationMock };
});

import { activationNextStepLines } from '../../../src/cli/init.js';
import { REGISTRATION_UNLOCKS, UNREGISTERED_RUNS_LINE, TELEMETRY_CLAIM } from '../../../src/account/unlocks.js';
import { ACTIVATION_REFUSALS, type ActivationRefusalReason } from '../../../src/account/gate.js';

function refusal(reason: ActivationRefusalReason): unknown {
  const step = reason === 'expired' ? 'expired' : reason === 'update_required' ? 'unpinned_kid' : 'no_token';
  return { ok: false, step, reason, message: ACTIVATION_REFUSALS[reason] };
}

describe('activationNextStepLines — init\'s first-run block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers a fresh install the unlocks, and never implies it must register', async () => {
    // WHY: setup has just succeeded and every tool works. The block has to lead with
    // that and read as an offer — an imperative here ("Next step: register") tells a
    // user something is pending when nothing is, which is the exact claim §0a.1
    // retired. The real gate runs: an empty data dir has no token, so this is the
    // shape a fresh install actually produces.
    const actual = await vi.importActual<typeof import('../../../src/account/gate.js')>(
      '../../../src/account/gate.js',
    );
    evaluateActivationMock.mockImplementation(actual.evaluateActivation);
    const dataDir = mkdtempSync(join(tmpdir(), 'wigolo-init-hint-'));
    const lines = await activationNextStepLines(dataDir, {}, Date.now());
    const block = lines.join('\n');
    expect(block).toContain(UNREGISTERED_RUNS_LINE);
    expect(block).toContain('wigolo register');
    // The unlock LIST, not just the verb — that is what §0a.3 asks first-run to carry.
    for (const unlock of REGISTRATION_UNLOCKS) expect(block).toContain(unlock);
    // And the telemetry claim, in the §0a.4 wording, at the one moment the user is
    // deciding whether to hand over an email address.
    expect(block).toContain(TELEMETRY_CLAIM);
    // No imperative: this arm is the difference between an offer and a wall.
    expect(block).not.toMatch(/^Next step: /m);
  });

  it('says nothing at all on a registered install', async () => {
    // WHY: an offer that keeps printing after it has been accepted is a nag, and init
    // already prints a long report. An empty array is how the caller suppresses it.
    evaluateActivationMock.mockReturnValue({ ok: true, step: 'perpetual' });
    expect(await activationNextStepLines('/nonexistent', {}, 0)).toEqual([]);
  });

  it('sends an EXPIRED sign-in to `login`, never to `register`', async () => {
    // WHY: the regression this arm exists for — telling someone whose sign-in expired to
    // register would have them create a SECOND account against the same email. This arm
    // survives §0a.1 unchanged: the user HAS an account, and unlocks they were promised
    // have stopped working, so an imperative is the honest register here.
    evaluateActivationMock.mockReturnValue(refusal('expired'));
    const block = (await activationNextStepLines('/nonexistent', {}, 0)).join('\n');
    expect(block).toContain('wigolo login');
    expect(block).not.toContain('wigolo register');
  });

  it('sends an UPDATE-REQUIRED install to update, never to `register`', async () => {
    // WHY: same class as above. Re-registering cannot fix a signing key this build does
    // not hold, so the line must not offer it as a remedy.
    evaluateActivationMock.mockReturnValue(refusal('update_required'));
    const block = (await activationNextStepLines('/nonexistent', {}, 0)).join('\n');
    expect(block).toContain('update wigolo');
    expect(block).toContain('wigolo login');
    expect(block).not.toContain('wigolo register');
  });

  it('has a block for EVERY refusal reason the gate can return', async () => {
    // WHY: exhaustiveness against the gate, not against this file's own list. A reason
    // added to `ACTIVATION_REFUSALS` with no branch here would silently print nothing.
    // The `Next step:` shape is asserted only for the reasons that still carry an
    // imperative — never_activated deliberately does not, which is checked above.
    for (const reason of Object.keys(ACTIVATION_REFUSALS) as ActivationRefusalReason[]) {
      evaluateActivationMock.mockReturnValue(refusal(reason));
      const lines = await activationNextStepLines('/nonexistent', {}, 0);
      expect(lines.length, `no block for refusal reason "${reason}"`).toBeGreaterThan(0);
      if (reason !== 'never_activated') expect(lines[0]).toMatch(/^Next step: /);
    }
  });

  it('returns an empty block rather than throwing when the gate blows up', async () => {
    // WHY: a discoverability hint must never be able to fail setup or change its exit code.
    evaluateActivationMock.mockImplementation(() => { throw new Error('boom'); });
    expect(await activationNextStepLines('/nonexistent', {}, 0)).toEqual([]);
  });

  it('keeps the block in capability language — no implementation names', async () => {
    evaluateActivationMock.mockReturnValue(refusal('never_activated'));
    const block = (await activationNextStepLines('/nonexistent', {}, 0)).join('\n');
    expect(block).not.toMatch(/playwright|chromium|searxng|electron|postgres|ed25519|jwt/i);
  });
});
