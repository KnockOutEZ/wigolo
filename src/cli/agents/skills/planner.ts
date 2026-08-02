import { join } from 'node:path';
import { homedir } from 'node:os';
import { readAsset } from '../utils.js';
import {
  loadPack,
  loadLegacyHashes,
  listPackNames,
  normalizeEol,
} from './catalog.js';
import { resolveTarget, WINDSURF_DIGEST_PACK, SUPPORTED_AGENTS } from './targets.js';
import { gatherSnapshot, sha256 } from './snapshot.js';
import { canonicalKey, readReceipts } from './receipts.js';
import type {
  FileResolution,
  Pack,
  PlanAction,
  PlanOptions,
  PlanStatus,
  Scope,
  SkillsPlan,
  Snapshot,
  Target,
} from './types.js';

const GLOBAL_RULES_MAX = 6000;

/** Which agents share the same skill-dirs base at a given scope. */
function groupTargetsByBase(targets: Target[]): Map<string, Target[]> {
  const byBase = new Map<string, Target[]>();
  for (const t of targets) {
    const arr = byBase.get(t.basePath) ?? [];
    arr.push(t);
    byBase.set(t.basePath, arr);
  }
  return byBase;
}

/**
 * Aggregate per-file statuses into a single pack-dir status (worst-wins).
 *
 * Pack application is ATOMIC: one refused file makes the whole pack action
 * 'refuse', and the executor skips the entire action (never a partial write).
 * This is consistent with the engine's refuse-over-guess stance — force is the
 * single escape hatch. (The executor therefore never sees a file-level 'refuse';
 * its only per-file skip is a symlink planted AFTER planning — a TOCTOU guard.)
 */
function aggregateStatus(files: FileResolution[]): PlanStatus {
  const order: PlanStatus[] = ['unchanged', 'adopt', 'update', 'create', 'remove', 'refuse'];
  let worst: PlanStatus = 'unchanged';
  for (const f of files) {
    if (order.indexOf(f.status) > order.indexOf(worst)) worst = f.status;
  }
  return worst;
}

/**
 * ADD resolution for one file. See the S-K2 contract:
 *   receipt-hash match → unchanged/update
 *   receipt present + on-disk ≠ receipt → refuse (force overrides)
 *   no receipt + bytes == canonical → adopt
 *   no receipt + bytes match a legacy hash → update (adopt-and-upgrade)
 *   no receipt + unknown bytes → refuse
 *   symlink dest → refuse (force replaces the link)
 */
function resolveFileAdd(
  absPath: string,
  relPath: string,
  packName: string,
  canonical: string,
  snap: Snapshot,
  receiptHash: string | undefined,
  legacyHashes: Set<string>,
  force: boolean,
): FileResolution {
  const canonicalHash = sha256(canonical);
  const entry = snap[absPath] ?? { kind: 'absent' as const };

  if (entry.kind === 'symlink') {
    if (force) {
      return { relPath, absPath, status: 'update', content: canonical, reason: 'force: replacing symlink', replaceSymlink: true };
    }
    return {
      relPath,
      absPath,
      status: 'refuse',
      reason: `symlink dest → ${entry.linkTarget ?? '?'} — managed by another skills installer — remove it there, or use force to replace the link`,
    };
  }

  if (entry.kind === 'absent') {
    return { relPath, absPath, status: 'create', content: canonical };
  }

  if (entry.kind === 'dir') {
    // A dir where a file must go — cannot write through.
    return {
      relPath,
      absPath,
      status: 'refuse',
      reason: 'a directory exists where a file must be written',
    };
  }

  const onDisk = entry.sha256;

  if (receiptHash !== undefined) {
    if (onDisk === receiptHash) {
      // Installed by us and untouched. Upgrade only if canonical drifted.
      return onDisk === canonicalHash
        ? { relPath, absPath, status: 'unchanged', content: canonical }
        : { relPath, absPath, status: 'update', content: canonical };
    }
    // User edited a file we own.
    if (force) {
      return { relPath, absPath, status: 'update', content: canonical, reason: 'force: overwriting user-modified file' };
    }
    return { relPath, absPath, status: 'refuse', reason: 'user-modified since install' };
  }

  // No receipt.
  if (onDisk === canonicalHash) {
    return { relPath, absPath, status: 'adopt', content: canonical, adopted: true };
  }
  if (onDisk !== undefined && legacyHashes.has(onDisk)) {
    // Adopt-and-upgrade: prior wigolo version's bytes → rewrite, no force.
    return { relPath, absPath, status: 'update', content: canonical, adopted: true };
  }
  if (force) {
    return { relPath, absPath, status: 'update', content: canonical, reason: 'force: overwriting unknown bytes' };
  }
  void packName;
  return { relPath, absPath, status: 'refuse', reason: 'unknown bytes (no receipt, not canonical, not legacy)' };
}

