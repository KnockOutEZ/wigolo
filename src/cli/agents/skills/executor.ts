import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  rmdirSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mergeBlock, removeBlock, getVersion, readAsset } from '../utils.js';
import { normalizeEol, loadPack, loadLegacyHashes, listPackNames } from './catalog.js';
import { sha256, snapshotPath } from './snapshot.js';
import {
  canonicalKey,
  isKeyWithinBounds,
  withReceiptsLock,
  readReceipts,
} from './receipts.js';
import type { ReceiptEntry as RcptEntry } from './receipts.js';
import { resolveTarget, SUPPORTED_AGENTS, WINDSURF_DIGEST_PACK } from './targets.js';
import { planSkills } from './planner.js';
import type {
  ApplyResult,
  ListEntry,
  ListState,
  PlanAction,
  PlanOptions,
  Scope,
  SkillsPlan,
} from './types.js';

/** Write only if bytes differ (LF-normalized). Returns true when written. */
function writeIfChanged(path: string, content: string): boolean {
  const desired = normalizeEol(content);
  if (existsSync(path)) {
    try {
      if (normalizeEol(readFileSync(path, 'utf-8')) === desired) return false;
    } catch {
      // fall through to write
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desired, 'utf-8');
  return true;
}

/**
 * Apply an install plan. Executes create/update/adopt actions; skips
 * unchanged; leaves refused untouched. Mid-apply failure rolls back ONLY the
 * files created THIS run (never a recursive dir delete). Receipts written LAST,
 * per successful action.
 */
export function applySkillsPlan(plan: SkillsPlan): ApplyResult {
  const result: ApplyResult = { written: [], removed: [], refused: [], notices: [] };

  for (const action of plan.actions) {
    if (action.status === 'refuse') {
      result.refused.push(action);
      continue;
    }
    if (action.status === 'unchanged') continue;

    if (action.kind === 'skill-dirs') {
      applySkillDirsAction(action, result);
    } else {
      applyOwnedOrFencedAction(action, result);
    }
  }

  return result;
}

function applySkillDirsAction(action: PlanAction, result: ApplyResult): void {
  const createdThisRun: string[] = [];
  const packName = action.packs[0];
  try {
    for (const f of action.files) {
      if (f.status === 'refuse' || f.status === 'unchanged') continue;
      const existedBefore = existsSync(f.absPath);
      const wrote = writeIfChanged(f.absPath, f.content ?? '');
      if (wrote) {
        result.written.push(f.absPath);
        if (!existedBefore) createdThisRun.push(f.absPath);
      }
    }
  } catch (err) {
    // Roll back files created this run (regular files only, no recursive rm).
    for (const p of createdThisRun.reverse()) {
      try {
        unlinkSync(p);
        pruneEmptyDirsUpTo(dirname(p), action.path);
      } catch {
        // best-effort
      }
    }
    throw err;
  }

  // Receipt LAST, only after all files landed.
  recordReceipt(action, packName);
}

function applyOwnedOrFencedAction(action: PlanAction, result: ApplyResult): void {
  const content = action.ownedContent ?? '';
  if (action.kind === 'fenced-block') {
    // ownedContent is already wrapped in wigolo:start/end markers by the
    // planner. mergeBlock replaces/inserts the marked block idempotently.
    const before = existsSync(action.path) ? readFileSync(action.path, 'utf-8') : '';
    mergeBlock(action.path, content);
    const after = readFileSync(action.path, 'utf-8');
    if (before !== after) result.written.push(action.path);
  } else {
    // owned-rules-file
    if (writeIfChanged(action.path, content)) result.written.push(action.path);
  }
  recordReceipt(action, WINDSURF_DIGEST_PACK);
}

function recordReceipt(action: PlanAction, packName: string): void {
  const key = action.canonicalKey;
  const version = getVersion();
  const files: Record<string, string> = {};
  if (action.kind === 'skill-dirs') {
    for (const f of action.files) {
      if (f.status === 'refuse') continue;
      files[f.relPath] = sha256(f.content ?? '');
    }
  } else {
    files[packName] = sha256(normalizeEol(action.ownedContent ?? ''));
  }
  const adopted = action.kind === 'skill-dirs' && action.files.some((f) => f.adopted);

  withReceiptsLock((store) => {
    const existing = store[key];
    const agents = new Set([...(existing?.agents ?? []), ...action.agents]);
    const entry: RcptEntry = existing ?? {
      scope: action.scope,
      agents: [],
      packs: {},
      installedAt: new Date().toISOString(),
    };
    entry.scope = action.scope;
    entry.agents = [...agents].sort();
    entry.packs[packName] = { version, files };
    if (adopted) entry.adopted = true;
    store[key] = entry;
    return { store, result: undefined };
  });
}

/** Remove empty ancestor dirs up to (not including) `stopAt`. */
function pruneEmptyDirsUpTo(dir: string, stopAt: string): void {
  let cur = dir;
  while (cur.startsWith(stopAt) && cur !== stopAt) {
    try {
      if (readdirSync(cur).length === 0) rmdirSync(cur);
      else break;
    } catch {
      break;
    }
    cur = dirname(cur);
  }
  // Finally the pack dir itself if empty.
  try {
    if (existsSync(stopAt) && readdirSync(stopAt).length === 0) rmdirSync(stopAt);
  } catch {
    // leave non-empty
  }
}

/** Public entry: plan + apply in one call. */
export function installSkills(opts: PlanOptions): ApplyResult {
  return applySkillsPlan(planSkills(opts));
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

interface RemoveOptions {
  packs?: string[];
  scope: Scope;
  agents?: string[];
  cwd: string;
  force?: boolean;
}

/**
 * Remove selected packs for selected agents at a scope. Receipt-driven with a
 * hash-verify per file; falls back to catalog/legacy-hash verification when no
 * receipt exists. Shared-path receipts decrement agents[]; files delete only
 * when agents[] empties. Pack dir removed only if empty afterward.
 */
export function removeSkills(opts: RemoveOptions): ApplyResult {
  const home = homedir();
  const result: ApplyResult = { written: [], removed: [], refused: [], notices: [] };
  const agents = opts.agents && opts.agents.length ? opts.agents : [...SUPPORTED_AGENTS];
  const packs = opts.packs && opts.packs.length ? opts.packs : listPackNames();
  const legacy = loadLegacyHashes();

  for (const agent of agents) {
    const t = resolveTarget(agent, opts.scope, opts.cwd, home);
    if (!t) continue;

    if (t.kind === 'skill-dirs') {
      for (const packName of packs) {
        removeSkillDirPack(t.basePath, packName, agent, opts, legacy, home, result);
      }
    } else {
      removeWindsurf(t.basePath, agent, opts, home, result);
    }
  }

  pruneStaleReceipts();
  return result;
}

function removeSkillDirPack(
  base: string,
  packName: string,
  agent: string,
  opts: RemoveOptions,
  legacy: Record<string, Set<string>>,
  home: string,
  result: ApplyResult,
): void {
  const packDir = join(base, packName);
  const key = canonicalKey(packDir);

  if (!isKeyWithinBounds(key, opts.cwd, home)) {
    result.refused.push({
      agents: [agent], packs: [packName], path: packDir, status: 'refuse',
      reason: 'receipt/target key outside structural bounds — refusing to delete',
      kind: 'skill-dirs', scope: opts.scope, canonicalKey: key, files: [],
    });
    return;
  }

  const store = readReceipts();
  const entry = store[key];
  const packReceipt = entry?.packs[packName];

  // Determine which files are safe to remove.
  let relFiles: string[];
  if (packReceipt) {
    relFiles = Object.keys(packReceipt.files);
  } else {
    // No receipt: enumerate the catalog pack's files.
    let pack;
    try {
      pack = loadPack(packName);
    } catch {
      return; // unknown pack, nothing to do
    }
    relFiles = Object.keys(pack.files);
  }

  // Shared ownership: if the receipt lists other agents, decrement first.
  if (entry && entry.agents.length > 1 && entry.agents.includes(agent)) {
    withReceiptsLock((s) => {
      const e = s[key];
      if (e) {
        e.agents = e.agents.filter((a) => a !== agent);
        s[key] = e;
      }
      return { store: s, result: undefined };
    });
    result.notices.push(`${packName}: ${agent} detached; files retained for remaining agents`);
    return;
  }

  // Verify + delete each file.
  const modified: string[] = [];
  const toDelete: string[] = [];
  for (const rel of relFiles) {
    const abs = join(packDir, rel);
    const snap = snapshotPath(abs);
    if (snap.kind === 'absent') continue;
    if (snap.kind === 'symlink') {
      result.refused.push({
        agents: [agent], packs: [packName], path: abs, relPath: rel, status: 'refuse',
        reason: `symlink — managed elsewhere; use force to replace, not remove`,
        kind: 'skill-dirs', scope: opts.scope, canonicalKey: key, files: [],
      });
      continue;
    }
    const onDisk = snap.sha256;
    const receiptHash = packReceipt?.files[rel];
    const legacyKey = `${packName}/${rel}`;
    let canonicalHash: string | undefined;
    try {
      canonicalHash = sha256(loadPack(packName).files[rel] ?? '');
    } catch {
      canonicalHash = undefined;
    }
    const known =
      (receiptHash !== undefined && onDisk === receiptHash) ||
      (onDisk !== undefined && onDisk === canonicalHash) ||
      (onDisk !== undefined && (legacy[legacyKey]?.has(onDisk) ?? false));

    if (known || opts.force) {
      toDelete.push(abs);
    } else {
      modified.push(rel);
    }
  }

  if (modified.length && !opts.force) {
    result.refused.push({
      agents: [agent], packs: [packName], path: packDir, status: 'refuse',
      reason: `user-modified files (use force to remove): ${modified.join(', ')}`,
      kind: 'skill-dirs', scope: opts.scope, canonicalKey: key, files: [],
    });
    // Still remove the verified-safe ones? No — abort this pack to avoid
    // partial teardown that surprises the user.
    return;
  }

  for (const abs of toDelete) {
    try {
      unlinkSync(abs);
      result.removed.push(abs);
    } catch {
      // best-effort
    }
  }

  // Prune now-empty subdirs (e.g. rules/) so a pack with no survivors collapses.
  pruneEmptySubdirs(packDir);

  // Remove pack dir only if empty; else list survivors.
  if (existsSync(packDir)) {
    const survivors = safeReaddir(packDir);
    if (survivors.length === 0) {
      try {
        rmdirSync(packDir);
      } catch {
        // leave
      }
    } else {
      result.notices.push(
        `${packDir}: left in place — ${survivors.length} non-managed file(s) survive: ${survivors.join(', ')}`,
      );
    }
  }

  // Drop the pack from the receipt (or the whole entry if it was the last pack).
  withReceiptsLock((s) => {
    const e = s[key];
    if (e) {
      delete e.packs[packName];
      if (Object.keys(e.packs).length === 0) delete s[key];
      else s[key] = e;
    }
    return { store: s, result: undefined };
  });
}

function removeWindsurf(
  base: string,
  agent: string,
  opts: RemoveOptions,
  home: string,
  result: ApplyResult,
): void {
  const key = canonicalKey(base);
  if (!isKeyWithinBounds(key, opts.cwd, home)) {
    result.refused.push({
      agents: [agent], packs: [WINDSURF_DIGEST_PACK], path: base, status: 'refuse',
      reason: 'windsurf key outside structural bounds', kind: 'fenced-block',
      scope: opts.scope, canonicalKey: key, files: [],
    });
    return;
  }
  const snap = snapshotPath(base);
  if (snap.kind === 'symlink') {
    result.refused.push({
      agents: [agent], packs: [WINDSURF_DIGEST_PACK], path: base, status: 'refuse',
      reason: 'symlink — never unlinked', kind: 'fenced-block',
      scope: opts.scope, canonicalKey: key, files: [],
    });
    return;
  }
  if (snap.kind === 'absent') {
    dropWindsurfReceipt(key);
    return;
  }

  if (opts.scope === 'global') {
    // fenced-block: strip the wigolo block.
    if (removeBlock(base)) result.removed.push(`${base} (wigolo block)`);
  } else {
    // owned-rules-file: verify then delete the whole file.
    const onDisk = snap.sha256;
    const store = readReceipts();
    const receiptHash = store[key]?.packs[WINDSURF_DIGEST_PACK]?.files[WINDSURF_DIGEST_PACK];
    const canonical = sha256(
      normalizeEol(safeAsset('blocks/windsurf/rules-project.md')),
    );
    const known =
      (receiptHash !== undefined && onDisk === receiptHash) || onDisk === canonical;
    if (known || opts.force) {
      try {
        unlinkSync(base);
        result.removed.push(base);
      } catch {
        // best-effort
      }
    } else {
      result.refused.push({
        agents: [agent], packs: [WINDSURF_DIGEST_PACK], path: base, status: 'refuse',
        reason: 'user-modified windsurf rules (use force)', kind: 'owned-rules-file',
        scope: opts.scope, canonicalKey: key, files: [],
      });
      return;
    }
  }
  dropWindsurfReceipt(key);
}

function dropWindsurfReceipt(key: string): void {
  withReceiptsLock((s) => {
    const e = s[key];
    if (e) {
      delete e.packs[WINDSURF_DIGEST_PACK];
      if (Object.keys(e.packs).length === 0) delete s[key];
      else s[key] = e;
    }
    return { store: s, result: undefined };
  });
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Depth-first remove empty descendant dirs (not the root itself). */
function pruneEmptySubdirs(root: string): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const sub = join(root, e.name);
      pruneEmptySubdirs(sub);
      try {
        if (readdirSync(sub).length === 0) rmdirSync(sub);
      } catch {
        // leave non-empty / unremovable
      }
    }
  }
}

