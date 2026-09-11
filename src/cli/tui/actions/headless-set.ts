/**
 * Headless `--set <key>=<value>` action — non-secret field updates from
 * scripts/CI, with the same validation + agent propagation pipeline the Ink
 * TUI uses.
 *
 * Design:
 *  - Find the FieldDef in CATALOG by `key` (env-var style, e.g. WIGOLO_SEARCH,
 *    the names text `--plain` prints) or by `settingsPath` (config.json name,
 *    e.g. searchBackend — the docs' `--set` examples and `--plain --json`).
 *  - Refuse `kind === 'masked'` / `secret: true` fields with a clear error —
 *    secrets leak via shell history; the dedicated secret-store path stays in
 *    charge of those.
 *  - Run the field's `validate()` (if any). Invalid input returns a
 *    description-grade message; no write happens.
 *  - Hydrate a fresh SettingsStore from the on-disk config, stage the value,
 *    and run the same `propagation.save()` flow used by the interactive shell.
 *  - Surface saved keys, propagated agents, and propagation failures so a
 *    script wrapper can react to a partial fan-out.
 */

import type { CategoryDef, FieldDef } from '../schema/types.js';
import type { SettingsStore } from '../state/settings-store.js';
import type { AgentTarget } from '../state/agent-targets.js';
import type { SaveResult, SecretStore, WritableFs } from '../state/propagation.js';

export type HeadlessSetStatus =
  | 'ok'
  | 'unknown_key'
  | 'secret_rejected'
  | 'validation_failed'
  | 'persist_failed';

export interface HeadlessSetResult {
  status: HeadlessSetStatus;
  /** Human-readable line for stdout (status='ok') or stderr (everything else). */
  message: string;
  /** Settings keys that landed in config.json. Empty unless status='ok'. */
  saved: string[];
  /** Agent IDs whose env block was updated. Empty unless status='ok'. */
  propagated: string[];
  /** Per-agent failures (best-effort propagation). */
  failed: Array<{ agentId: string; reason: string }>;
}

export interface ApplyHeadlessSetOpts {
  /** Raw `key=value` payload after the `--set` flag. */
  key: string;
  value: string;
  /** Path to the on-disk config.json that should be mutated. */
  configPath: string;
  /** Catalog used to resolve `key` → FieldDef. */
  catalog: ReadonlyArray<CategoryDef>;
  /** Detected agent targets — failures are reported but do not abort the save. */
  agents: ReadonlyArray<AgentTarget>;
  /** Secret store passthrough — only invoked for misclassified fields (defence in depth). */
  secretStore: SecretStore;
  /** Override for tests; defaults to `createSettingsStore(persisted.settings)`. */
  storeFactory?: (initial: Readonly<Record<string, unknown>>) => SettingsStore;
  /** Override for tests; defaults to `readPersistedConfig(configPath).settings`. */
  readSettings?: (configPath: string) => Readonly<Record<string, unknown>>;
  /** Override for tests; defaults to `propagation.save()`. */
  save?: (opts: {
    store: SettingsStore;
    catalog: ReadonlyArray<CategoryDef>;
    configPath: string;
    agents: ReadonlyArray<AgentTarget>;
    secretStore: SecretStore;
    fs?: WritableFs;
  }) => Promise<SaveResult>;
  /** Override for tests; defaults to the real fs. */
  fs?: WritableFs;
}

function findField(
  catalog: ReadonlyArray<CategoryDef>,
  key: string,
): FieldDef | null {
  for (const category of catalog) {
    for (const field of category.fields) {
      if (field.key === key) return field;
    }
  }
  for (const category of catalog) {
    for (const field of category.fields) {
      if (field.settingsPath === key) return field;
    }
  }
  return null;
}

/**
 * Some FieldDefs use a non-string runtime type (number for counters, boolean
 * for toggles, string[] for multiselect). The CLI passes everything as a
 * string; convert defensively before validation/persist so the schema sees
 * the same shape it would from the interactive form.
 */
