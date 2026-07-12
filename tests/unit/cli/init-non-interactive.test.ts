import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  runWarmupMock, detectAgentsMock, selectAgentsMock, applyConfigsMock, runVerifyMock,
  systemCheckMock, getAgentHandlerMock, probeSetupStatusMock, summarizeSetupMock,
  applyHeadlessSetMock, saveMock, createSettingsStoreMock, fakeStoreSetMock, storeKeyMock, configState,
} = vi.hoisted(() => {
  const fakeStoreSetMock = vi.fn();
  const fakeStore = {
    set: fakeStoreSetMock,
    getPending: vi.fn(() => ({})),
    isDirty: vi.fn(() => true),
    commit: vi.fn(),
    discard: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    commitOne: vi.fn().mockResolvedValue(undefined),
    blur: vi.fn().mockResolvedValue(undefined),
    getCurrent: vi.fn(() => ({})),
    dirtyKeys: vi.fn(() => []),
  };

  const createSettingsStoreMock = vi.fn(() => fakeStore);

  return {
    runWarmupMock: vi.fn(),
    detectAgentsMock: vi.fn(),
    selectAgentsMock: vi.fn(),
    applyConfigsMock: vi.fn(),
    runVerifyMock: vi.fn(),
    systemCheckMock: vi.fn(),
    getAgentHandlerMock: vi.fn(),
    probeSetupStatusMock: vi.fn(),
    summarizeSetupMock: vi.fn(),
    applyHeadlessSetMock: vi.fn(),
    saveMock: vi.fn(),
    createSettingsStoreMock,
    fakeStoreSetMock,
    storeKeyMock: vi.fn(),
    configState: { dataDir: '/tmp/data' },
  };
});

vi.mock('../../../src/cli/warmup.js', () => ({
  runWarmup: runWarmupMock,
}));
vi.mock('../../../src/cli/tui/agents.js', () => ({
  detectAgents: detectAgentsMock,
}));
vi.mock('../../../src/cli/tui/select-agents.js', () => ({
  selectAgents: selectAgentsMock,
  NotTtyError: class NotTtyError extends Error {
    constructor(msg?: string) { super(msg ?? 'not a TTY'); this.name = 'NotTtyError'; }
  },
}));
vi.mock('../../../src/cli/tui/config-writer.js', () => ({
  applyConfigs: applyConfigsMock,
}));
vi.mock('../../../src/cli/tui/verify.js', () => ({
  runVerify: runVerifyMock,
}));
vi.mock('../../../src/cli/tui/system-check.js', () => ({
  runSystemCheck: systemCheckMock,
}));
vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: configState.dataDir }),
}));
vi.mock('../../../src/cli/agents/registry.js', () => ({
  getAgentHandler: getAgentHandlerMock,
}));
vi.mock('../../../src/cli/tui/utils/config-writer.js', () => ({
  saveInitConfig: vi.fn(),
  readInitConfig: vi.fn(() => ({})),
}));
vi.mock('../../../src/cli/tui/actions/setup-status.js', () => ({
  probeSetupStatus: probeSetupStatusMock,
  defaultProbeDeps: () => ({}),
  summarizeSetup: summarizeSetupMock,
}));

vi.mock('../../../src/cli/tui/actions/index.js', () => ({
  applyHeadlessSet: applyHeadlessSetMock,
}));

vi.mock('../../../src/cli/tui/state/propagation.js', () => ({
  save: saveMock,
}));

vi.mock('../../../src/cli/tui/schema/catalog.js', () => ({
  CATALOG: [],
}));

vi.mock('../../../src/cli/tui/state/agent-targets.js', () => ({
  defaultAgentTargets: vi.fn(() => []),
}));

vi.mock('../../../src/cli/tui/state/secret-store.js', () => ({
  defaultSecretStore: vi.fn(() => ({})),
}));

vi.mock('../../../src/persisted-config.js', () => ({
  defaultConfigPath: vi.fn(() => '/tmp/test-config.json'),
  readPersistedConfig: vi.fn(() => ({ version: 1, settings: {} })),
  resetPersistedConfig: vi.fn(),
}));

vi.mock('../../../src/cli/tui/state/settings-store.js', () => ({
  createSettingsStore: createSettingsStoreMock,
}));

vi.mock('../../../src/security/key-store.js', () => ({
  storeKey: storeKeyMock,
}));

import { runInit } from '../../../src/cli/init.js';

