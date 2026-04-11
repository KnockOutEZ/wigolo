import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

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
    return { userDataDir: config.chromeProfilePath };
  }

  return null;
}
