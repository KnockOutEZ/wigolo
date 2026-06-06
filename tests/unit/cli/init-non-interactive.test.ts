import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  runWarmupMock, detectAgentsMock, selectAgentsMock, applyConfigsMock, runVerifyMock,
  systemCheckMock, getAgentHandlerMock, probeSetupStatusMock, summarizeSetupMock,
  applyHeadlessSetMock, saveMock, createSettingsStoreMock, fakeStoreSetMock, configState,
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

describe('runInit --non-interactive firecrawl-collision notice', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalHomeDrive: string | undefined;
  let originalHomePath: string | undefined;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `wigolo-init-fc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
    // os.homedir() reads HOME on POSIX and USERPROFILE (or HOMEDRIVE+HOMEPATH)
    // on Windows. Override all of them so the test points at tmpHome on every
    // platform.
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalHomeDrive = process.env.HOMEDRIVE;
    originalHomePath = process.env.HOMEPATH;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;
    detectAgentsMock.mockReturnValue([
      { id: 'claude-code', displayName: 'Claude Code', detected: true, installType: 'cli-command', configPath: null },
    ]);
    applyConfigsMock.mockResolvedValue([
      { id: 'claude-code', displayName: 'Claude Code', ok: true, code: 'OK', configPath: null },
    ]);
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalHomeDrive === undefined) delete process.env.HOMEDRIVE;
    else process.env.HOMEDRIVE = originalHomeDrive;
    if (originalHomePath === undefined) delete process.env.HOMEPATH;
    else process.env.HOMEPATH = originalHomePath;
  });

  it('prints a notice when firecrawl skills are present in the host skills dir', async () => {
    mkdirSync(join(tmpHome, '.claude', 'skills', 'firecrawl-search'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude', 'skills', 'firecrawl-search', 'SKILL.md'), 'stub', 'utf-8');

    const stdoutWrites: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    try {
      await runInit(['--non-interactive', '--agents=claude-code', '--skip-verify']);
    } finally {
      writeSpy.mockRestore();
    }

    const out = stdoutWrites.join('');
    expect(out).toMatch(/Detected firecrawl skills/);
    expect(out).toMatch(/firecrawl-search/);
  });

  it('does not print the notice when no firecrawl skills exist', async () => {
    mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });

    const stdoutWrites: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    try {
      await runInit(['--non-interactive', '--agents=claude-code', '--skip-verify']);
    } finally {
      writeSpy.mockRestore();
    }

    const out = stdoutWrites.join('');
    expect(out).not.toMatch(/Detected firecrawl skills/);
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
