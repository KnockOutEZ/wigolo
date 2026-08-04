import { mkdirSync, writeFileSync, readFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { studioStateDir } from './paths.js';
import { normalizeOrigin, type AuthenticatedOriginOverrides } from './authenticated-origin.js';

/**
 * S9 / F5 — persistence for the authenticated-origin predicate.
 *
 * Two stores, deliberately separate because they have different writers:
 *
 *  - The LEDGER (clause (a)) is written by the HOST when `handoff.ts` reaches its COMPLETING terminal. It
 *    is a list of origins the human has logged into through the handoff, which is browsing history, so it
 *    is 0600 in the studio data dir and is never enumerated to an agent or printed by `doctor`.
 *  - The OVERRIDES are written by the HUMAN through `wigolo config --authenticated-origin` /
 *    `--anonymous-origin`, and live in the persisted config where the user can see and edit them.
 *
 * TRUST BRIGHT-LINE (the same one `pre-grant.ts` draws): there is NO agent/MCP path that writes either
 * store. Both writers here take an explicit `'human'` party and refuse anything else, so a future caller
 * that forgets the rule fails loudly instead of silently granting the agent a way to mark its own targets
 * authenticated — or, worse, to mark them anonymous and switch the grant card off.
 */

/** The party attempting a write. Only the human channel may write these stores. */
export type WriterParty = 'human' | 'agent';

/** Thrown when a non-human writer attempts to mutate an F5 store. Carries no origin (nothing to leak). */
export class AgentWriteRefusedError extends Error {
  constructor(store: string) {
    super(`refused: ${store} is written by the human channel only`);
    this.name = 'AgentWriteRefusedError';
  }
}

interface LedgerFile {
  v: 1;
  origins: string[];
}

function ledgerPath(dataDir?: string): string {
  return studioStateDir(dataDir, 'auth-origins.json');
}

/** Read the handoff ledger. Absent/unreadable/malformed ⇒ empty (a missing ledger costs a card, never safety). */
export function readAuthOriginLedger(dataDir?: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(dataDir), 'utf-8')) as LedgerFile;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.origins)) return new Set();
    return new Set(parsed.origins.filter((o): o is string => typeof o === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * Record an origin as login-handoff-completed. HOST-ONLY caller: the handoff COMPLETING terminal.
 * Idempotent. Written 0600 via temp+rename, like the session handle — it is browsing history.
 */
export function recordAuthOrigin(rawOrigin: string, party: WriterParty, dataDir?: string): void {
  if (party !== 'human') throw new AgentWriteRefusedError('the authenticated-origin ledger');
  const origin = normalizeOrigin(rawOrigin);
  if (!origin) return;
  const existing = readAuthOriginLedger(dataDir);
  if (existing.has(origin)) return;
  existing.add(origin);

  const finalPath = ledgerPath(dataDir);
  mkdirSync(join(finalPath, '..'), { recursive: true, mode: 0o700 });
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  const body: LedgerFile = { v: 1, origins: [...existing] };
  writeFileSync(tmpPath, JSON.stringify(body), { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, finalPath);
}

/** The persisted-config setting keys the human overrides live under. */
export const AUTHENTICATED_ORIGINS_KEY = 'studioAuthenticatedOrigins';
export const ANONYMOUS_ORIGINS_KEY = 'studioAnonymousOrigins';

function readOriginList(settings: Record<string, unknown>, key: string): Set<string> {
  const raw = settings[key];
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const o = normalizeOrigin(entry);
    if (o) out.add(o);
  }
  return out;
}

/** Project the two human override lists out of persisted settings. */
export function readOriginOverrides(settings: Record<string, unknown>): AuthenticatedOriginOverrides {
  return {
    authenticated: readOriginList(settings, AUTHENTICATED_ORIGINS_KEY),
    anonymous: readOriginList(settings, ANONYMOUS_ORIGINS_KEY),
  };
}

export type OverrideKind = 'authenticated' | 'anonymous';

/**
 * Compute the settings patch that adds `rawOrigin` to one override list. HUMAN-ONLY (`wigolo config`,
 * which carries a hard invariant that it is never reachable from the MCP stdio path).
 *
 * Adding to one list REMOVES from the other: holding an origin on both would make the outcome depend on
 * clause order, which is exactly the kind of silent ambiguity a safety toggle must not have.
 */
export function overridePatch(
  settings: Record<string, unknown>,
  rawOrigin: string,
  kind: OverrideKind,
  party: WriterParty,
): Record<string, unknown> {
  if (party !== 'human') throw new AgentWriteRefusedError('the authenticated-origin overrides');
  const origin = normalizeOrigin(rawOrigin);
  if (!origin) throw new Error(`not a usable origin: ${rawOrigin}`);

  const authenticated = readOriginList(settings, AUTHENTICATED_ORIGINS_KEY);
  const anonymous = readOriginList(settings, ANONYMOUS_ORIGINS_KEY);
  if (kind === 'authenticated') {
    authenticated.add(origin);
    anonymous.delete(origin);
  } else {
    anonymous.add(origin);
    authenticated.delete(origin);
  }
  return {
    [AUTHENTICATED_ORIGINS_KEY]: [...authenticated].sort(),
    [ANONYMOUS_ORIGINS_KEY]: [...anonymous].sort(),
  };
}

/**
 * How many origins this profile treats as authenticated — the ONLY thing `doctor` reports. The LIST is a
 * browsing-history disclosure and is never printed.
 */
export function authenticatedOriginCount(settings: Record<string, unknown>, dataDir?: string): number {
  const overrides = readOriginOverrides(settings);
  const all = new Set([...readAuthOriginLedger(dataDir), ...(overrides.authenticated ?? [])]);
  for (const o of overrides.anonymous ?? []) all.delete(o);
  return all.size;
}
