import { existsSync, cpSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { CDPSession } from '../types.js';

export interface AuthOptions {
  storageStatePath?: string;
  userDataDir?: string;
}

export function getAuthOptions(): AuthOptions | null {
  const config = getConfig();
  const logger = createLogger('fetch');

  if (config.authStatePath) {
    if (!existsSync(config.authStatePath)) {
      throw new Error(`Auth state file not found: ${config.authStatePath}`);
    }
    return { storageStatePath: config.authStatePath };
  }

  if (config.chromeProfilePath) {
    const lockFile = join(config.chromeProfilePath, 'SingletonLock');
    if (existsSync(lockFile)) {
      logger.warn('Chrome appears to be running (SingletonLock found) — close Chrome before using its profile', {
        profilePath: config.chromeProfilePath,
      });
    }
    const tempDir = mkdtempSync(join(tmpdir(), 'wigolo-chrome-'));
    cpSync(config.chromeProfilePath, tempDir, { recursive: true });
    logger.debug('copied Chrome profile to temp directory', { from: config.chromeProfilePath, to: tempDir });
    return { userDataDir: tempDir };
  }

  return null;
}

export async function listSessions(): Promise<CDPSession[]> {
  return [];
}