/** Build a skill-dirs pack action for a group of agents sharing one base. */
function planSkillDirsPack(
  base: string,
  scope: Scope,
  agents: string[],
  pack: Pack,
  snap: Snapshot,
  legacyHashes: Record<string, Set<string>>,
  receiptFiles: Record<string, string> | undefined,
  relLabel: string,
  force: boolean,
): PlanAction {
  const packDir = join(base, pack.name);

  // Dest-is-regular-file where the pack DIR must go: refuse, force never
  // overrides this one (writing through would clobber a user file).
  const dirSlot = snap[packDir];
  if (dirSlot && dirSlot.kind === 'file') {
    return {
      agents: [...agents].sort(),
      packs: [pack.name],
      path: packDir,
      relPath: `${relLabel}/${pack.name}`,
      status: 'refuse',
      kind: 'skill-dirs',
      scope,
      canonicalKey: canonicalKey(packDir),
      files: [],
      reason: 'a regular file exists where the pack directory must go — remove it first (force does not override this)',
    };
  }
  if (dirSlot && dirSlot.kind === 'symlink') {
    if (!force) {
      return {
        agents: [...agents].sort(),
        packs: [pack.name],
        path: packDir,
        relPath: `${relLabel}/${pack.name}`,
        status: 'refuse',
        kind: 'skill-dirs',
        scope,
        canonicalKey: canonicalKey(packDir),
        files: [],
        reason: `symlink pack dir → ${dirSlot.linkTarget ?? '?'} — managed by another skills installer — remove it there, or use force to replace the link`,
      };
    }
  }

  // A symlinked pack DIR under force: authorize replacing the LINK with a real
  // dir. Files under it lstat as absent (the link resolves elsewhere), so they
  // resolve to `create`; the executor unlinks the dir symlink first.
  const packDirIsSymlink = dirSlot?.kind === 'symlink';

  const files: FileResolution[] = [];
  for (const [rel, content] of Object.entries(pack.files)) {
    const abs = join(packDir, rel);
    const legacyKey = `${pack.name}/${rel}`;
    files.push(
      resolveFileAdd(
        abs,
        rel,
        pack.name,
        content,
        snap,
        receiptFiles?.[rel],
        legacyHashes[legacyKey] ?? new Set(),
        force,
      ),
    );
  }
  return {
    agents: [...agents].sort(),
    packs: [pack.name],
    path: packDir,
    relPath: `${relLabel}/${pack.name}`,
    status: aggregateStatus(files),
    kind: 'skill-dirs',
    scope,
    canonicalKey: canonicalKey(packDir),
    files,
    reason: files.find((f) => f.reason)?.reason,
    replaceSymlink: packDirIsSymlink,
  };
}

/** Plan the windsurf owned-file / fenced-block digest action. */
function planWindsurf(
  scope: Scope,
  target: Target,
  snap: Snapshot,
  receiptFiles: Record<string, string> | undefined,
  force: boolean,
  notes: string[],
): PlanAction | undefined {
  const isProject = scope === 'project';
  const asset = isProject
    ? readAsset('blocks/windsurf/rules-project.md')
    : readAsset('blocks/windsurf/rules-global.md');
  const canonical = normalizeEol(asset);
  const abs = target.basePath;
  const entry = snap[abs] ?? { kind: 'absent' as const };
  const key = canonicalKey(abs);

  notes.push('windsurf receives the digest (all tools)');

  if (entry.kind === 'symlink') {
    return {
      agents: ['windsurf'],
      packs: [WINDSURF_DIGEST_PACK],
      path: abs,
      relPath: target.relLabel,
      status: force ? 'update' : 'refuse',
      reason: force
        ? 'force: replacing symlink'
        : `symlink dest → ${entry.linkTarget ?? '?'} — managed elsewhere; use force to replace the link`,
      kind: target.kind,
      scope,
      canonicalKey: key,
      files: [],
      ownedContent: canonical,
      currentContent: entry.content,
      replaceSymlink: force,
    };
  }

  const relKey = WINDSURF_DIGEST_PACK; // single-file digest recorded under one relPath
  const receiptHash = receiptFiles?.[relKey];

  if (target.kind === 'fenced-block') {
    // Global rules: block merged into a shared file. Size guard.
    const current = entry.kind === 'file' ? (entry.content ?? '') : '';
    const START = '<!-- wigolo:start';
    const END = '<!-- wigolo:end -->';
    const block = `${START} -->\n${canonical.trimEnd()}\n${END}`;
    // Simulate the merged length (replace existing block or append).
    let merged: string;
    const sIdx = current.indexOf(START);
    const eIdx = current.indexOf(END);
    if (sIdx !== -1 && eIdx !== -1) {
      const before = current.slice(0, sIdx).trimEnd();
      const after = current.slice(eIdx + END.length).trimStart();
      merged = [before, block, after].filter(Boolean).join('\n\n');
    } else {
      merged = current.trimEnd() ? `${current.trimEnd()}\n\n${block}` : block;
    }
    if (merged.length > GLOBAL_RULES_MAX) {
      return {
        agents: ['windsurf'],
        packs: [WINDSURF_DIGEST_PACK],
        path: abs,
        relPath: target.relLabel,
        status: 'refuse',
        reason: `inserting the digest would push global_rules.md past ${GLOBAL_RULES_MAX} chars — trim your global rules, or install at project scope`,
        kind: target.kind,
        scope,
        canonicalKey: key,
        files: [],
        ownedContent: block,
        currentContent: current,
      };
    }
    // Determine status: does an equivalent block already sit there?
    const status: PlanStatus =
      sIdx !== -1 && eIdx !== -1
        ? current.slice(sIdx, eIdx + END.length).replace(/\r\n/g, '\n') ===
          block.replace(/\r\n/g, '\n')
          ? 'unchanged'
          : 'update'
        : 'create';
    return {
      agents: ['windsurf'],
      packs: [WINDSURF_DIGEST_PACK],
      path: abs,
      relPath: target.relLabel,
      status,
      kind: target.kind,
      scope,
      canonicalKey: key,
      files: [],
      ownedContent: block,
      currentContent: current,
    };
  }

  // owned-rules-file (project): identical ADD resolution as a single file.
  const res = resolveFileAdd(
    abs,
    relKey,
    WINDSURF_DIGEST_PACK,
    canonical,
    snap,
    receiptHash,
    new Set(),
    force,
  );
  return {
    agents: ['windsurf'],
    packs: [WINDSURF_DIGEST_PACK],
    path: abs,
    relPath: target.relLabel,
    status: res.status,
    reason: res.reason,
    kind: target.kind,
    scope,
    canonicalKey: key,
    files: [],
    ownedContent: canonical,
    currentContent: entry.kind === 'file' ? entry.content : undefined,
  };
}

