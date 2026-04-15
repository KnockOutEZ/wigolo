import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from './config.js';

/**
 * Returns the Python binary to use for every Python operation — pip installs,
 * import availability checks, and long-lived subprocess spawns. Prefers the
 * SearXNG venv python (created by bootstrap) to guarantee that warmup, doctor,
 * and runtime all hit the same interpreter and see the same packages.
 * Falls back to system `python3` when the venv has not been created yet.
 */
export function getPythonBin(dataDir?: string): string {
  const dir = dataDir ?? getConfig().dataDir;
  if (!dir) return 'python3';
  const venvPython = join(dir, 'searxng', 'venv', 'bin', 'python');
  return existsSync(venvPython) ? venvPython : 'python3';
}
