/**
 * PX2 RC exit gate — shared gating and paths (mini-spec §11-H, §13).
 *
 * WHY THESE ARMS ARE OPT-IN. `tests/integration/**` is collected by the default
 * `npm test` run (the `spawn-serial` project in `vitest.config.ts`). These arms
 * pack the tree, install the tarball from disk, boot a real Postgres cluster and
 * spawn the accounts service — minutes of wall clock each, and the install step
 * reaches the npm registry (A-212-11: install-time, not tool egress). Putting
 * that in every `npm test` would make the ordinary suite unusable, so the arms
 * declare themselves off unless `RUN_PX2_RC=1` is set, exactly as the studio e2e
 * lane does.
 *
 * WHY A MISSING PREREQUISITE IS A FAILURE AND NOT A SKIP. An opt-in suite that
 * also skips itself when its dependencies are absent reports green having proven
 * nothing, and this is the RC *exit gate* — the one place where a vacuous green
 * is worse than a red. So the env decides whether the arms run at all, and once
 * it says they run, every missing prerequisite throws. `describe.skipIf` is read
 * only from {@link RC_GATE_DISABLED}.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The opt-in switch. Off values are not interpreted: presence of `1` is the gate. */
export const RC_GATE_ENV = 'RUN_PX2_RC';

/** True when the arms must not run. Feed this to `describe.skipIf`. */
export const RC_GATE_DISABLED = process.env[RC_GATE_ENV] !== '1';

/**
 * The line printed once when the arms are skipped.
 *
 * Silence here is how an opt-in suite becomes a lie someone believes: the run
 * says `passed` and nobody knows the gate never executed.
 */
export const RC_GATE_SKIP_NOTICE =
  `PX2 RC exit gate NOT RUN — set ${RC_GATE_ENV}=1 to execute it. ` +
  'A green suite without it proves nothing about the RC gate.';

/** The core repo root — two levels up from `tests/integration/px2-rc`. */
export const CORE_REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/**
 * Where the accounts service checkout lives.
 *
 * The gate registers against a locally-run service spawned from its own repo
 * (A-212-11), so the checkout is a hard prerequisite rather than something the
 * suite can synthesise. `RC_ACCOUNTS_REPO` overrides the runner's default path
 * so the arms are runnable on a machine that clones it elsewhere.
 */
export function accountsRepoPath(): string {
  const fromEnv = process.env.RC_ACCOUNTS_REPO;
  const candidate = fromEnv ?? join(homedir(), '.sd-runner', 'repos', 'wigolo-accounts');

  if (!existsSync(join(candidate, 'package.json'))) {
    throw new Error(
      `the accounts service checkout is required by the PX2 RC gate but was not found at ${candidate} — ` +
        'clone `KnockOutEZ/wigolo-accounts` and point RC_ACCOUNTS_REPO at it',
    );
  }
  return candidate;
}

/**
 * The accounts env EVERY arm sets explicitly (acceptance criterion).
 *
 * `PRODUCTION_ACCOUNTS_URL` is the non-resolving `https://accounts.invalid`
 * sentinel (A-212-4), so an arm that forgot the URL would not quietly talk to a
 * real host — it would fail. Passing both here means no arm can inherit one and
 * forget the other, which is the shape the criterion is guarding against: the
 * pubkey override without the URL trusts a local key against production, and the
 * URL without the override cannot verify anything the local service mints.
 */
export function accountsEnv(serviceUrl: string, publicKeyB64Url: string): Record<string, string> {
  return {
    WIGOLO_ACCOUNTS_URL: serviceUrl,
    WIGOLO_ACCOUNTS_PUBKEY: publicKeyB64Url,
  };
}

/** Milliseconds in a day — the arms talk in days and the code compares in ms. */
export const DAY_MS = 24 * 60 * 60 * 1000;
