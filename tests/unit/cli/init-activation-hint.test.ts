import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `activationNextStepLine` is the first-run affordance shared by BOTH init paths
 * (PX2 mini-spec §8). Without it setup reports success and the user's first tool call
 * is refused with no clue what to do.
 *
 * The gate is mocked so each refusal reason can be driven without minting a signed
 * entitlement token; the never-activated arm runs the REAL gate against a real empty
 * data directory, which is the shape a fresh install actually has.
 */
const { evaluateActivationMock } = vi.hoisted(() => ({ evaluateActivationMock: vi.fn() }));

vi.mock('../../../src/account/gate.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/account/gate.js')>(
    '../../../src/account/gate.js',
  );
  return { ...actual, evaluateActivation: evaluateActivationMock };
});

import { activationNextStepLine } from '../../../src/cli/init.js';
import { ACTIVATION_REFUSALS, type ActivationRefusalReason } from '../../../src/account/gate.js';

function refusal(reason: ActivationRefusalReason): unknown {
  const step = reason === 'expired' ? 'expired' : reason === 'update_required' ? 'unpinned_kid' : 'no_token';
  return { ok: false, step, reason, message: ACTIVATION_REFUSALS[reason] };
}

describe('activationNextStepLine — init\'s first-run next step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('points a fresh install at `wigolo register`, through the real gate', async () => {
    // WHY: the whole point of the line. An empty data dir has no entitlement token, so
    // the real gate refuses at step 1 and the user must be sent to register.
    const actual = await vi.importActual<typeof import('../../../src/account/gate.js')>(
      '../../../src/account/gate.js',
    );
    evaluateActivationMock.mockImplementation(actual.evaluateActivation);
    const dataDir = mkdtempSync(join(tmpdir(), 'wigolo-init-hint-'));
    const line = await activationNextStepLine(dataDir, {}, Date.now());
    expect(line).toContain('wigolo register');
    expect(line).toContain('wigolo login');
  });

  it('says nothing at all on an activated install', async () => {
    // WHY: a hint that keeps printing after it has been acted on is a nag, and init
    // already prints a long report. `null` is how the caller suppresses the block.
    evaluateActivationMock.mockReturnValue({ ok: true, step: 'perpetual' });
    expect(await activationNextStepLine('/nonexistent', {}, 0)).toBeNull();
  });

  it('sends an EXPIRED sign-in to `login`, never to `register`', async () => {
    // WHY: the regression this arm exists for — telling someone whose sign-in expired to
    // register would have them create a SECOND account against the same email.
    evaluateActivationMock.mockReturnValue(refusal('expired'));
    const line = await activationNextStepLine('/nonexistent', {}, 0);
    expect(line).toContain('wigolo login');
    expect(line).not.toContain('wigolo register');
  });

  it('sends an UPDATE-REQUIRED install to update, never to `register`', async () => {
    // WHY: same class as above. Re-registering cannot fix a signing key this build does
    // not hold, so the line must not offer it as a remedy.
    evaluateActivationMock.mockReturnValue(refusal('update_required'));
    const line = await activationNextStepLine('/nonexistent', {}, 0);
    expect(line).toContain('update wigolo');
    expect(line).toContain('wigolo login');
    expect(line).not.toContain('wigolo register');
  });

  it('has a line for EVERY refusal reason the gate can return', async () => {
    // WHY: exhaustiveness against the gate, not against this file's own list. A reason
    // added to `ACTIVATION_REFUSALS` with no branch here would silently print nothing —
    // a refused install told setup was complete.
    for (const reason of Object.keys(ACTIVATION_REFUSALS) as ActivationRefusalReason[]) {
      evaluateActivationMock.mockReturnValue(refusal(reason));
      const line = await activationNextStepLine('/nonexistent', {}, 0);
      expect(line, `no next-step line for refusal reason "${reason}"`).toBeTruthy();
      expect(line).toMatch(/^Next step: /);
    }
  });

  it('returns null rather than throwing when the gate blows up', async () => {
    // WHY: a discoverability hint must never be able to fail setup or change its exit code.
    evaluateActivationMock.mockImplementation(() => { throw new Error('boom'); });
    expect(await activationNextStepLine('/nonexistent', {}, 0)).toBeNull();
  });

  it('keeps the line in capability language — no implementation names', async () => {
    evaluateActivationMock.mockReturnValue(refusal('never_activated'));
    const line = await activationNextStepLine('/nonexistent', {}, 0);
    expect(line).not.toMatch(/playwright|chromium|searxng|electron|postgres|ed25519|jwt/i);
  });
});