function safeAsset(rel: string): string {
  try {
    return normalizeEol(readAsset(rel));
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// removeAllSkills — uninstall sweep
// ---------------------------------------------------------------------------

interface RemoveAllOptions {
  cwd: string;
  force?: boolean;
}

/**
 * Uninstall sweep. Runs a receipts pass (structural-bounds-checked, INCLUDING
 * foreign-cwd keys) plus a receipt-less pass enumerating every targets-table
 * path for ALL supported agents × BOTH scopes. Each file resolves per the
 * REMOVE order; unremovable ⇒ left + reported.
 */
export function removeAllSkills(opts: RemoveAllOptions): ApplyResult {
  const home = homedir();
  const result: ApplyResult = { written: [], removed: [], refused: [], notices: [] };

  // Pass 1: receipts (bounds-checked). Delete each receipt-listed file if its
  // hash verifies (or force).
  const store = readReceipts();
  for (const [key, entry] of Object.entries(store)) {
    if (!isKeyWithinBounds(key, opts.cwd, home)) {
      result.refused.push({
        agents: entry.agents, packs: Object.keys(entry.packs), path: key, status: 'refuse',
        reason: 'receipt key outside structural bounds', kind: 'skill-dirs',
        scope: entry.scope, canonicalKey: key, files: [],
      });
      continue;
    }
    sweepReceiptEntry(key, entry, opts.force ?? false, result);
  }

  // Pass 2: receipt-less enumeration of every targets-table path.
  const packNames = listPackNames();
  const legacy = loadLegacyHashes();
  for (const agent of SUPPORTED_AGENTS) {
    for (const scope of ['project', 'global'] as const) {
      const t = resolveTarget(agent, scope, opts.cwd, home);
      if (!t) continue;
      if (t.kind === 'skill-dirs') {
        for (const packName of packNames) {
          removeSkillDirPack(t.basePath, packName, agent, { scope, cwd: opts.cwd, force: opts.force }, legacy, home, result);
        }
      } else {
        removeWindsurf(t.basePath, agent, { scope, cwd: opts.cwd, force: opts.force }, home, result);
      }
    }
  }

  pruneStaleReceipts();
  return result;
}

function sweepReceiptEntry(
  key: string,
  entry: RcptEntry,
  force: boolean,
  result: ApplyResult,
): void {
  for (const [packName, pr] of Object.entries(entry.packs)) {
    if (packName === WINDSURF_DIGEST_PACK) continue; // handled by pass 2
    for (const [rel, hash] of Object.entries(pr.files)) {
      const abs = join(key, rel);
      const snap = snapshotPath(abs);
      if (snap.kind === 'absent') continue;
      if (snap.kind === 'symlink') {
        result.refused.push({
          agents: entry.agents, packs: [packName], path: abs, relPath: rel, status: 'refuse',
          reason: 'symlink — never removed', kind: 'skill-dirs',
          scope: entry.scope, canonicalKey: key, files: [],
        });
        continue;
      }
      if (snap.sha256 === hash || force) {
        try {
          unlinkSync(abs);
          result.removed.push(abs);
        } catch {
          // best-effort
        }
      } else {
        result.refused.push({
          agents: entry.agents, packs: [packName], path: abs, relPath: rel, status: 'refuse',
          reason: 'user-modified (use force)', kind: 'skill-dirs',
          scope: entry.scope, canonicalKey: key, files: [],
        });
      }
    }
    if (existsSync(key) && safeReaddir(key).length === 0) {
      try {
        rmdirSync(key);
      } catch {
        // leave
      }
    }
  }
}

/** Drop receipt entries whose target no longer exists on disk. */
function pruneStaleReceipts(): void {
  withReceiptsLock((store) => {
    for (const [key, entry] of Object.entries(store)) {
      const anyLive = Object.values(entry.packs).some((pr) =>
        Object.keys(pr.files).some((rel) => {
          const abs = entry.packs[WINDSURF_DIGEST_PACK] ? key : join(key, rel);
          return existsSync(abs);
        }),
      );
      if (!anyLive && !existsSync(key)) delete store[key];
    }
    return { store, result: undefined };
  });
}

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

/** Report install state per (agent, scope, pack). NEVER writes. */
export function listSkills(opts: PlanOptions): ListEntry[] {
  const home = homedir();
  const out: ListEntry[] = [];
  const agents = opts.agents && opts.agents.length ? opts.agents : [...SUPPORTED_AGENTS];
  const packs = opts.packs && opts.packs.length ? opts.packs : listPackNames();
  const legacy = loadLegacyHashes();
  const store = readReceipts();
  const version = getVersion();

  for (const agent of agents) {
    const t = resolveTarget(agent, opts.scope, opts.cwd, home);
    if (!t) continue;

    if (t.kind !== 'skill-dirs') {
      const key = canonicalKey(t.basePath);
      const snap = snapshotPath(t.basePath);
      let state: ListState = 'absent';
      if (snap.kind === 'symlink') state = 'managed-externally';
      else if (snap.kind === 'file') {
        const receiptHash = store[key]?.packs[WINDSURF_DIGEST_PACK]?.files[WINDSURF_DIGEST_PACK];
        const onDisk = snap.sha256;
        if (receiptHash && onDisk === receiptHash) state = 'installed';
        else if (store[key]?.packs[WINDSURF_DIGEST_PACK]) state = 'modified';
        else state = 'adopted';
      } else if (store[key]?.packs[WINDSURF_DIGEST_PACK]) {
        state = 'stale';
      }
      out.push({ agent, scope: opts.scope, pack: WINDSURF_DIGEST_PACK, path: t.basePath, state });
      continue;
    }

    for (const packName of packs) {
      const packDir = join(t.basePath, packName);
      const key = canonicalKey(packDir);
      const entry = store[key];
      const packReceipt = entry?.packs[packName];
      const slot = snapshotPath(packDir);

      if (slot.kind === 'symlink') {
        out.push({ agent, scope: opts.scope, pack: packName, path: packDir, state: 'managed-externally' });
        continue;
      }
      if (slot.kind === 'absent') {
        out.push({
          agent, scope: opts.scope, pack: packName, path: packDir,
          state: packReceipt ? 'stale' : 'absent',
        });
        continue;
      }

      // Present dir — inspect files.
      let pack;
      try {
        pack = loadPack(packName);
      } catch {
        out.push({ agent, scope: opts.scope, pack: packName, path: packDir, state: 'absent' });
        continue;
      }
      let anyModified = false;
      let anyAdopted = false;
      let allCanonical = true;
      let matchesReceipt = packReceipt !== undefined;
      for (const [rel, content] of Object.entries(pack.files)) {
        const snap = snapshotPath(join(packDir, rel));
        const canonicalHash = sha256(content);
        const onDisk = snap.sha256;
        const receiptHash = packReceipt?.files[rel];
        if (snap.kind !== 'file') { allCanonical = false; matchesReceipt = false; continue; }
        if (receiptHash !== undefined && onDisk !== receiptHash) anyModified = true;
        if (receiptHash !== undefined && onDisk !== receiptHash) matchesReceipt = false;
        if (onDisk !== canonicalHash) allCanonical = false;
        if (receiptHash === undefined && (onDisk === canonicalHash || (onDisk !== undefined && legacy[`${packName}/${rel}`]?.has(onDisk)))) {
          anyAdopted = true;
        }
      }

      let state: ListState;
      if (packReceipt) {
        if (anyModified) state = 'modified';
        else if (packReceipt.version !== version && !allCanonical) state = 'outdated';
        else state = 'installed';
        void matchesReceipt;
      } else if (anyAdopted) {
        state = 'adopted';
      } else {
        state = allCanonical ? 'installed' : 'modified';
      }
      out.push({ agent, scope: opts.scope, pack: packName, path: packDir, state });
    }
  }

  return out;
}

export type { RemoveOptions, RemoveAllOptions };
