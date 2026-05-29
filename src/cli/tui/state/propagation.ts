/**
 * Save + propagation pipeline.
 *
 *  1. Validate every pending field via its `FieldDef.validate?.()`.
 *     Any failure aborts the whole save (no partial writes); pending stays
 *     intact for the user to fix.
 *  2. Persist secrets (`secret: true` fields) to the injected `SecretStore`.
 *     Only the `keyLocation` reference is then written to config.json — the
 *     raw value never lands there.
 *  3. Atomic-write ~/.wigolo/config.json (tmp file + rename) with 0o600.
 *  4. Fan out propagateable keys to every detected agent's `env:` block:
 *       a. Back the agent file up to `<dataDir>/backups/<agent>-<iso>.json`.
 *       b. Merge the propagation set into env, preserving every other key.
 *       c. Atomic-write the agent config.
 *  5. On full success → `store.commit()`. Partial failures surface in
 *     `SaveResult.failed` and pending is still committed (config.json is
 *     durable; failed agent fan-out is fixable on retry without re-staging).
 *  6. Prune per-agent backups to the most recent 5.
 *
 * All filesystem access flows through the `WritableFs` interface so tests
 * can inject EACCES / rename-failure shapes without touching real permissions.
 */

import { randomBytes } from 'node:crypto';
import {
  readFile as nodeReadFile,
  writeFile as nodeWriteFile,
  rename as nodeRename,
  mkdir as nodeMkdir,
  readdir as nodeReaddir,
  unlink as nodeUnlink,
  stat as nodeStat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '../../../logger.js';
import type { CategoryDef, FieldDef } from '../schema/types.js';
import type { SettingsStore } from './settings-store.js';
import type { AgentTarget } from './agent-targets.js';

const log = createLogger('cli');

const CONFIG_FILE_MODE = 0o600;
const BACKUP_RETENTION = 5;

export interface SaveOpts {
  store: SettingsStore;
  catalog: ReadonlyArray<CategoryDef>;
  /** ~/.wigolo/config.json (or test-tmp path). */
  configPath: string;
  agents: ReadonlyArray<AgentTarget>;
  secretStore: SecretStore;
  /** Optional injection point for tests. Defaults to `defaultWritableFs()`. */
  fs?: WritableFs;
}

export interface SaveResult {
  /** settings keys persisted to config.json + secretStore (excludes failures). */
  saved: string[];
  /** Agent IDs whose env block was successfully updated. */
  propagated: string[];
  /** Per-agent failures, with reason for display. */
  failed: Array<{ agentId: string; reason: string }>;
  /** Validation errors, if any. Save is aborted when present. */
  errors?: Array<{ key: string; reason: string }>;
}

export interface SecretStore {
  /** Persist a secret. Returns where it landed (keychain or encrypted file). */
  set(key: string, value: string): Promise<{ location: 'keychain' | 'file' }>;
  /** Read a secret. Returns null when not stored. */
  get(key: string): Promise<string | null>;
  /** Remove a stored secret. No-op when absent. */
  remove(key: string): Promise<void>;
}

export interface WritableFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}

