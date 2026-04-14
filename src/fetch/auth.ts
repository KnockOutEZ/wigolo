import { existsSync, cpSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { discoverSessions, isCDPReachable } from './cdp-client.js';
import type { CDPSession } from '../types.js';

export interface AuthOptions {
  storageStatePath?: string;
  userDataDir?: string;
  cdpUrl?: string;
}

export async function getAuthOptions(): Promise<AuthOptions | null> {
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

  if (config.cdpUrl) {
    try {
      const reachable = await isCDPReachable(config.cdpUrl);
      if (reachable) {
        logger.info('CDP endpoint reachable, using for auth', { cdpUrl: config.cdpUrl });
        return { cdpUrl: config.cdpUrl };
      }
      logger.debug('CDP endpoint not reachable', { cdpUrl: config.cdpUrl });
    } catch (err) {
      logger.warn('CDP reachability check failed', {
        cdpUrl: config.cdpUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return null;
}

export async function listSessions(): Promise<CDPSession[]> {
  const config = getConfig();

  if (!config.cdpUrl) {
    return [];
  }

  try {
    return await discoverSessions(config.cdpUrl);
  } catch (err) {
    const logger = createLogger('fetch');
    logger.warn('listSessions failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
