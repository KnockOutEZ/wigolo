/**
 * Shared types for the agent-skills install engine.
 *
 * The engine plans and applies skill-pack installs across multiple coding
 * agents. Every write goes through a plan → apply cycle so a dry-run can show
 * exactly what will change without touching the filesystem.
 */

export type Scope = 'project' | 'global';

/** How a target materializes on disk. */
export type TargetKind = 'skill-dirs' | 'owned-rules-file' | 'fenced-block';

/** A resolved install destination for one agent at one scope. */
export interface Target {
  /** Agent id (must be a registry id). */
  agent: string;
  scope: Scope;
  kind: TargetKind;
  /**
   * Absolute base path.
   * - skill-dirs: the parent dir that holds per-pack subdirs (`<base>/<pack>/`).
   * - owned-rules-file: the file this agent fully owns.
   * - fenced-block: the file a wigolo-delimited block is merged into.
   */
  basePath: string;
  /** Human-readable relative form for plan/report output. */
  relLabel: string;
}

/** lstat-based snapshot entry — symlinks are NEVER followed. */
export interface SnapshotEntry {
  kind: 'file' | 'dir' | 'symlink' | 'absent';
  /** sha256 over EOL-normalized bytes (files only). */
  sha256?: string;
  /** Raw content — captured only for fenced/owned-file targets. */
  content?: string;
  /** For symlinks: the resolved (or dangling) link target, for diagnostics. */
  linkTarget?: string;
}

export type Snapshot = Record<string, SnapshotEntry>;

export type PlanStatus =
  | 'create'
  | 'update'
  | 'unchanged'
  | 'adopt'
  | 'remove'
  | 'refuse';

/** Per-file resolution within a pack dir (drives the executor's writes). */
export interface FileResolution {
  /** relPath within the pack dir. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  status: PlanStatus;
  /** Canonical (desired) content, LF-normalized. */
  content?: string;
  /** Whether this file is being adopted (no prior receipt, bytes matched). */
  adopted?: boolean;
  /**
   * The plan authorized replacing a symlink at this leaf (force + symlink dest).
   * The executor unlinks the LINK before writing; without this flag a symlink
   * found at write time is treated as a post-plan TOCTOU plant and refused.
   */
  replaceSymlink?: boolean;
  reason?: string;
}

/** One planned action against a single filesystem path. */
export interface PlanAction {
  /** All selected agents that share this path (union). */
  agents: string[];
  /** Packs this action installs/removes (empty for windsurf digest). */
  packs: string[];
  /** Absolute destination path (a pack dir, owned file, or fenced file). */
  path: string;
  /** Relative label for reporting. */
  relPath?: string;
  status: PlanStatus;
  reason?: string;
  kind: TargetKind;
  scope: Scope;
  /** Canonical key for the receipt store. */
  canonicalKey: string;
  /** Per-file detail for skill-dirs packs (empty for fenced/owned). */
  files: FileResolution[];
  /** For fenced/owned targets: the canonical block/file content to write. */
  ownedContent?: string;
  /** For fenced/owned: the exact bytes currently on disk (from snapshot). */
  currentContent?: string;
  /**
   * For fenced/owned targets: the plan authorized replacing a symlink at the
   * destination (force + symlink dest). The executor unlinks the link first.
   */
  replaceSymlink?: boolean;
}

export interface SkillsPlan {
  scope: Scope;
  cwd: string;
  actions: PlanAction[];
  /** Free-form notes surfaced to the user (e.g. windsurf digest note). */
  notes: string[];
}

export interface PlanOptions {
  /** Packs to install; default = all catalog packs. */
  packs?: string[];
  scope: Scope;
  /**
   * Agents to target; default = ALL SUPPORTED_AGENTS (the engine plans/lists
   * for every supported agent when unset). Agent DETECTION — narrowing to the
   * agents actually installed on this machine — lives in the CLI, not here.
   */
  agents?: string[];
  cwd: string;
  force?: boolean;
}

export interface ApplyResult {
  /** Paths actually written/created this run. */
  written: string[];
  /** Paths removed this run. */
  removed: string[];
  /** Paths refused (with reasons carried through from the plan). */
  refused: PlanAction[];
  /** Free-form notices (e.g. survivors left in a pack dir). */
  notices: string[];
}

/** Per-path state for `listSkills`. */
export type ListState =
  | 'installed'
  | 'outdated'
  | 'modified'
  | 'adopted'
  | 'managed-externally'
  | 'stale'
  | 'absent';

export interface ListEntry {
  agent: string;
  scope: Scope;
  pack: string;
  path: string;
  state: ListState;
  reason?: string;
}

/** A pack's files, keyed by relative path within the pack dir. */
export interface Pack {
  name: string;
  /** relPath (within the pack dir) → EOL-normalized content. */
  files: Record<string, string>;
  description: string;
}
