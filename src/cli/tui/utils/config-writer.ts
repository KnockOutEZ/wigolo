import { join } from 'node:path';
import { writePersistedConfig, readPersistedConfig } from '../../../persisted-config.js';

/**
 * Persist TUI-collected settings into ~/.wigolo/config.json.
 * Delegates to the shared accessor so there is a single write path
 * across TUI, CLI, and any future SP that needs to persist settings.
 */
export function saveInitConfig(dataDir: string, config: Record<string, unknown>): void {
  const path = join(dataDir, 'config.json');
  writePersistedConfig(path, { settings: config });
}

/**
 * Read persisted settings map from ~/.wigolo/config.json.
 * Returns the flat settings object (not the full versioned envelope).
 */
export function readInitConfig(dataDir: string): Record<string, unknown> {
  const path = join(dataDir, 'config.json');
  return readPersistedConfig(path).settings;
}