function coerceForField(field: FieldDef, raw: string): unknown {
  if (field.kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw; // let validate() reject NaN
  }
  if (field.kind === 'toggle') {
    if (raw === 'true' || raw === '1' || raw.toLowerCase() === 'on') return true;
    if (raw === 'false' || raw === '0' || raw.toLowerCase() === 'off') return false;
    return raw; // unrecognised — surface to validate()
  }
  if (field.kind === 'multiselect') {
    // Accept comma- or whitespace-separated values; strip empties.
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return raw;
}

function isSecretField(field: FieldDef): boolean {
  return field.kind === 'masked' || field.secret === true;
}

function emptyResult(status: HeadlessSetStatus, message: string): HeadlessSetResult {
  return { status, message, saved: [], propagated: [], failed: [] };
}

export async function applyHeadlessSet(
  opts: ApplyHeadlessSetOpts,
): Promise<HeadlessSetResult> {
  const field = findField(opts.catalog, opts.key);
  if (!field) {
    return emptyResult(
      'unknown_key',
      `Unknown setting: ${opts.key}. Run \`wigolo config --plain\` to list available keys.`,
    );
  }

  if (isSecretField(field)) {
    return emptyResult(
      'secret_rejected',
      `Secrets cannot be set via --set (shell-history leak); use the interactive provider menu or set ${opts.key} via an env var.`,
    );
  }

  const coerced = coerceForField(field, opts.value);

  if (field.validate) {
    const err = field.validate(coerced);
    if (err) {
      return emptyResult(
        'validation_failed',
        `Invalid value for ${opts.key}: ${err}`,
      );
    }
  }

  let initial: Readonly<Record<string, unknown>>;
  if (opts.readSettings) {
    initial = opts.readSettings(opts.configPath);
  } else {
    const persistedMod = await import('../../../persisted-config.js');
    initial = persistedMod.readPersistedConfig(opts.configPath).settings;
  }

  let store: SettingsStore;
  if (opts.storeFactory) {
    store = opts.storeFactory(initial);
  } else {
    const storeMod = await import('../state/settings-store.js');
    store = storeMod.createSettingsStore(initial);
  }
  store.set(field.settingsPath, coerced);

  if (!store.isDirty()) {
    // No-op write (value matches what's already on disk). Treat as success.
    return {
      status: 'ok',
      message: `Set ${opts.key} = ${String(coerced)} (no change — value matches current setting).`,
      saved: [field.settingsPath],
      propagated: [],
      failed: [],
    };
  }

  const save =
    opts.save ??
    (async (so) => {
      const mod = await import('../state/propagation.js');
      return mod.save(so);
    });

  let result: SaveResult;
  try {
    result = await save({
      store,
      catalog: opts.catalog,
      configPath: opts.configPath,
      agents: opts.agents,
      secretStore: opts.secretStore,
      fs: opts.fs,
    });
  } catch (err) {
    return emptyResult(
      'persist_failed',
      `Save failed for ${opts.key}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (result.errors && result.errors.length > 0) {
    const reason = result.errors.map((e) => `${e.key}: ${e.reason}`).join('; ');
    return emptyResult('validation_failed', `Invalid value for ${opts.key}: ${reason}`);
  }

  const propagatedSegment =
    result.propagated.length > 0
      ? ` (propagated to: ${result.propagated.join(', ')}`
      : ' (no agents propagated';
  const failedSegment =
    result.failed.length > 0
      ? `; failed: ${result.failed.map((f) => `${f.agentId} — ${f.reason}`).join(', ')})`
      : ')';

  return {
    status: 'ok',
    message: `Set ${opts.key} = ${String(coerced)}${propagatedSegment}${failedSegment}.`,
    saved: result.saved,
    propagated: result.propagated,
    failed: result.failed,
  };
}
