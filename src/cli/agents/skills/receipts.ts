import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmdirSync,
  realpathSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, sep, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getConfig } from '../../../config.js';
import { SUPPORTED_AGENTS, resolveTarget } from './targets.js';
import type { Scope } from './types.js';
import { assertSafeRelPath } from './catalog.js';

/**
 * Receipt store: <dataDir>/skills/receipts.json.
 *
 * A receipt is a CLAIM about what wigolo installed where — not an
 * authorization. Every canonical key is bounds-checked against the targets
 * table shape before any delete, because receipts.json is user-writable.
 */

export interface PackReceipt {
  version: string;
  files: Record<string, string>; // relPath → sha256
}

export interface ReceiptEntry {
  scope: Scope;
  agents: string[];
  packs: Record<string, PackReceipt>;
  adopted?: true;
  installedAt: string;
}

export type ReceiptStore = Record<string, ReceiptEntry>;

const LOCK_TIMEOUT_MS = 10_000;

function skillsDataDir(): string {
  return join(getConfig().dataDir, 'skills');
}

export function receiptsPath(): string {
  return join(skillsDataDir(), 'receipts.json');
}

/**
 * Canonical key for a destination path: realpath of the NEAREST EXISTING
 * ancestor, re-joined with the normalized remaining (not-yet-existing)
 * segments. Never mkdirs — a dry-run on a fresh machine (no parent dirs)
 * must produce a stable key without side effects.
 */
export function canonicalKey(destPath: string): string {
  const abs = resolve(destPath);
  const parts = abs.split(sep);
  // Walk up until we find an existing ancestor.
  for (let i = parts.length; i >= 1; i--) {
    const candidate = parts.slice(0, i).join(sep) || sep;
    if (existsSync(candidate)) {
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        real = candidate;
      }
      const remaining = parts.slice(i);
      return remaining.length ? join(real, ...remaining) : real;
    }
  }
  return abs;
}

/**
 * Structural bounds check: does `key` match the shape producible by the
 * targets table for SOME supported agent × scope, under the given cwd/home?
 * Entries outside the shape are refused (never deleted).
 *
 * A key is in-bounds when it equals a target basePath (owned-file/fenced) OR
 * lies under a skill-dirs base as `<base>/<pack>[/...]`.
 */
export function isKeyWithinBounds(
  key: string,
  cwd: string,
  home: string = homedir(),
): boolean {
  const canonKey = canonicalKey(key);
  for (const agent of SUPPORTED_AGENTS) {
    for (const scope of ['project', 'global'] as const) {
      const t = resolveTarget(agent, scope, cwd, home);
      if (!t) continue;
      const canonBase = canonicalKey(t.basePath);
      if (t.kind === 'skill-dirs') {
        // Must be a strict descendant: <base>/<pack>[/...]
        if (canonKey === canonBase) continue;
        const prefix = canonBase.endsWith(sep) ? canonBase : canonBase + sep;
        if (canonKey.startsWith(prefix)) {
          const rest = canonKey.slice(prefix.length);
          // At least one segment (the pack name).
          if (rest.length > 0 && rest.split(sep)[0].length > 0) return true;
        }
      } else {
        // owned-file / fenced-block: key must equal the base file path.
        if (canonKey === canonBase) return true;
      }
    }
  }
  return false;
}

function validateEntry(key: string, entry: ReceiptEntry): boolean {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.scope !== 'project' && entry.scope !== 'global') return false;
  if (!Array.isArray(entry.agents)) return false;
  if (!entry.packs || typeof entry.packs !== 'object') return false;
  for (const [pack, pr] of Object.entries(entry.packs)) {
    if (!pr || typeof pr !== 'object') return false;
    if (typeof pr.version !== 'string') return false;
    if (!pr.files || typeof pr.files !== 'object') return false;
    for (const rel of Object.keys(pr.files)) {
      try {
        assertSafeRelPath(rel);
      } catch {
        return false; // relPath traversal in a receipt ⇒ drop the entry
      }
    }
    void pack;
  }
  return true;
}

/** Read + validate the receipt store. Corrupt JSON ⇒ empty store (fail-safe). */
export function readReceipts(): ReceiptStore {
  const p = receiptsPath();
  if (!existsSync(p)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const store: ReceiptStore = {};
  for (const [key, entry] of Object.entries(raw as Record<string, ReceiptEntry>)) {
    if (isAbsolute(key) && validateEntry(key, entry)) {
      store[key] = entry;
    }
  }
  return store;
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Windows EPERM: retry once.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      renameSync(tmp, path);
    } else {
      throw err;
    }
  }
}

function lockDirPath(): string {
  return join(skillsDataDir(), 'receipts.lock');
}

/** Remove a small dir we fully own (owner file + dir), with EPERM retry. */
function removeLockDir(dir: string): void {
  try {
    for (const f of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        // ignore
      }
    }
  } catch {
    // dir already gone
  }
  try {
    rmdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      try {
        rmdirSync(dir);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Acquire an mkdir-based lock. On a stale lock (age > timeout) the steal is
 * atomic: RENAME the stale lock dir to a unique name — only the successful
 * renamer proceeds to remove it and re-mkdir. A naive rmdir+mkdir would let two
 * waiters both "win". Ownership is re-verified after acquisition.
 */
function acquireLock(): { token: string } {
  const lock = lockDirPath();
  mkdirSync(skillsDataDir(), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), token, 'utf-8');
      // Re-verify we own it (guards a racing steal between mkdir and write).
      if (readOwner(lock) === token) return { token };
      continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    // Lock held — check staleness (crash-orphan recovery).
    const age = lockAge(lock);
    if (age !== undefined && age > LOCK_TIMEOUT_MS) {
      const stolen = `${lock}.stale-${token}`;
      let stole = false;
      try {
        renameSync(lock, stolen);
        stole = true;
      } catch (renameErr) {
        if ((renameErr as NodeJS.ErrnoException).code === 'EPERM') {
          try {
            renameSync(lock, stolen);
            stole = true;
          } catch {
            stole = false; // another waiter renamed first
          }
        }
      }
      if (stole) {
        removeLockDir(stolen); // we are the sole steal winner
      }
      continue; // loop back to re-mkdir the fresh lock
    }

    if (Date.now() > deadline) {
      throw new Error('skills receipts: lock acquisition timed out');
    }
    sleepSync(20);
  }
}

function readOwner(lock: string): string | undefined {
  try {
    return readFileSync(join(lock, 'owner'), 'utf-8');
  } catch {
    return undefined;
  }
}

function lockAge(lock: string): number | undefined {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return undefined;
  }
}

function releaseLock(token: string): void {
  const lock = lockDirPath();
  if (readOwner(lock) === token) {
    removeLockDir(lock);
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait — locks are held for microseconds; contention is rare.
  }
}

/**
 * Read → mutate → write the receipt store under an exclusive lock so
 * concurrent installs don't lose updates.
 */
export function withReceiptsLock<T>(fn: (store: ReceiptStore) => { store: ReceiptStore; result: T }): T {
  const { token } = acquireLock();
  try {
    const store = readReceipts();
    const { store: next, result } = fn(store);
    atomicWrite(receiptsPath(), JSON.stringify(next, null, 2) + '\n');
    return result;
  } finally {
    releaseLock(token);
  }
}

/** Write the store directly (already-locked contexts / tests). */
export function writeReceipts(store: ReceiptStore): void {
  atomicWrite(receiptsPath(), JSON.stringify(store, null, 2) + '\n');
}
