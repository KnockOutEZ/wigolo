/**
 * The six-step activation evaluation (A-212-12), every arm forced.
 *
 * WHY THE CLOCK IS A PARAMETER AND WHY THAT IS THE WHOLE POINT. Step 5's
 * fourteen-day grace is not testable by waiting; the boundary arm here sits one
 * millisecond either side of `last_refresh_at + 14d`, which only exists as a
 * test because `now` is injected end-to-end. A single `Date.now()` in the
 * decision path would make the two boundary assertions below unwritable.
 *
 * WHY EACH ARM CARRIES A NON-VACUITY CONTROL. "Refused" is the answer to a lot
 * of different questions, so an arm that only asserts a refusal proves nothing
 * about WHICH step fired. Every arm asserts the step as well as the outcome,
 * and the arms that could be reached by an earlier step assert their neighbour
 * explicitly — the perpetual arm, for instance, ships a token whose
 * `valid_until` is already in the past, so it cannot be passing at step 4.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateActivation,
  requireActivation,
  ACTIVATION_REFUSALS,
  ACTIVATION_GRACE_MS,
  type ActivationInput,
} from '../../../src/account/gate.js';
import { EMPTY_ACCOUNT_STATE, type AccountState } from '../../../src/account/state.js';
import {
  importAccountsPublicKey,
  ACCOUNTS_PUBKEY_ENV,
  SENTINEL_ACCOUNTS_PUBKEY,
  type PinnedKey,
} from '../../../src/account/pinned-keys.js';
import {
  generateMintKeyPair,
  mintToken,
  mintTokenFromSerialization,
  canonicalJson,
  payload,
  grant,
  type MintKeyPair,
} from './mint-entitlement.js';

const AT = (iso: string): number => Date.parse(iso);
const NOW = AT('2026-09-05T00:00:00.000Z');

function pin(keys: MintKeyPair): PinnedKey[] {
  const imported = importAccountsPublicKey(keys.publicKeyB64Url);
  if (!imported) throw new Error('test key failed to import');
  return [imported];
}

function stateWith(patch: Partial<AccountState>): AccountState {
  return { ...EMPTY_ACCOUNT_STATE, ...patch };
}

/** A subscription-only payload — nothing that could pass at step 3. */
const subscriptionPayload = (validUntil: string): Record<string, unknown> =>
  payload({
    valid_until: validUntil,
    grants: [grant({ type: 'subscription', features: ['studio'], expires: validUntil })],
  });

describe('step 1 — no state, no token', () => {
  it.each([
    ['a completely empty state', EMPTY_ACCOUNT_STATE],
    ['a null token', stateWith({ account_id: 'acct_1', entitlement_token: null })],
    ['a blank token', stateWith({ account_id: 'acct_1', entitlement_token: '   ' })],
  ])('refuses %s as never-activated', (_label, state) => {
    const decision = evaluateActivation({ state, keys: [] }, NOW);

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.step).toBe('no_token');
    expect(decision.reason).toBe('never_activated');
    expect(decision.message).toBe(ACTIVATION_REFUSALS.never_activated);
  });
});

describe('step 2 — the kid-aware signature arm', () => {
  it('refuses a token whose kid IS pinned but whose signature fails, as never-activated', () => {
    const keys = generateMintKeyPair();
    const body = canonicalJson(payload());
    // Same key, same kid — but the shipped bytes are not the signed bytes.
    const minted = mintTokenFromSerialization(keys, body, `${body} `);

    const decision = evaluateActivation(
      { state: stateWith({ entitlement_token: minted.token }), keys: pin(keys) },
      NOW,
    );

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.step).toBe('signature');
    expect(decision.reason).toBe('never_activated');
    expect(decision.message).toBe(ACTIVATION_REFUSALS.never_activated);

    // Non-vacuity: the untouched token from the same key passes.
    expect(
      evaluateActivation(
        { state: stateWith({ entitlement_token: mintToken(keys, payload()).token }), keys: pin(keys) },
        NOW,
      ).ok,
    ).toBe(true);
  });

  it('refuses a token whose kid matches NO pinned key with the "update wigolo" line', () => {
    const service = generateMintKeyPair();
    const shipped = generateMintKeyPair();
    const token = mintToken(service, payload()).token;

    const decision = evaluateActivation(
      { state: stateWith({ entitlement_token: token }), keys: pin(shipped) },
      NOW,
    );

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.step).toBe('unpinned_kid');
    expect(decision.reason).toBe('update_required');
    expect(decision.message).toBe(ACTIVATION_REFUSALS.update_required);

    // The whole point of the split: a rotation miss must never say "register".
    expect(decision.message).not.toContain('register');
    expect(decision.message).toContain('update wigolo');
  });

  it('refuses a structurally broken token as never-activated', () => {
    const decision = evaluateActivation(
      { state: stateWith({ entitlement_token: 'not-a-token' }), keys: [] },
      NOW,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('never_activated');
  });

  it('refuses everything under the shipped sentinel pin', () => {
    // 0.3.0 ships a placeholder key. A real token must not pass against it.
    const service = generateMintKeyPair();
    const sentinel = importAccountsPublicKey(SENTINEL_ACCOUNTS_PUBKEY);
    if (!sentinel) throw new Error('sentinel failed to import');

    const decision = evaluateActivation(
      { state: stateWith({ entitlement_token: mintToken(service, payload()).token }), keys: [sentinel] },
      NOW,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.step).toBe('unpinned_kid');
  });
});