/**
 * Build an install plan. Pure: NEVER writes. Dedupes shared skill-dirs bases so
 * `.agents/skills/` is planned once even when codex+cursor+gemini are all
 * selected (the action lists all sharers in `agents`).
 */
export function planSkills(opts: PlanOptions): SkillsPlan {
  const home = homedir();
  const scope = opts.scope;
  const force = opts.force ?? false;
  const cwd = opts.cwd;
  const notes: string[] = [];

  const allPackNames = listPackNames();
  const requestedPacks = opts.packs && opts.packs.length ? opts.packs : allPackNames;
  const agents = opts.agents && opts.agents.length ? opts.agents : [...SUPPORTED_AGENTS];

  const catalog = new Map<string, Pack>();
  for (const name of requestedPacks) {
    if (name === WINDSURF_DIGEST_PACK) continue;
    catalog.set(name, loadPack(name));
  }

  const legacyHashes = loadLegacyHashes();
  const receipts = readReceipts();

  // Resolve targets for the selected agents at this scope.
  const skillDirTargets: Target[] = [];
  let windsurfTarget: Target | undefined;
  for (const agent of agents) {
    const t = resolveTarget(agent, scope, cwd, home);
    if (!t) continue;
    if (agent === 'windsurf') windsurfTarget = t;
    else skillDirTargets.push(t);
  }

  const actions: PlanAction[] = [];

  // Gather snapshot for all candidate paths in one pass.
  const candidatePaths: string[] = [];
  const captureContent = new Set<string>();
  const byBase = groupTargetsByBase(skillDirTargets);
  for (const [base] of byBase) {
    for (const pack of catalog.values()) {
      candidatePaths.push(join(base, pack.name)); // the pack-dir slot itself
      for (const rel of Object.keys(pack.files)) {
        candidatePaths.push(join(base, pack.name, rel));
      }
    }
  }
  if (windsurfTarget) {
    candidatePaths.push(windsurfTarget.basePath);
    captureContent.add(windsurfTarget.basePath);
  }
  const snap = gatherSnapshot(candidatePaths, captureContent);

  // Skill-dirs packs (deduped by shared base).
  for (const [base, group] of byBase) {
    const relLabel = group[0].relLabel;
    for (const pack of catalog.values()) {
      const packDir = join(base, pack.name);
      const key = canonicalKey(packDir);
      const receiptFiles = receipts[key]?.packs[pack.name]?.files;
      actions.push(
        planSkillDirsPack(
          base,
          scope,
          group.map((g) => g.agent),
          pack,
          snap,
          legacyHashes,
          receiptFiles,
          relLabel,
          force,
        ),
      );
    }
  }

  // Windsurf digest (all-or-nothing pseudo-pack).
  if (windsurfTarget) {
    const key = canonicalKey(windsurfTarget.basePath);
    const receiptFiles = receipts[key]?.packs[WINDSURF_DIGEST_PACK]?.files;
    const wa = planWindsurf(scope, windsurfTarget, snap, receiptFiles, force, notes);
    if (wa) actions.push(wa);
    // Per-pack add/remove against windsurf is a no-op beyond the digest.
    if (opts.packs && opts.packs.length && !opts.packs.includes(WINDSURF_DIGEST_PACK)) {
      notes.push('windsurf ignores per-pack selection: it receives the digest (all tools)');
    }
  }

  return { scope, cwd, actions, notes };
}

export { GLOBAL_RULES_MAX };
