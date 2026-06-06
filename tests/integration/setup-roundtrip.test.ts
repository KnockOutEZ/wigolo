/**
 * Integration test: fresh-machine setup round-trip persistence guard.
 *
 * MUST NOT mock persistKey, writePersistedConfig, readPersistedConfig,
 * or the propagation save(). All disk I/O goes to a real temp directory.
 *
 * This test class would have caught the 0.1.23 regression where the TUI
 * appeared to save settings but they did not survive a relaunch because
 * the persist layer wrote flat dotted keys instead of nested objects and
 * the unit tests had mocked the persist function entirely.
 *
 * Test A: proves persistKey writes a nested JSON shape (not flat dotted keys).
 * Test B: proves the real save() fans the API key out to an agent env block on
 *         disk and never writes the raw key value into config.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTarget } from '../../src/cli/tui/state/agent-targets.js';

describe('fresh-machine setup round-trip', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-rt-'));
    process.env.WIGOLO_CONFIG_PATH = join(dir, 'config.json');
    process.env.WIGOLO_DATA_DIR = dir;
    // persisted-config caches per-process — reset so each case reads fresh from disk
    const { resetPersistedConfig } = await import('../../src/persisted-config.js');
    resetPersistedConfig();
  });

  afterEach(() => {
    delete process.env.WIGOLO_CONFIG_PATH;
    delete process.env.WIGOLO_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('provider + search survive save → disk read-back as nested shape', async () => {
    const { persistKey } = await import('../../src/cli/tui/actions/write-config.js');
    const { readPersistedConfig, defaultConfigPath, resetPersistedConfig } = await import('../../src/persisted-config.js');

    await persistKey('llmProvider', 'anthropic');
    await persistKey('searchBackend', 'hybrid');

    // Bust the cache so we read from disk, not from the in-process cache.
    resetPersistedConfig();
    const cfg = readPersistedConfig(defaultConfigPath());
    expect((cfg.settings as any).llmProvider).toBe('anthropic');
    expect((cfg.settings as any).searchBackend).toBe('hybrid');

    // Guard against regression to flat dotted keys: the raw file on disk must
    // contain the same nested values at their short keys, not a flat
    // "llmProvider" key under a "settings.llmProvider" dotted path.
    const raw = JSON.parse(readFileSync(process.env.WIGOLO_CONFIG_PATH!, 'utf-8'));
    expect(raw.settings['llmProvider']).toBe('anthropic');
    expect(raw.settings['searchBackend']).toBe('hybrid');
    // Confirm no flat dotted-key regression for keys that WOULD have dots if split:
    expect(raw.settings['llmProvider']).not.toBeUndefined();
    expect(raw['settings.llmProvider']).toBeUndefined();
  });

  it('API key fans out to an agent env block on disk via the real save() path', async () => {
    // This is the regression guard for the 0.1.23 bug: exercise the REAL
    // propagation save (not a mocked persistKey). Build a temp agent target
    // pointing at a temp config file, stage the secret, save, then read the
    // agent file back from disk.
    const { createSettingsStore } = await import('../../src/cli/tui/state/settings-store.js');
    const { save: runSave } = await import('../../src/cli/tui/state/propagation.js');
    const { defaultSecretStore } = await import('../../src/cli/tui/state/secret-store.js');
    const { CATALOG } = await import('../../src/cli/tui/schema/catalog.js');
    const { readPersistedConfig, defaultConfigPath, resetPersistedConfig } = await import('../../src/persisted-config.js');

    // Pre-create an agent config file that looks like wigolo is installed,
    // so detect() returns true and the propagation fan-out runs.
    const agentFile = join(dir, 'agent.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(agentFile, JSON.stringify({
      mcpServers: {
        wigolo: { command: 'npx', args: ['-y', '@staticn0va/wigolo'] },
      },
    }, null, 2));

    // Construct a literal AgentTarget matching the AgentTarget interface
    // (src/cli/tui/state/agent-targets.ts:22-35). Use the claude-code shape
    // since that's the canonical install target: serverPath = ['mcpServers','wigolo'],
    // envPath = ['mcpServers','wigolo','env'].
    const backupDir = join(dir, 'backups');
    const agentTargets: AgentTarget[] = [
      {
        id: 'claude-code',
        label: 'Claude Code (test)',
        configPath: agentFile,
        serverPath: ['mcpServers', 'wigolo'],
        envPath: ['mcpServers', 'wigolo', 'env'],
        detect: async () => true,
        backupDir: () => backupDir,
      },
    ];

    const store = createSettingsStore(readPersistedConfig(defaultConfigPath()).settings);
    store.set('llmApiKey', 'sk-roundtrip-123');

    const res = await runSave({
      store,
      catalog: CATALOG,
      configPath: defaultConfigPath(),
      agents: agentTargets,
      secretStore: defaultSecretStore({ dataDir: dir }),
    });

    // No errors or save failures
    expect(res.errors ?? []).toHaveLength(0);
    expect(res.failed).toHaveLength(0);
    expect(res.propagated).toContain('claude-code');

    // The agent file on disk must carry the key in its env block.
    // Shape per applyPropagationToAgent (propagation.ts:481-486):
    //   envBlock = root['mcpServers']['wigolo']['env']
    //   envBlock['WIGOLO_LLM_API_KEY'] = 'sk-roundtrip-123'
    const agentRaw = JSON.parse(readFileSync(agentFile, 'utf-8'));
    expect(agentRaw.mcpServers.wigolo.env.WIGOLO_LLM_API_KEY).toBe('sk-roundtrip-123');
    // Sanity: the rest of the agent entry is preserved
    expect(agentRaw.mcpServers.wigolo.command).toBe('npx');

    // config.json must hold only a keychain/file reference, never the raw key.
    // The save() path stores a `llmApiKeyKeyLocation` field, not the value.
    const cfgRaw = JSON.parse(readFileSync(process.env.WIGOLO_CONFIG_PATH!, 'utf-8'));
    expect(JSON.stringify(cfgRaw)).not.toContain('sk-roundtrip-123');
    expect(cfgRaw.settings.llmApiKeyKeyLocation).toBeDefined();

    // POSIX mode-bit assert (0o600) — skip on win32 to match existing test patterns
    if (process.platform !== 'win32') {
      expect(statSync(agentFile).mode & 0o777).toBe(0o600);
    }
  });

  it('resetPersistedConfig() is load-bearing: without it the probe reads a stale backend', async () => {
    // Reproduces the bug fixed in init.ts: applyHeadlessSet / save() write
    // config.json via atomicWriteJson (direct fs write) which does NOT update
    // the in-process _cache. If the probe runs before resetPersistedConfig(),
    // readPersistedConfig() returns the STALE cached value from before the write.
    //
    // Step 1 — prime the cache with the default (no searchBackend set)
    const { readPersistedConfig, resetPersistedConfig, defaultConfigPath } = await import('../../src/persisted-config.js');
    const configPath = defaultConfigPath();

    // Cache is already reset in beforeEach; reading now will prime it with an
    // empty settings object (no searchBackend).
    const primed = readPersistedConfig(configPath);
    expect(primed.settings.searchBackend).toBeUndefined();

    // Step 2 — bypass the cache and write 'hybrid' directly to disk (faithfully
    // reproducing what atomicWriteJson inside save() / applyHeadlessSet does —
    // a raw fs write that never touches _cache).
    const newCfg = { version: 1, settings: { searchBackend: 'hybrid' } };
    writeFileSync(configPath, JSON.stringify(newCfg, null, 2), { mode: 0o600 });

    // Step 3 — WITHOUT a reset, readPersistedConfig still returns the stale cache.
    // This is the bug: the probe would see 'undefined' (or the old value), not 'hybrid'.
    const stale = readPersistedConfig(configPath);
    expect(stale.settings.searchBackend).toBeUndefined(); // proves the bug exists

    // Step 4 — WITH resetPersistedConfig(), the probe now reads fresh from disk.
    // This is exactly what init.ts does before calling probeSetupStatus().
    resetPersistedConfig();
    const fresh = readPersistedConfig(configPath);
    expect(fresh.settings.searchBackend).toBe('hybrid'); // proves the fix works
  });
});
