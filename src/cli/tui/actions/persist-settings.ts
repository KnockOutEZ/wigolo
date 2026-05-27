/**
 * persist-settings action — read/write the curated env/flags subset to
 * ~/.wigolo/config.json via the SP0 accessor (writePersistedConfig /
 * readPersistedConfig). Never modifies persisted-config.ts internals.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writePersistedConfig, readPersistedConfig } from '../../../persisted-config.js';
import type { EnvVarMeta } from './types.js';
import { CURATED_ENV_VARS } from './types.js';

function defaultConfigPath(): string {
  return process.env.WIGOLO_CONFIG_PATH ?? join(homedir(), '.wigolo', 'config.json');
}

/**
 * Read current persisted values for the curated env/flags subset.
 * Returns a map of settingsKey → current value (from config.json or default).
 */
export function readEnvSettings(configPath?: string): Record<string, string> {
  const path = configPath ?? defaultConfigPath();
  const { settings } = readPersistedConfig(path);
  const result: Record<string, string> = {};
  for (const meta of CURATED_ENV_VARS) {
    const persisted = settings[meta.settingsKey];
    result[meta.settingsKey] = typeof persisted === 'string' ? persisted : meta.defaultValue;
  }
  return result;
}

/**
 * Persist a subset of env/flag values to config.json via SP0's accessor.
 * Only saves keys that are in CURATED_ENV_VARS (by settingsKey).
 * Ignores unknown keys silently.
 */
/**
 * Strip control characters (CR/LF/NUL) from a persisted value so a pasted
 * multi-line value cannot smuggle a newline into a persisted env var (which
 * later flows into process env / logs / child processes).
 */
function sanitizeValue(v: string): string {
  return v.replace(/[\r\n\0]/g, ' ');
}

export function writeEnvSettings(
  updates: Record<string, string>,
  configPath?: string,
): void {
  const path = configPath ?? defaultConfigPath();
  const allowedKeys = new Set(CURATED_ENV_VARS.map((v) => v.settingsKey));
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (allowedKeys.has(k)) {
      filtered[k] = typeof v === 'string' ? sanitizeValue(v) : v;
    }
  }
  writePersistedConfig(path, { settings: filtered });
}

export { CURATED_ENV_VARS };
export type { EnvVarMeta };
