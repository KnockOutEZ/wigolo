/**
 * Shared result types for the actions layer.
 *
 * Every side-effecting action returns a typed result so the TUI can render
 * per-item success/failure and the headless path can surface the same info.
 *
 * Note: the legacy `COMPONENT_REGISTRY`, `FIREFOX_COMPONENT`, `ToggleMap`,
 * `buildDefaultToggles`, `CURATED_ENV_VARS`, `ENV_GROUP_LABELS`, `EnvVarMeta`,
 * `EnvGroupId`, `ScreenId`, and `EntryMode` exports were dropped
 * after the schema-driven CATALOG replaced the curated env-var subset and the
 * pre-wizard install/review screens.
 */

// ---------------------------------------------------------------------------
// Write result (per-item commit reporting)
// ---------------------------------------------------------------------------

export type WriteStatus = 'ok' | 'failed' | 'skipped' | 'already_installed';

export interface WriteResult {
  id: string;
  label: string;
  status: WriteStatus;
  /** Human-readable path to what was written (config file, etc.) */
  path?: string;
  /** Error message if status === 'failed' */
  error?: string;
}
