/**
 * Default SecretStore — keychain-preferred, file-fallback implementation
 * used by the propagation pipeline.
 *
 * Resolution:
 *   1. OS keychain (via the SP4 keychain wrapper). When available, secrets
 *      live there and never touch the disk.
 *   2. Plain file fallback at `<dataDir>/keys/<key>` with mode 0o600 inside
 *      a 0o700 directory. Plain text (not encrypted): the threat model here
 *      is "casual disk reads by unprivileged co-users", which 0o600 already
 *      covers. The richer AES-256-GCM encryption lives in `src/security/`
 *      and is reserved for provider-specific resolution; this lower-tier
 *      store is intentionally minimal so the TUI can persist any future
 *      generic secret without coupling to provider semantics.
 *
 * The keychain account name is `wigolo-tui-<key>` and the user is `tui` so
 * stored entries don't collide with the per-provider entries managed by
 * `src/security/key-store.ts`.
 */

import { join, dirname } from 'node:path';
import {
  mkdir,
  writeFile,
  readFile,
  unlink,
  rename,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  keychainAvailable,
  keychainSet,
  keychainGet,
  keychainDelete,
  WIGOLO_SERVICE,
} from '../../../security/keychain.js';
import type { SecretStore } from './propagation.js';

const KEYCHAIN_USER = 'tui';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface DefaultSecretStoreOpts {
  dataDir: string;
}

function keychainAccount(key: string): string {
  return `${WIGOLO_SERVICE}-tui-${key}`;
}

function filePath(dataDir: string, key: string): string {
  // Keys are short ASCII identifiers (settings paths like `llmApiKey`). We
  // do not sanitize aggressively because the schema is the only producer;
  // callers passing path separators would already be a bug upstream.
  return join(dataDir, 'keys', key);
}

async function atomicWriteFile(target: string, data: string): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  const tmp = join(dir, `.tmp.${process.pid}.${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, data, { mode: FILE_MODE });
  try {
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function defaultSecretStore(opts: DefaultSecretStoreOpts): SecretStore {
  return {
    async set(key, value) {
      // Prefer keychain. If it claims available but throws on write (sandboxed
      // OS keychain, etc.), fall through to the file tier rather than failing
      // the whole save.
      if (keychainAvailable()) {
        try {
          keychainSet(keychainAccount(key), KEYCHAIN_USER, value);
          return { location: 'keychain' };
        } catch {
          // fall through
        }
      }
      await atomicWriteFile(filePath(opts.dataDir, key), value);
      return { location: 'file' };
    },

    async get(key) {
      if (keychainAvailable()) {
        const v = keychainGet(keychainAccount(key), KEYCHAIN_USER);
        if (v !== null && v.length > 0) return v;
      }
      const path = filePath(opts.dataDir, key);
      if (!existsSync(path)) return null;
      try {
        return await readFile(path, 'utf-8');
      } catch {
        return null;
      }
    },

    async remove(key) {
      if (keychainAvailable()) {
        try {
          keychainDelete(keychainAccount(key), KEYCHAIN_USER);
        } catch {
          // Best-effort: keychain delete is non-fatal.
        }
      }
      const path = filePath(opts.dataDir, key);
      if (existsSync(path)) {
        try { await unlink(path); } catch { /* ignore */ }
      }
    },
  };
}
