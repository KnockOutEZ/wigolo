/**
 * `accountsUrl` resolution and the sentinel default (A-212-4).
 *
 * The sentinel is not decoration. `accounts.invalid` is an RFC 2606 reserved
 * TLD, so it can never resolve, and the suite's net fence records any connect
 * to a non-loopback host. Together that means a test which forgets to point
 * `WIGOLO_ACCOUNTS_URL` at a locally-run instance goes RED instead of quietly
 * measuring whatever a real hostname would have answered — which is the
 * mechanism that makes "every RC test sets the env explicitly" enforced rather
 * than a convention someone has to remember.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, resetConfig } from '../../../src/config.js';
import { resetPersistedConfig, PERSISTED_CONFIG_VERSION } from '../../../src/persisted-config.js';
import { PRODUCTION_ACCOUNTS_URL } from '../../../src/account/constants.js';
import { advancedCategory } from '../../../src/cli/tui/schema/advanced.js';
import { migrateV1ToV2 } from '../../../src/cli/tui/schema/migrate.js';

let dir: string;
let savedEnv: string | undefined;
let savedConfigPath: string | undefined;

beforeEach(() => {
  savedEnv = process.env.WIGOLO_ACCOUNTS_URL;
  savedConfigPath = process.env.WIGOLO_CONFIG_PATH;
  delete process.env.WIGOLO_ACCOUNTS_URL;
  dir = mkdtempSync(join(tmpdir(), 'wigolo-accounts-url-'));
  process.env.WIGOLO_CONFIG_PATH = join(dir, 'config.json');
  resetPersistedConfig();
  resetConfig();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.WIGOLO_ACCOUNTS_URL;
  else process.env.WIGOLO_ACCOUNTS_URL = savedEnv;
  if (savedConfigPath === undefined) delete process.env.WIGOLO_CONFIG_PATH;
  else process.env.WIGOLO_CONFIG_PATH = savedConfigPath;
  rmSync(dir, { recursive: true, force: true });
  resetPersistedConfig();
  resetConfig();
});

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(process.env.WIGOLO_CONFIG_PATH!, JSON.stringify({ version: PERSISTED_CONFIG_VERSION, settings }), 'utf8');
  resetPersistedConfig();
  resetConfig();
}

describe('config.accountsUrl', () => {
  it('defaults to the non-resolving sentinel when nothing is configured', () => {
    expect(getConfig().accountsUrl).toBe(PRODUCTION_ACCOUNTS_URL);
    expect(PRODUCTION_ACCOUNTS_URL).toBe('https://accounts.invalid');
    // `.invalid` is the RFC 2606 reserved TLD — the property the fence relies on.
    expect(new URL(PRODUCTION_ACCOUNTS_URL).hostname.endsWith('.invalid')).toBe(true);
    // …and it is emphatically not loopback, which the fence lets through.
    expect(['127.0.0.1', 'localhost', '::1']).not.toContain(new URL(PRODUCTION_ACCOUNTS_URL).hostname);
  });

  it('reads the persisted accountsUrl setting', () => {
    writeSettings({ accountsUrl: 'http://127.0.0.1:8787' });
    expect(getConfig().accountsUrl).toBe('http://127.0.0.1:8787');
  });

  it('lets the env override the persisted setting', () => {
    writeSettings({ accountsUrl: 'http://127.0.0.1:8787' });
    process.env.WIGOLO_ACCOUNTS_URL = 'http://127.0.0.1:9999';
    resetConfig();
    expect(getConfig().accountsUrl).toBe('http://127.0.0.1:9999');
  });
});

describe('config --set plumbing', () => {
  it('the catalog carries WIGOLO_ACCOUNTS_URL mapped to accountsUrl', () => {
    const field = advancedCategory.fields.find((f) => f.key === 'WIGOLO_ACCOUNTS_URL');
    expect(field).toBeDefined();
    expect(field!.settingsPath).toBe('accountsUrl');
    expect(field!.kind).toBe('text');
    // Capability language: no vendor or protocol name in user-facing copy.
    expect(field!.label.toLowerCase()).not.toMatch(/fastify|postgres|jwt/);
  });

  it('a v1 config keyed by the env name migrates to the accountsUrl setting', () => {
    const out = migrateV1ToV2({
      version: 1,
      settings: { WIGOLO_ACCOUNTS_URL: 'http://127.0.0.1:8787' },
    });
    expect(out.settings['accountsUrl']).toBe('http://127.0.0.1:8787');
    // Not stranded under __legacy, which is where an unmapped key lands.
    expect(out.settings['__legacy']).toBeUndefined();
  });

  it('a v1 config already keyed by the settings name survives the migration', () => {
    const out = migrateV1ToV2({ version: 1, settings: { accountsUrl: 'http://127.0.0.1:8787' } });
    expect(out.settings['accountsUrl']).toBe('http://127.0.0.1:8787');
    expect(out.settings['__legacy']).toBeUndefined();
  });
});