beforeEach(() => {
  runWarmupMock.mockReset().mockResolvedValue(undefined);
  detectAgentsMock.mockReset().mockReturnValue([
    { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file', configPath: '/h/.cursor/mcp.json' },
    { id: 'claude-code', displayName: 'Claude Code', detected: true, installType: 'cli-command', configPath: null },
  ]);
  selectAgentsMock.mockReset().mockResolvedValue([]);
  applyConfigsMock.mockReset().mockResolvedValue([
    { id: 'cursor', displayName: 'Cursor', ok: true, code: 'OK', configPath: '/h/.cursor/mcp.json' },
  ]);
  runVerifyMock.mockReset().mockResolvedValue({ allPassed: true });
  systemCheckMock.mockReset().mockResolvedValue({
    node: { ok: true, version: '22.0.0' },
    python: { ok: true, binary: 'python3', version: '3.12.0' },
    docker: { ok: true, version: '29.0.0' },
    disk: { ok: true, freeMb: 50000 },
    hardFailure: false,
  });
  getAgentHandlerMock.mockReset().mockReturnValue({
    id: 'claude-code',
    displayName: 'Claude Code',
    supportsSkills: true,
    supportsCommands: true,
    installInstructions: vi.fn().mockResolvedValue(undefined),
    installSkills: vi.fn().mockResolvedValue(undefined),
    installCommand: vi.fn().mockResolvedValue(undefined),
  });
  probeSetupStatusMock.mockReset().mockResolvedValue([]);
  summarizeSetupMock.mockReset().mockReturnValue({
    lines: ['Setup: 6/6 ready'],
    readyCount: 6,
    total: 6,
    requiredFailed: false,
    exitCode: 0,
  });
  applyHeadlessSetMock.mockReset().mockResolvedValue({ status: 'ok', message: 'Set.', saved: [], propagated: [], failed: [] });
  saveMock.mockReset().mockResolvedValue({ saved: ['llmApiKey'], propagated: [], failed: [] });
  createSettingsStoreMock.mockClear();
  fakeStoreSetMock.mockClear();
  storeKeyMock.mockReset().mockResolvedValue({ location: 'keychain' });
  // Ensure WIGOLO_LLM_API_KEY is unset by default so tests are isolated
  delete process.env.WIGOLO_LLM_API_KEY;
});

describe('runInit --non-interactive', () => {
  it('skips selectAgents and calls applyConfigs with the flag ids', async () => {
    const code = await runInit(['--non-interactive', '--agents=cursor']);

    expect(code).toBe(0);
    expect(selectAgentsMock).not.toHaveBeenCalled();
    expect(applyConfigsMock).toHaveBeenCalledWith(
      expect.any(Array),
      ['cursor'],
      expect.any(Object),
    );
  });

  it('returns the honest non-zero exit code when a required component failed', async () => {
    // Honest-setup contract: when summarizeSetup reports a required component
    // failed (exitCode 1), runInitPlain must propagate that out of runInit —
    // it cannot silently return 0. Guards the failure path, not just success.
    summarizeSetupMock.mockReturnValueOnce({
      lines: ['Setup: 5/6 ready', '  ✗ browser — install failed'],
      readyCount: 5,
      total: 6,
      requiredFailed: true,
      exitCode: 1,
    });

    const code = await runInit(['--non-interactive', '--agents=cursor', '--skip-verify']);
    expect(code).toBe(1);
  });

  it('skips runVerify when --skip-verify is set', async () => {
    await runInit(['--non-interactive', '--agents=cursor', '--skip-verify']);
    expect(runVerifyMock).not.toHaveBeenCalled();
  });

  it('runs runVerify when --skip-verify is not set', async () => {
    await runInit(['--non-interactive', '--agents=cursor']);
    expect(runVerifyMock).toHaveBeenCalledTimes(1);
  });

  it('returns 2 on unknown agent id', async () => {
    const code = await runInit(['--non-interactive', '--agents=not-real']);
    expect(code).toBe(2);
    expect(runWarmupMock).not.toHaveBeenCalled();
  });

  it('--non-interactive with NO --agents sets up the engine only (no gatekeeping)', async () => {
    // Marketing contract: wigolo works for ANY MCP-capable agent, so a user whose
    // agent has no built-in installer (e.g. Hermes) must still install the engine
    // headlessly. --agents is optional: warmup runs, agent wiring is skipped, exit 0.
    const code = await runInit(['--non-interactive', '--skip-verify']);
    expect(code).toBe(0);
    expect(runWarmupMock).toHaveBeenCalledTimes(1); // engine setup still happens
    expect(selectAgentsMock).not.toHaveBeenCalled(); // no interactive prompt
    expect(applyConfigsMock).not.toHaveBeenCalled(); // no agent wiring
  });

  it('--non-interactive with no agents but --provider still persists the provider', async () => {
    // Engine-only install must not drop LLM configuration: a user can set up the
    // engine + their provider in one headless call, then wire their own agent.
    await runInit(['--non-interactive', '--skip-verify', '--provider=anthropic']);
    expect(applyConfigsMock).not.toHaveBeenCalled();
    expect(applyHeadlessSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'WIGOLO_LLM_PROVIDER', value: 'anthropic' }),
    );
  });

  it('returns 2 on unknown flag', async () => {
    const code = await runInit(['--bogus']);
    expect(code).toBe(2);
  });

  it('returns 0 and prints usage on --help', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runInit(['--help']);
    writeMock.mockRestore();
    expect(code).toBe(0);
    expect(runWarmupMock).not.toHaveBeenCalled();
  });

  it('reports a per-agent outcome for a newly-supported handler (Zed) — no silent skip', async () => {
    // Spec: install summary must report each configured agent + how (no silent
    // skips). Verify the new Zed handler surfaces "Configuring Zed..." and the
    // instructions-installed line in stdout when selected non-interactively.
    const dataDir = join(tmpdir(), `wigolo-init-zed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    configState.dataDir = dataDir;

    detectAgentsMock.mockReturnValue([
      { id: 'zed', displayName: 'Zed', detected: true, installType: 'config-file', configPath: '/h/.config/zed/settings.json' },
    ]);
    applyConfigsMock.mockResolvedValue([
      { id: 'zed', displayName: 'Zed', ok: true, code: 'OK', configPath: '/h/.config/zed/settings.json' },
    ]);
    const installInstructions = vi.fn().mockResolvedValue(undefined);
    getAgentHandlerMock.mockReturnValue({
      id: 'zed',
      displayName: 'Zed',
      supportsSkills: false,
      supportsCommands: false,
      installInstructions,
    });

    const stdoutWrites: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    try {
      const code = await runInit(['--non-interactive', '--agents=zed', '--skip-verify']);
      expect(code).toBe(0);
    } finally {
      writeSpy.mockRestore();
      configState.dataDir = '/tmp/data';
      rmSync(dataDir, { recursive: true, force: true });
    }

    expect(installInstructions).toHaveBeenCalledTimes(1);
    const out = stdoutWrites.join('');
    expect(out).toMatch(/Configuring Zed\.\.\./);
    expect(out).toMatch(/Global instructions updated/);
  });
});

describe('runInit --non-interactive provider/search/key persistence', () => {
  it('--provider=anthropic triggers applyHeadlessSet with WIGOLO_LLM_PROVIDER', async () => {
    await runInit(['--non-interactive', '--agents=cursor', '--skip-verify', '--provider=anthropic']);
    expect(applyHeadlessSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'WIGOLO_LLM_PROVIDER', value: 'anthropic' }),
    );
  });

  it('--search=hybrid triggers applyHeadlessSet with WIGOLO_SEARCH', async () => {
    await runInit(['--non-interactive', '--agents=cursor', '--skip-verify', '--search=hybrid']);
    expect(applyHeadlessSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'WIGOLO_SEARCH', value: 'hybrid' }),
    );
  });

  it('WIGOLO_LLM_API_KEY set triggers save() with llmApiKey staged in the store', async () => {
    process.env.WIGOLO_LLM_API_KEY = 'sk-test-persist-key';
    try {
      await runInit(['--non-interactive', '--agents=cursor', '--skip-verify', '--provider=anthropic']);
    } finally {
      delete process.env.WIGOLO_LLM_API_KEY;
    }
    // createSettingsStore must have been called to build the store for the key save
    expect(createSettingsStoreMock).toHaveBeenCalled();
    // store.set must stage 'llmApiKey' with the env value (settingsPath from schema/llm.ts)
    expect(fakeStoreSetMock).toHaveBeenCalledWith('llmApiKey', 'sk-test-persist-key');
    // save() must have been called (the secret-capable propagation path)
    expect(saveMock).toHaveBeenCalled();
  });

  it('persists the key under the provider keystore so the runtime resolver can read it', async () => {
    // Fix B: the TUI secret store (save()) writes to a namespace resolveProviderKey
    // never consults. The key must ALSO land in the provider keystore
    // (keychain `wigolo-<provider>` / encrypted file) keyed by the named provider,
    // or research/agent stays disabled after a cold headless install.
    process.env.WIGOLO_LLM_API_KEY = 'sk-runtime-key';
    try {
      await runInit(['--non-interactive', '--agents=cursor', '--skip-verify', '--provider=anthropic']);
    } finally {
      delete process.env.WIGOLO_LLM_API_KEY;
    }
    expect(storeKeyMock).toHaveBeenCalledWith(
      'anthropic',
      'sk-runtime-key',
      expect.objectContaining({ dataDir: configState.dataDir }),
    );
  });

  it('does NOT call the provider keystore when no env key is supplied', async () => {
    await runInit(['--non-interactive', '--agents=cursor', '--skip-verify', '--provider=anthropic']);
    expect(storeKeyMock).not.toHaveBeenCalled();
  });

  it('--provider without WIGOLO_LLM_API_KEY does NOT call save()', async () => {
    // Env key is absent (deleted in beforeEach); provider is set
    await runInit(['--non-interactive', '--agents=cursor', '--skip-verify', '--provider=openai']);
    expect(applyHeadlessSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'WIGOLO_LLM_PROVIDER', value: 'openai' }),
    );
    // save() should not be called because WIGOLO_LLM_API_KEY is absent
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('neither provider nor search nor env key → applyHeadlessSet and save not called', async () => {
    await runInit(['--non-interactive', '--agents=cursor', '--skip-verify']);
    expect(applyHeadlessSetMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });
});