describe('step 3 — a perpetual core grant passes forever', () => {
  it('passes with an expired `valid_until` AND an exhausted grace window', () => {
    const keys = generateMintKeyPair();
    const token = mintToken(
      keys,
      payload({
        valid_until: '2020-01-01T00:00:00.000Z',
        grants: [grant({ product: 'core', type: 'perpetual' })],
      }),
    ).token;

    const state = stateWith({
      entitlement_token: token,
      last_refresh_at: '2020-01-01T00:00:00.000Z',
    });

    const decision = evaluateActivation({ state, keys: pin(keys) }, NOW);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.step).toBe('perpetual');

    // Non-vacuity: strip perpetuity from that exact token and it refuses.
    const subscription = mintToken(
      keys,
      payload({
        valid_until: '2020-01-01T00:00:00.000Z',
        grants: [grant({ product: 'core', type: 'subscription', expires: '2020-01-01T00:00:00.000Z' })],
      }),
    ).token;
    const refused = evaluateActivation(
      { state: { ...state, entitlement_token: subscription }, keys: pin(keys) },
      NOW,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('expired');
  });

  it('does not treat a perpetual grant for another product as activation', () => {
    const keys = generateMintKeyPair();
    const token = mintToken(
      keys,
      payload({
        valid_until: '2020-01-01T00:00:00.000Z',
        grants: [grant({ product: 'studio', type: 'perpetual' })],
      }),
    ).token;

    const decision = evaluateActivation(
      { state: stateWith({ entitlement_token: token }), keys: pin(keys) },
      NOW,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('expired');
  });
});

describe('step 4 — the token is still inside its own validity window', () => {
  it('passes while `valid_until >= now` and refuses one millisecond later', () => {
    const keys = generateMintKeyPair();
    const validUntil = '2026-09-08T00:00:00.000Z';
    const token = mintToken(keys, subscriptionPayload(validUntil)).token;
    // No grace: the last successful refresh is far enough back to be exhausted.
    const state = stateWith({ entitlement_token: token, last_refresh_at: '2020-01-01T00:00:00.000Z' });

    const at = (now: number) => evaluateActivation({ state, keys: pin(keys) }, now);

    expect(at(AT(validUntil) - 1).ok).toBe(true);
    const boundary = at(AT(validUntil));
    expect(boundary.ok).toBe(true);
    if (boundary.ok) expect(boundary.step).toBe('token_valid');

    const past = at(AT(validUntil) + 1);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.reason).toBe('expired');
  });

  it('does not accept an unparseable `valid_until` as a valid window', () => {
    const keys = generateMintKeyPair();
    const token = mintToken(
      keys,
      payload({ valid_until: 'whenever', grants: [grant({ type: 'subscription', expires: null })] }),
    ).token;

    const decision = evaluateActivation(
      { state: stateWith({ entitlement_token: token }), keys: pin(keys) },
      NOW,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('expired');
  });
});

describe('step 5 — the rolling 14-day grace, exact at the boundary', () => {
  const keys = generateMintKeyPair();
  const expiredToken = mintToken(keys, subscriptionPayload('2026-08-01T00:00:00.000Z')).token;
  const lastRefresh = '2026-08-20T00:00:00.000Z';
  const state = stateWith({ entitlement_token: expiredToken, last_refresh_at: lastRefresh });
  const deadline = AT(lastRefresh) + ACTIVATION_GRACE_MS;

  const at = (now: number) => evaluateActivation({ state, keys: pin(keys) }, now);

  it('is exactly fourteen days long', () => {
    expect(ACTIVATION_GRACE_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(new Date(deadline).toISOString()).toBe('2026-09-03T00:00:00.000Z');
  });

  it('passes one millisecond BEFORE the boundary, at step 5 and not step 4', () => {
    const decision = at(deadline - 1);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.step).toBe('grace');
  });

  it('passes AT the boundary — the fourteenth day is inside the window', () => {
    const decision = at(deadline);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.step).toBe('grace');
  });

  it('refuses one millisecond PAST the boundary', () => {
    const decision = at(deadline + 1);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.step).toBe('expired');
    expect(decision.reason).toBe('expired');
    expect(decision.message).toBe(ACTIVATION_REFUSALS.expired);
  });

  it('is measured from `last_refresh_at`, never from `valid_until`', () => {
    // If grace were measured from the token's own expiry (2026-08-01) the
    // window would run to 2026-08-15 and this would refuse; from the last
    // successful refresh (2026-08-20) it runs to 2026-09-03 and this passes.
    expect(at(AT('2026-09-01T00:00:00.000Z')).ok).toBe(true);
    expect(at(AT('2026-08-16T00:00:00.000Z')).ok).toBe(true);
  });

  it('offers no grace at all when no refresh has ever succeeded', () => {
    const never = stateWith({ entitlement_token: expiredToken, last_refresh_at: null });
    const decision = evaluateActivation({ state: never, keys: pin(keys) }, NOW);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.step).toBe('expired');
  });

  it('offers no grace from an unparseable `last_refresh_at`', () => {
    const bent = stateWith({ entitlement_token: expiredToken, last_refresh_at: 'sometime' });
    const decision = evaluateActivation({ state: bent, keys: pin(keys) }, NOW);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.step).toBe('expired');
  });
});