export function defaultWritableFs(): WritableFs {
  return {
    async readFile(p) {
      return nodeReadFile(p, 'utf-8');
    },
    async writeFile(p, data) {
      await nodeWriteFile(p, data, { mode: CONFIG_FILE_MODE });
    },
    async rename(from, to) {
      await nodeRename(from, to);
    },
    async mkdir(p, opts) {
      await nodeMkdir(p, { recursive: opts?.recursive ?? true });
    },
    async readdir(p) {
      return nodeReaddir(p);
    },
    async unlink(p) {
      await nodeUnlink(p);
    },
    async stat(p) {
      const s = await nodeStat(p);
      return {
        isFile: () => s.isFile(),
        isDirectory: () => s.isDirectory(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// JSON helpers (narrowed via type guards; no unchecked casts)
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJsonOrEmpty(text: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Navigate-or-create the nested object at `path`. Returns the leaf object. */
function ensureNested(root: JsonObject, path: ReadonlyArray<string>): JsonObject {
  let cur: JsonObject = root;
  for (const key of path) {
    const next = cur[key];
    if (isJsonObject(next)) {
      cur = next;
    } else {
      const fresh: JsonObject = {};
      cur[key] = fresh;
      cur = fresh;
    }
  }
  return cur;
}

/** Navigate to the parent of the leaf at `path`. Returns null if any step misses. */
function navigateParent(root: JsonObject, path: ReadonlyArray<string>): JsonObject | null {
  if (path.length === 0) return null;
  let cur: JsonObject = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (!isJsonObject(next)) return null;
    cur = next;
  }
  return cur;
}

function navigate(root: JsonObject, path: ReadonlyArray<string>): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!isJsonObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Atomic JSON writer
// ---------------------------------------------------------------------------

async function atomicWriteJson(fs: WritableFs, path: string, payload: unknown): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp.${process.pid}.${randomBytes(6).toString('hex')}`);
  const serialized = JSON.stringify(payload, null, 2);
  await fs.writeFile(tmp, serialized);
  try {
    await fs.rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup; don't mask the original error.
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Field index
// ---------------------------------------------------------------------------

interface FieldIndex {
  bySettingsPath: Map<string, FieldDef>;
}

function buildIndex(catalog: ReadonlyArray<CategoryDef>): FieldIndex {
  const bySettingsPath = new Map<string, FieldDef>();
  for (const cat of catalog) {
    for (const field of cat.fields) {
      bySettingsPath.set(field.settingsPath, field);
    }
  }
  return { bySettingsPath };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function backupFilename(agentId: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return `${agentId}-${iso}.json`;
}

async function writeAgentBackup(
  fs: WritableFs,
  target: AgentTarget,
  rawConfig: string,
): Promise<void> {
  const dir = target.backupDir();
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, backupFilename(target.id));
  // Backup writes are non-atomic by design — they're write-only artifacts and
  // the propagation logic only succeeds if both backup + agent-write succeed.
  await fs.writeFile(file, rawConfig);
}

async function pruneBackups(fs: WritableFs, target: AgentTarget): Promise<void> {
  const dir = target.backupDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const prefix = `${target.id}-`;
  const mine = entries.filter((f) => f.startsWith(prefix)).sort();
  const excess = mine.length - BACKUP_RETENTION;
  if (excess <= 0) return;
  for (const f of mine.slice(0, excess)) {
    try { await fs.unlink(join(dir, f)); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function save(opts: SaveOpts): Promise<SaveResult> {
  const fs = opts.fs ?? defaultWritableFs();
  const index = buildIndex(opts.catalog);
  const pending = opts.store.getPending();

  // 1. Validate every pending key against its field definition. We accept
  //    pending keys without a matching field (callers may stage settings the
  //    catalog doesn't know about, e.g. during migration) — they pass through
  //    to config.json but cannot have validators.
  const errors: Array<{ key: string; reason: string }> = [];
  for (const [key, value] of Object.entries(pending)) {
    const field = index.bySettingsPath.get(key);
    if (!field?.validate) continue;
    const err = field.validate(value);
    if (err) errors.push({ key, reason: err });
  }

  if (errors.length > 0) {
    return { saved: [], propagated: [], failed: [], errors };
  }

  // 2. Partition pending into secrets vs plain settings.
  const secretWrites: Array<{ key: string; value: string; field: FieldDef }> = [];
  const plainSettings: JsonObject = {};
  const settingsKeys: string[] = [];
  for (const [key, value] of Object.entries(pending)) {
    const field = index.bySettingsPath.get(key);
    if (field?.secret === true) {
      // null/empty value means "remove" — handled below.
      if (typeof value === 'string' && value.length > 0) {
        secretWrites.push({ key, value, field });
      } else {
        // Surface as a removal request: secret store entry pruned, keyLocation cleared.
        secretWrites.push({ key, value: '', field });
      }
      // Secrets never land in config.json directly; track only for `saved[]`.
      settingsKeys.push(key);
      continue;
    }
    plainSettings[key] = value;
    settingsKeys.push(key);
  }

  // 3. Persist secrets first. We do this BEFORE config.json so that if the
  //    secret store throws, we abort cleanly without a half-saved config.
  const secretLocations: Record<string, 'keychain' | 'file' | null> = {};
  const propagationSet: Record<string, string> = {};
  for (const w of secretWrites) {
    if (w.value === '') {
      try {
        await opts.secretStore.remove(w.key);
      } catch (err) {
        return {
          saved: [],
          propagated: [],
          failed: [{ agentId: '__secret__', reason: errorMessage(err) }],
        };
      }
      secretLocations[w.key] = null;
      continue;
    }
    try {
      const result = await opts.secretStore.set(w.key, w.value);
      secretLocations[w.key] = result.location;
      if (w.field.propagateToAgents !== false) {
        propagationSet[w.field.key] = w.value;
      }
    } catch (err) {
      return {
        saved: [],
        propagated: [],
        failed: [{ agentId: '__secret__', reason: errorMessage(err) }],
      };
    }
  }

  // 4. Atomic-write config.json. Read existing, merge, rewrite.
  let existingCfg: JsonObject = {};
  try {
    const raw = await fs.readFile(opts.configPath);
    existingCfg = parseJsonOrEmpty(raw);
  } catch {
    // Missing file is fine — we'll create it. Other read errors fall through to
    // empty (treating an unreadable file as missing matches persisted-config).
  }
  const existingSettings = isJsonObject(existingCfg.settings) ? existingCfg.settings : {};
  const mergedSettings: JsonObject = { ...existingSettings, ...plainSettings };

  // Add keyLocation refs for secret fields (purely a pointer, never the value).
  for (const [key, location] of Object.entries(secretLocations)) {
    if (location === null) {
      delete mergedSettings[`${key}KeyLocation`];
    } else {
      mergedSettings[`${key}KeyLocation`] = location;
    }
  }

  const nextCfg: JsonObject = {
    version: typeof existingCfg.version === 'number' ? existingCfg.version : 1,
    settings: mergedSettings,
  };
  // Preserve any provider block already there (we don't manage it here).
  if (isJsonObject(existingCfg.provider)) nextCfg.provider = existingCfg.provider;

  try {
    await atomicWriteJson(fs, opts.configPath, nextCfg);
  } catch (err) {
    return {
      saved: [],
      propagated: [],
      failed: [{ agentId: '__config__', reason: errorMessage(err) }],
      errors: [{ key: '__config__', reason: errorMessage(err) }],
    };
  }

  // 5. Build the propagation set for non-secret fields. Plain settings whose
  //    field declares propagateToAgents !== false are mirrored under the
  //    field's env-var key (e.g. browserTypes -> WIGOLO_BROWSER_TYPES).
  for (const [settingsPath, value] of Object.entries(plainSettings)) {
    const field = index.bySettingsPath.get(settingsPath);
    if (!field) continue; // unknown keys never propagate
    if (field.propagateToAgents === false) continue;
    propagationSet[field.key] = String(value);
  }

  // 6. Fan out to each detected agent (parallel, fail-isolated).
  const propagated: string[] = [];
  const failed: Array<{ agentId: string; reason: string }> = [];

  if (Object.keys(propagationSet).length > 0 || pending) {
    const results = await Promise.all(
      opts.agents.map(async (target) => {
        try {
          const detected = await target.detect();
          if (!detected) return { id: target.id, ok: false, skipped: true };
          await applyPropagationToAgent(fs, target, propagationSet);
          await pruneBackups(fs, target);
          return { id: target.id, ok: true, skipped: false };
        } catch (err) {
          return { id: target.id, ok: false, skipped: false, reason: errorMessage(err) };
        }
      }),
    );
    for (const r of results) {
      if (r.ok) {
        propagated.push(r.id);
      } else if (!r.skipped) {
        failed.push({ agentId: r.id, reason: r.reason ?? 'unknown' });
        log.warn('agent propagation failed', { agent: r.id, reason: r.reason });
      }
    }
  }

  // 7. Commit the store. Config.json + secrets are durable at this point; if
  //    individual agents failed the user can retry from the still-saved state.
  opts.store.commit();

  return { saved: settingsKeys, propagated, failed };
}

async function applyPropagationToAgent(
  fs: WritableFs,
  target: AgentTarget,
  propagationSet: Record<string, string>,
): Promise<void> {
  // Read current agent config.
  const raw = await fs.readFile(target.configPath);
  // Back it up BEFORE we mutate — gives us a known-good restore point.
  await writeAgentBackup(fs, target, raw);

  const root = parseJsonOrEmpty(raw);

  // Ensure the env block exists and merge.
  const envBlock = ensureNested(root, target.envPath);
  for (const [k, v] of Object.entries(propagationSet)) {
    envBlock[k] = v;
  }

  await atomicWriteJson(fs, target.configPath, root);
}

// ---------------------------------------------------------------------------
// uninstallAgent — primitive used by the Agents category screen (slice 9).
// Removes the wigolo server entry from one agent's config, preserves other
// servers, writes a backup, and prunes old backups.
// ---------------------------------------------------------------------------

export interface UninstallOpts {
  target: AgentTarget;
  secretStore: SecretStore;
  fs?: WritableFs;
}

export interface UninstallResult {
  ok: boolean;
  reason?: string;
}

export async function uninstallAgent(opts: UninstallOpts): Promise<UninstallResult> {
  const fs = opts.fs ?? defaultWritableFs();
  let raw: string;
  try {
    raw = await fs.readFile(opts.target.configPath);
  } catch (err) {
    // Treat "no config file" as already-uninstalled (idempotent).
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: true };
    return { ok: false, reason: errorMessage(err) };
  }

  try {
    await writeAgentBackup(fs, opts.target, raw);
  } catch (err) {
    return { ok: false, reason: errorMessage(err) };
  }

  const root = parseJsonOrEmpty(raw);
  const parent = navigateParent(root, opts.target.serverPath);
  if (parent) {
    const leaf = opts.target.serverPath[opts.target.serverPath.length - 1];
    delete parent[leaf];
  } else {
    // Nothing to remove — still write to normalize the file shape.
  }

  try {
    await atomicWriteJson(fs, opts.target.configPath, root);
  } catch (err) {
    return { ok: false, reason: errorMessage(err) };
  }

  await pruneBackups(fs, opts.target);

  void navigate; // suppress unused-export warning; helper retained for future readers
  return { ok: true };
}
