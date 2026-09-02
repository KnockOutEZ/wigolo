/**
 * Account fixtures for the activation gate's surface tests.
 *
 * Everything here builds a REAL signed entitlement token with a real keypair and
 * feeds it through the shipped verifier — there is no stub decision anywhere in
 * this file. That matters because the gate's whole value is that it cannot be
 * satisfied by anything except a token the pinned key signs; a fixture that
 * short-circuited the decision would make every arm below agree with itself.
 *
 * The mint helper is the accounts lane's (`tests/unit/account/mint-entitlement.ts`)
 * and is deliberately built from Node's own primitives rather than from
 * `src/account/`, so a token minted here is an OUTSIDE signal about the verifier
 * rather than a restatement of it.
 */

import {
  generateMintKeyPair,
  mintToken,
  grant,
  payload,
  type MintKeyPair,
} from '../account/mint-entitlement.js';
import { EMPTY_ACCOUNT_STATE, type AccountState } from '../../../src/account/state.js';
import { resolvePinnedKeys, type PinnedKey } from '../../../src/account/pinned-keys.js';
import {
  createActivationChecker,
  setActivationChecker,
  type ActivationSource,
} from '../../../src/server/activation.js';

export interface AccountFixture {
  readonly keys: MintKeyPair;
  readonly pinned: readonly PinnedKey[];
  readonly state: AccountState;
}

/** A perpetual `core` grant — what every registered account holds day one. */
export function perpetualAccount(overrides: Partial<AccountState> = {}): AccountFixture {
  const keys = generateMintKeyPair();
  const { token } = mintToken(
    keys,
    payload({
      account_id: 'acct_fixture',
      valid_until: '2099-01-01T00:00:00.000Z',
      grants: [grant({ product: 'core', type: 'perpetual' })],
    }),
  );
  return {
    keys,
    pinned: resolvePinnedKeys({ WIGOLO_ACCOUNTS_PUBKEY: keys.publicKeyB64Url }).keys,
    state: {
      ...EMPTY_ACCOUNT_STATE,
      account_id: 'acct_fixture',
      email: 'fixture@example.invalid',
      entitlement_token: token,
      last_refresh_at: new Date().toISOString(),
      ...overrides,
    },
  };
}

/**
 * A SUBSCRIPTION account: no perpetual grant, so the gate walks past step 3 and
 * the token's own `valid_until` and the 14-day grace decide. This is the only
 * shape whose activation can expire, which makes it the only shape a grace-
 * boundary test can be written against.
 */
export function subscriptionAccount(opts: {
  validUntil: string;
  lastRefreshAt: string;
}): AccountFixture {
  const keys = generateMintKeyPair();
  const { token } = mintToken(
    keys,
    payload({
      account_id: 'acct_sub',
      valid_until: opts.validUntil,
      grants: [grant({ product: 'core', type: 'subscription', expires: opts.validUntil })],
    }),
  );
  return {
    keys,
    pinned: resolvePinnedKeys({ WIGOLO_ACCOUNTS_PUBKEY: keys.publicKeyB64Url }).keys,
    state: {
      ...EMPTY_ACCOUNT_STATE,
      account_id: 'acct_sub',
      email: 'sub@example.invalid',
      entitlement_token: token,
      last_refresh_at: opts.lastRefreshAt,
    },
  };
}

/** An install that has never registered: no token at all. */
export const NEVER_ACTIVATED: AccountState = { ...EMPTY_ACCOUNT_STATE };

export function sourceFor(
  fixture: AccountFixture,
  now: () => number = () => Date.now(),
): ActivationSource {
  return { now, readState: () => fixture.state, readKeys: () => fixture.pinned };
}

/**
 * Install a process-wide checker for the duration of a test and hand back the
 * undo. Files that use this are asserting something OTHER than activation and
 * say so where they call it.
 */
export function installChecker(source: ActivationSource, reloadMs?: number): () => void {
  setActivationChecker(createActivationChecker(source, reloadMs));
  return () => setActivationChecker(null);
}

/** The common case: this file is not about the gate, so run it activated. */
export function installActivated(): () => void {
  return installChecker(sourceFor(perpetualAccount()));
}