describe('the three refusal lines are the pinned copy', () => {
  it('matches mini-spec §3 verbatim', () => {
    expect(ACTIVATION_REFUSALS.never_activated).toBe(
      'wigolo needs an account — run `wigolo register` to create one (already have one? `wigolo login`).',
    );
    expect(ACTIVATION_REFUSALS.expired).toBe(
      'Your wigolo sign-in has expired — run `wigolo login` to reconnect.',
    );
    expect(ACTIVATION_REFUSALS.update_required).toBe(
      'wigolo needs an update to verify your sign-in — update wigolo, then run `wigolo login`.',
    );
  });

  it('is one line each, with no product-tier adjective and no implementation nouns', () => {
    for (const line of Object.values(ACTIVATION_REFUSALS)) {
      expect(line).not.toContain('\n');
      expect(line).not.toMatch(/\bfree\b|\bpremium\b|\bpro\b|\btier\b/i);
      expect(line).not.toMatch(/ed25519|signature|jwt|token|playwright|cdp/i);
    }
  });
});

describe('requireActivation — the seam the gated surfaces call', () => {
  it('resolves its keys from the environment when none are supplied', () => {
    const keys = generateMintKeyPair();
    const token = mintToken(keys, payload({ grants: [grant({ product: 'core', type: 'perpetual' })] })).token;
    const state = stateWith({ entitlement_token: token });

    // Under the shipped pins the same token is a rotation miss…
    const shipped = requireActivation(NOW, { state, env: {} });
    expect(shipped.ok).toBe(false);
    if (!shipped.ok) expect(shipped.reason).toBe('update_required');

    // …and under the override it activates.
    const overridden = requireActivation(NOW, {
      state,
      env: { [ACCOUNTS_PUBKEY_ENV]: keys.publicKeyB64Url },
    });
    expect(overridden.ok).toBe(true);
    if (overridden.ok) expect(overridden.step).toBe('perpetual');
  });

  it('takes `now` from its caller — the decision path holds no clock of its own', () => {
    const keys = generateMintKeyPair();
    const validUntil = '2026-09-08T00:00:00.000Z';
    const state = stateWith({
      entitlement_token: mintToken(keys, subscriptionPayload(validUntil)).token,
      last_refresh_at: '2020-01-01T00:00:00.000Z',
    });
    const input: ActivationInput = { state, keys: pin(keys) };

    expect(evaluateActivation(input, AT(validUntil)).ok).toBe(true);
    expect(evaluateActivation(input, AT(validUntil) + 1).ok).toBe(false);
  });
});
