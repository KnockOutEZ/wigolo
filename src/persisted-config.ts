import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  CREDENTIAL_URL_KEYS,
  credentialKeychainUser,
  splitUserinfo,
} from './fetch/proxy-credentials.js';
import {
  keychainAvailable,
  keychainSet,
  keychainGet,
  keychainDelete,
  WIGOLO_SERVICE,
} from './security/keychain.js';

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

/**
 * Settings keys that map to secret values in the runtime config and must NEVER
 * be persisted to config.json. These are config.json-readable in config.ts, so
 * without this guard a caller could round-trip an API key onto disk in plain
 * text. Strip them on the write path. Keys go to the keychain/env only.
 */
export const SETTINGS_SECRETS_DENYLIST = new Set<string>([
  'braveApiKey',
  'githubToken',
  'redditClientSecret',
  // Hosted-CDP (Bright-Data-style) endpoint may carry inline credentials and
  // acts as an IP+solver escape rung. Treat it like a secret: never persist it
  // to config.json in cleartext. Resolved from env or the OS keychain.
  'scrapingBrowserWss',
]);

// ---------------------------------------------------------------------------
// Credential keychain adapter (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal keychain surface used by the proxy/solver/reader credential split.
 * Kept as an injectable indirection so the persistence logic is testable
 * without a real OS keychain (which is unavailable in CI / sandboxes).
 */
export interface CredentialKeychain {
  available(): boolean;
  set(user: string, value: string): void;
  get(user: string): string | null;
  del(user: string): void;
}

const defaultCredentialKeychain: CredentialKeychain = {
  available: () => keychainAvailable(),
  set: (user, value) => keychainSet(WIGOLO_SERVICE, user, value),
  get: (user) => keychainGet(WIGOLO_SERVICE, user),
  del: (user) => keychainDelete(WIGOLO_SERVICE, user),
};

let _credentialKeychain: CredentialKeychain = defaultCredentialKeychain;

/** Test hook: override (or reset with null) the credential keychain adapter. */
export function _setCredentialKeychainForTests(kc: CredentialKeychain | null): void {
  _credentialKeychain = kc ?? defaultCredentialKeychain;
}

/**
 * Read a credential from the active keychain adapter. Shared by the config
 * resolve path so it honours the same (test-injectable) adapter used on the
 * write path — otherwise a test's injected keychain wouldn't be consulted at
 * resolve time.
 */
export function readCredentialFromKeychain(user: string): string | null {
  try {
    return _credentialKeychain.get(user);
  } catch {
    return null;
  }
}

/**
 * Process one settings map for inline credentials in the proxy/solver/reader
 * URL keys. For each such key that carries `user:pass@`, split the userinfo
 * off, keep only the credential-free URL in settings, and (write path only)
 * stash the userinfo in the keychain. Mutates + returns a shallow copy.
 *
 * @param mode 'write' stashes the split credential into the keychain (and
 *   clears any stale keychain cred for a now-credential-free URL). 'read' only
 *   strips the userinfo (a hand-placed credential is never promoted or used).
 */
function processCredentialUrls(
  settings: Record<string, unknown>,
  mode: 'write' | 'read',
): { settings: Record<string, unknown>; warnings: string[] } {
  const out: Record<string, unknown> = { ...settings };
  const warnings: string[] = [];
  const kc = _credentialKeychain;

  for (const key of CREDENTIAL_URL_KEYS) {
    const val = out[key];
    if (typeof val !== 'string' || val === '') continue;
    const { bareUrl, userinfo } = splitUserinfo(val);

    if (userinfo === null) {
      // Credential-free URL. On write, clear any stale keychain credential so a
      // later credential-free update doesn't silently re-apply an old secret.
      if (mode === 'write' && kc.available()) {
        try {
          kc.del(credentialKeychainUser(key));
        } catch {
          // best-effort
        }
      }
      continue;
    }

    // The value carried an inline credential. Strip it regardless of mode.
    out[key] = bareUrl;

    if (mode === 'read') {
      // A hand-edited config.json must never have its embedded credential
      // silently used at runtime. Strip + warn (capability language).
      warnings.push(
        `[wigolo] ${key} in config.json embedded a credential inline; ignoring it. ` +
          `Set the credential-free URL and store credentials via the setup wizard or environment.`,
      );
      continue;
    }

    // write mode: move the credential into the keychain when available.
    if (kc.available()) {
      try {
        kc.set(credentialKeychainUser(key), userinfo);
      } catch {
        warnings.push(
          `[wigolo] could not store ${key} credential in the OS keychain; ` +
            `it was NOT persisted to disk. Provide the credential via environment instead.`,
        );
      }
    } else {
      warnings.push(
        `[wigolo] OS keychain unavailable; the ${key} credential was NOT persisted to disk. ` +
          `Provide the credential via environment instead.`,
      );
    }
  }

  return { settings: out, warnings };
}

