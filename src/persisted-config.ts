import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

/** Current schema version. Bump this integer on every breaking schema change. */
export const PERSISTED_CONFIG_VERSION = 1;

/** Shape of the provider block. SP4 will extend semantics; SP0 reserves the shape. */
export interface PersistedProvider {
  /** Provider id — never the API key value. */
  name: string;
  /** Where the key lives: "keychain" | "file" | "env". Never the value. */
  keyLocation: 'keychain' | 'file' | 'env';
}

/** Top-level schema for ~/.wigolo/config.json. */
export interface PersistedConfig {
  version: number;
  settings: Record<string, unknown>;
  /** Reserved for SP4. Optional so SP0 does not break if absent. */
  provider?: PersistedProvider;
}

/** Patch type for writePersistedConfig. All fields optional (merge-patch). */
export type PersistedConfigPatch = Partial<Omit<PersistedConfig, 'version'>>;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let _cache: PersistedConfig | null = null;
let _cachePath: string | null = null;

/** Reset the in-process cache. Call in tests to isolate between cases. */
export function resetPersistedConfig(): void {
  _cache = null;
  _cachePath = null;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

function migrateToV1(raw: Record<string, unknown>): PersistedConfig {
  // Extract all top-level keys that aren't structural as settings.
  const { version: _v, settings: _s, provider: _p, ...rest } = raw as {
    version?: unknown;
    settings?: unknown;
    provider?: unknown;
    [k: string]: unknown;
  };
  const existingSettings = typeof _s === 'object' && _s !== null ? (_s as Record<string, unknown>) : {};
  return {
    version: PERSISTED_CONFIG_VERSION,
    settings: { ...rest, ...existingSettings },
    ...(_p ? { provider: _p as PersistedProvider } : {}),
  };
}

/** Parse raw JSON from disk into a PersistedConfig, running migrations as needed. */
function parseAndMigrate(raw: Record<string, unknown>): PersistedConfig {
  const rawVersion = typeof raw.version === 'number' ? raw.version : undefined;

  if (rawVersion === undefined) {
    // Legacy version-less file (written by tui-spec-v2 TUI before SP0).
    return migrateToV1(raw);
  }

  if (rawVersion > PERSISTED_CONFIG_VERSION) {
    // Future/downgrade: read as-is, tolerate unknown fields, don't crash.
    const settings = typeof raw.settings === 'object' && raw.settings !== null
      ? (raw.settings as Record<string, unknown>)
      : {};
    const result: PersistedConfig = { version: rawVersion, settings };
    if (raw.provider) result.provider = raw.provider as PersistedProvider;
    return result;
  }

  if (rawVersion < PERSISTED_CONFIG_VERSION) {
    // Forward-migrate. Currently only v0→v1 exists.
    return migrateToV1(raw);
  }

  // rawVersion === PERSISTED_CONFIG_VERSION: well-formed current file.
  const settings = typeof raw.settings === 'object' && raw.settings !== null
    ? (raw.settings as Record<string, unknown>)
    : {};
  const result: PersistedConfig = { version: rawVersion, settings };
  if (raw.provider) result.provider = raw.provider as PersistedProvider;
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read and cache the persisted config from `configPath`.
 * - Missing file → returns `{ version: CURRENT, settings: {} }`.
 * - Unparseable JSON → returns `{ version: CURRENT, settings: {} }`.
 * - Legacy (version-less) → migrates to current version in memory.
 * - Future version → reads as-is, tolerates unknown fields.
 * Results are cached per-process; call `resetPersistedConfig()` in tests.
 */
export function readPersistedConfig(configPath: string): PersistedConfig {
  if (_cache !== null && _cachePath === configPath) return _cache;

  if (!existsSync(configPath)) {
    _cache = { version: PERSISTED_CONFIG_VERSION, settings: {} };
    _cachePath = configPath;
    return _cache;
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    _cache = { version: PERSISTED_CONFIG_VERSION, settings: {} };
    _cachePath = configPath;
    return _cache;
  }

  _cache = parseAndMigrate(raw);
  _cachePath = configPath;
  return _cache;
}

/**
 * Write a merge-patch to the persisted config atomically (temp file + rename).
 * Merge-patch semantics: only keys present in `patch.settings` are updated;
 * keys absent from the patch are preserved from the current file.
 *
 * Secrets guard: any `key` field inside `patch.provider` is silently stripped
 * — only `name` and `keyLocation` are serialized.
 */
export function writePersistedConfig(configPath: string, patch: PersistedConfigPatch): void {
  // Read current (may be empty default)
  const current = readPersistedConfig(configPath);

  // Merge settings
  const merged: PersistedConfig = {
    version: PERSISTED_CONFIG_VERSION,
    settings: { ...current.settings, ...(patch.settings ?? {}) },
  };

  // Merge provider — strip secrets
  const rawProvider = patch.provider ?? current.provider;
  if (rawProvider) {
    merged.provider = {
      name: rawProvider.name,
      keyLocation: rawProvider.keyLocation,
      // Explicitly omit any secret fields that should never be persisted
    };
  }

  const dir2 = dirname(configPath);
  mkdirSync(dir2, { recursive: true });

  const tmp = join(dir2, `.config-${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, configPath);

  // Invalidate cache so next read sees the new file.
  _cache = merged;
  _cachePath = configPath;
}

// ---------------------------------------------------------------------------
// Default path helper (used by getConfig)
// ---------------------------------------------------------------------------

/**
 * Return the default config path: `WIGOLO_CONFIG_PATH` env var if set,
 * otherwise `~/.wigolo/config.json`.
 * Exported so getConfig() can look it up without duplicating the logic.
 */
export function defaultConfigPath(): string {
  return process.env.WIGOLO_CONFIG_PATH ?? join(homedir(), '.wigolo', 'config.json');
}
