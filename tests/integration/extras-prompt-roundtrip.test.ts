/**
 * Integration test: interactive provider + key prompt (B4) round-trip.
 *
 * Mocks ONLY the human-input layer (@inquirer/prompts). The persistence stack
 * is real: promptExtras → saveInitConfig → writePersistedConfig (real disk) and
 * promptExtras → storeKey (real key-store, file fallback in the test env).
 *
 * Guards the security invariant: the chosen provider lands in config.json as
 * `llmProvider`, but the masked API key NEVER touches config.json — it is
 * routed to the provider keystore (keychain when available, encrypted file
 * otherwise).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
}));

import { select, input, password } from '@inquirer/prompts';

const selectMock = vi.mocked(select);
const inputMock = vi.mocked(input);
const passwordMock = vi.mocked(password);

describe('interactive provider+key round-trip (B4)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-b4-rt-'));
    process.env.WIGOLO_CONFIG_PATH = join(dir, 'config.json');
    process.env.WIGOLO_DATA_DIR = dir;
    selectMock.mockReset();
    inputMock.mockReset();
    passwordMock.mockReset();
    const { resetPersistedConfig } = await import('../../src/persisted-config.js');
    resetPersistedConfig();
  });

  afterEach(async () => {
    delete process.env.WIGOLO_CONFIG_PATH;
    delete process.env.WIGOLO_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
    const { resetPersistedConfig } = await import('../../src/persisted-config.js');
    resetPersistedConfig();
  });

  it('persists provider to config.json + key to the keystore, never the key to config.json', async () => {
    // engine skip, blank rss, blank endpoint, provider=anthropic, key supplied
    selectMock.mockResolvedValueOnce('skip');
    inputMock.mockResolvedValueOnce('');
    inputMock.mockResolvedValueOnce('');
    selectMock.mockResolvedValueOnce('anthropic');
    passwordMock.mockResolvedValueOnce('sk-b4-roundtrip-secret');

    const { promptExtras } = await import('../../src/cli/tui/extras-prompt.js');
    const result = await promptExtras(dir);
    expect(result.llmProvider).toBe('anthropic');

    // Provider on disk under the versioned envelope's settings map.
    const cfgRaw = readFileSync(join(dir, 'config.json'), 'utf-8');
    const cfg = JSON.parse(cfgRaw);
    expect(cfg.settings.llmProvider).toBe('anthropic');

    // The raw key string must NOT appear anywhere in config.json.
    expect(cfgRaw).not.toContain('sk-b4-roundtrip-secret');
    expect(cfg.settings.llmApiKey).toBeUndefined();

    // The key must be readable back from the real provider keystore.
    const { readKey } = await import('../../src/security/key-store.js');
    const stored = await readKey('anthropic', { dataDir: dir });
    expect(stored?.value).toBe('sk-b4-roundtrip-secret');
  });

  it('skipping the provider prompt writes no provider and stores no key', async () => {
    selectMock.mockResolvedValueOnce('skip'); // engine
    inputMock.mockResolvedValueOnce(''); // rss
    inputMock.mockResolvedValueOnce(''); // endpoint
    selectMock.mockResolvedValueOnce('skip'); // provider skip

    const { promptExtras } = await import('../../src/cli/tui/extras-prompt.js');
    const result = await promptExtras(dir);

    expect(result.llmProvider).toBeUndefined();
    expect(passwordMock).not.toHaveBeenCalled();

    const { readKey } = await import('../../src/security/key-store.js');
    expect(await readKey('anthropic', { dataDir: dir })).toBeNull();
  });
});