/** File mode for config.json — owner read/write only (no group/other). */
const CONFIG_FILE_MODE = 0o600;

/** Upper bound on config.json size; a larger file is treated as corrupt and
 * skipped rather than parsed (cheap DoS / accidental-blob guard). */
const MAX_CONFIG_BYTES = 1_000_000;

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

/**
 * Reconstruct a PersistedProvider from ONLY the `name` + `keyLocation` fields,
 * dropping any other (potentially secret) field a hand-crafted config.json may
 * carry. Returns undefined when the input is not a usable provider object.
 */
function sanitizeProvider(raw: unknown): PersistedProvider | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string') return undefined;
  const keyLocation =
    obj.keyLocation === 'keychain' || obj.keyLocation === 'file' || obj.keyLocation === 'env'
      ? obj.keyLocation
      : 'env';
  return { name: obj.name, keyLocation };
}

function migrateToV1(raw: Record<string, unknown>): PersistedConfig {
  // Extract all top-level keys that aren't structural as settings.
  const { version: _v, settings: _s, provider: _p, ...rest } = raw as {
    version?: unknown;
    settings?: unknown;
    provider?: unknown;
    [k: string]: unknown;
  };
  const existingSettings = typeof _s === 'object' && _s !== null ? (_s as Record<string, unknown>) : {};
  const provider = sanitizeProvider(_p);
  return {
    version: PERSISTED_CONFIG_VERSION,
    settings: { ...rest, ...existingSettings },
    ...(provider ? { provider } : {}),
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
    const provider = sanitizeProvider(raw.provider);
    if (provider) result.provider = provider;
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
  const provider = sanitizeProvider(raw.provider);
  if (provider) result.provider = provider;
  return result;
}

// ---------------------------------------------------------------------------
// Internal atomic writer (shared by public write + migration write-back)
// ---------------------------------------------------------------------------

/**
 * Atomically serialize `cfg` to `configPath` (temp file + rename) with
 * owner-only (0o600) permissions. Does NOT read or merge — the caller passes
 * the fully-resolved object. Kept private so the migration write-back can reuse
 * it without re-triggering a migrating read (recursion guard).
 */
function atomicWrite(configPath: string, cfg: PersistedConfig): void {
  const dir2 = dirname(configPath);
  mkdirSync(dir2, { recursive: true });

  const tmp = join(dir2, `.config-${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: CONFIG_FILE_MODE });
  renameSync(tmp, configPath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read and cache the persisted config from `configPath`.
 * - Missing file → returns `{ version: CURRENT, settings: {} }`.
 * - Unparseable JSON → returns `{ version: CURRENT, settings: {} }`.
 * - Legacy (version-less) or version < CURRENT → migrates in memory AND writes
 *   the upgraded envelope back to disk atomically (spec §Migration). The
 *   write-back uses the private `atomicWrite` so it never re-enters this
 *   reader (recursion guard).
 * - Future version → reads as-is, tolerates unknown fields, no rewrite.
 * Results are cached per-process; call `resetPersistedConfig()` in tests.
 */
export function readPersistedConfig(configPath: string): PersistedConfig {
  if (_cache !== null && _cachePath === configPath) return _cache;

  if (!existsSync(configPath)) {
    _cache = { version: PERSISTED_CONFIG_VERSION, settings: {} };
    _cachePath = configPath;
    return _cache;
  }

  // Size-cap before reading the whole file into memory.
  try {
    if (statSync(configPath).size > MAX_CONFIG_BYTES) {
      process.stderr.write(
        `[wigolo] config.json at ${configPath} exceeds ${MAX_CONFIG_BYTES} bytes; ignoring it.\n`,
      );
      _cache = { version: PERSISTED_CONFIG_VERSION, settings: {} };
      _cachePath = configPath;
      return _cache;
    }
  } catch {
    // stat failure → fall through to read attempt (which will also fail safe).
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    _cache = { version: PERSISTED_CONFIG_VERSION, settings: {} };
    _cachePath = configPath;
    return _cache;
  }

  const rawVersion = typeof raw.version === 'number' ? raw.version : undefined;
  if (rawVersion !== undefined && rawVersion > PERSISTED_CONFIG_VERSION) {
    process.stderr.write(
      `[wigolo] config.json version ${rawVersion} is newer than this build supports ` +
        `(${PERSISTED_CONFIG_VERSION}); reading known fields only.\n`,
    );
  }
  const parsed = parseAndMigrate(raw);

  // Refuse any inline credential a hand-edited config.json may carry in a
  // proxy/solver/reader URL: strip the userinfo + warn. A hand-placed
  // credential is never silently used at runtime (config.json is not a secret
  // store). This is a read-side strip only — nothing is promoted to keychain.
  const { settings: readSettings, warnings } = processCredentialUrls(parsed.settings, 'read');
  if (warnings.length > 0) {
    parsed.settings = readSettings;
    for (const w of warnings) process.stderr.write(`${w}\n`);
  }

  // Write-back only when we actually upgraded a stale/legacy file. A
  // version-less file (rawVersion === undefined) or any version below CURRENT
  // gets persisted in the new envelope. Files already at CURRENT or in the
  // future are left untouched (no churn, no downgrade).
  const wasUpgraded = rawVersion === undefined || rawVersion < PERSISTED_CONFIG_VERSION;
  if (wasUpgraded) {
    try {
      atomicWrite(configPath, parsed);
    } catch {
      // Best-effort: a read-only filesystem must not break reads. The in-memory
      // migrated value is still returned; we just skip persisting the upgrade.
    }
  }

  _cache = parsed;
  _cachePath = configPath;
  return _cache;
}

/**
 * Write a merge-patch to the persisted config atomically (temp file + rename,
 * 0o600 permissions). Merge-patch semantics: only keys present in
 * `patch.settings` are updated; keys absent from the patch are preserved.
 *
 * Secrets guard:
 *   - any `key` field inside `patch.provider` is stripped — only `name` and
 *     `keyLocation` are serialized.
 *   - any denylisted secret settings key (SETTINGS_SECRETS_DENYLIST) is
 *     stripped from `patch.settings` before merge — API keys never hit disk.
 */
export function writePersistedConfig(configPath: string, patch: PersistedConfigPatch): void {
  // Read current (may be empty default)
  const current = readPersistedConfig(configPath);

  // Strip denylisted secret keys from the incoming settings patch.
  const rawPatchSettings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch.settings ?? {})) {
    if (SETTINGS_SECRETS_DENYLIST.has(k)) continue;
    rawPatchSettings[k] = v;
  }

  // Split any inline proxy/solver/reader credential into the keychain; keep
  // only the credential-free URL in the patch that reaches disk.
  const { settings: patchSettings, warnings } = processCredentialUrls(rawPatchSettings, 'write');
  for (const w of warnings) process.stderr.write(`${w}\n`);

  // Merge settings
  const merged: PersistedConfig = {
    version: PERSISTED_CONFIG_VERSION,
    settings: { ...current.settings, ...patchSettings },
  };

  // Merge provider — reconstruct from name + keyLocation only (drops secrets).
  const provider = sanitizeProvider(patch.provider ?? current.provider);
  if (provider) merged.provider = provider;

  atomicWrite(configPath, merged);

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
