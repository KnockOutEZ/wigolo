import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * D11 — source-complete provider-detection isolation for the no-provider-asserting tests.
 *
 * `resolveProviderKey` consults THREE sources (key-store.ts): keychain → file → env. A real key in ANY of
 * them defeats a "no provider configured" assertion. The KEYCHAIN leg is neutralized per-file by a hoisted
 * `vi.mock('…/security/keychain.js')` (the factory can't reference an import, so it stays inline). This helper
 * neutralizes the other two:
 *   • ENV  — scrub every provider key the env tier reads.
 *   • FILE — point the keystore dataDir (`cfg.dataDir`, from WIGOLO_DATA_DIR) at a FRESH EMPTY temp dir, so
 *            `existsSync(encFilePath)` is false BY CONSTRUCTION (not "happens clean on this box").
 */

const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'WIGOLO_LLM_API_KEY',
  'WIGOLO_LLM_PROVIDER',
];

/** Scrub every provider key the env tier of resolveProviderKey reads. */
export function scrubProviderEnv(): void {
  for (const k of PROVIDER_ENV_KEYS) delete process.env[k];
}

/** Point the keystore dataDir at a fresh EMPTY temp dir (FILE leg absent-by-construction). Returns the dir
 *  so the caller can rmSync it in afterEach. */
export function emptyKeystoreDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wigolo-d11-noprovider-'));
  process.env.WIGOLO_DATA_DIR = dir;
  return dir;
}
