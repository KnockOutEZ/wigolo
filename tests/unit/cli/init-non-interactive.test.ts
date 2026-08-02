import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  runWarmupMock, detectAgentsMock, selectAgentsMock, applyConfigsMock, runDoctorColdChecksMock,
  systemCheckMock, getAgentHandlerMock, probeSetupStatusMock, summarizeSetupMock,
  applyHeadlessSetMock, saveMock, createSettingsStoreMock, fakeStoreSetMock, storeKeyMock, configState,
  installSkillsMock,
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
    runDoctorColdChecksMock: vi.fn(() => []),
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
    installSkillsMock: vi.fn(() => ({ written: [], removed: [], refused: [], notices: [] })),
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
vi.mock('../../../src/cli/doctor.js', () => ({
  runDoctorColdChecks: runDoctorColdChecksMock,
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
vi.mock('../../../src/cli/agents/skills/index.js', () => ({
  installSkills: installSkillsMock,
  removeAllSkills: vi.fn(),
  SUPPORTED_AGENTS: ['claude-code', 'codex', 'cursor', 'gemini-cli', 'cline', 'windsurf'],
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
  runWarmupMock.mockReset().mockResolvedValue({ playwright: 'ok', searxng: 'skipped', embeddings: 'ok', reranker: 'ok' });
  detectAgentsMock.mockReset().mockReturnValue([
    { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file', configPath: '/h/.cursor/mcp.json' },
    { id: 'claude-code', displayName: 'Claude Code', detected: true, installType: 'cli-command', configPath: null },
  ]);
  selectAgentsMock.mockReset().mockResolvedValue([]);
  applyConfigsMock.mockReset().mockResolvedValue([
    { id: 'cursor', displayName: 'Cursor', ok: true, code: 'OK', configPath: '/h/.cursor/mcp.json' },
  ]);
  runDoctorColdChecksMock.mockReset().mockReturnValue([
    { name: 'browser', status: 'ok', fixable: true, detail: 'chromium launchable' },
    { name: 'data-dir', status: 'ok', fixable: false, detail: 'writable (/tmp/data)' },
  ]);
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
  installSkillsMock.mockReset().mockReturnValue({ written: [], removed: [], refused: [], notices: [] });
  // Ensure WIGOLO_LLM_API_KEY is unset by default so tests are isolated
  delete process.env.WIGOLO_LLM_API_KEY;
});

describe('runInit --non-interactive: skills engine wiring', () => {
  function captureOut(): { restore: () => void } {
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    return {
      restore: () => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
      },
    };
  }

  it('invokes the skills engine ONCE with the selected skills-capable agents at global scope', async () => {
    const cap = captureOut();
    try {
      await runInit(['--non-interactive', '--agents=cursor,claude-code', '--skip-verify']);
    } finally {
      cap.restore();
    }
    expect(installSkillsMock).toHaveBeenCalledTimes(1);
    const arg = installSkillsMock.mock.calls[0]?.[0] as { scope: string; agents: string[] };
    expect(arg.scope).toBe('global');
    // Both cursor and claude-code are engine-supported, so both are passed.
    expect(arg.agents.sort()).toEqual(['claude-code', 'cursor']);
  });

  it('filters non-skills-capable agents (vscode/zed) out of the engine call — no error', async () => {
    // vscode is a valid init agent but has no skills target; it must be dropped
    // before the engine call, leaving only the skills-capable selection.
    getAgentHandlerMock.mockReturnValue({
      id: 'vscode', displayName: 'VS Code',
      supportsSkills: false, supportsCommands: false,
      installInstructions: vi.fn().mockResolvedValue(undefined),
    });
    const cap = captureOut();
    let code: number;
    try {
      code = await runInit(['--non-interactive', '--agents=vscode,cursor', '--skip-verify']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(installSkillsMock).toHaveBeenCalledTimes(1);
    const arg = installSkillsMock.mock.calls[0]?.[0] as { agents: string[] };
    expect(arg.agents).toEqual(['cursor']);
  });

  it('does NOT invoke the engine when no selected agent is skills-capable', async () => {
    const cap = captureOut();
    try {
      await runInit(['--non-interactive', '--agents=vscode,zed', '--skip-verify']);
    } finally {
      cap.restore();
    }
    expect(installSkillsMock).not.toHaveBeenCalled();
  });

  it('summary line reflects the engine ApplyResult (files written), not a hardcoded count', async () => {
    installSkillsMock.mockReturnValue({
      written: ['/h/.claude/skills/wigolo/SKILL.md', '/h/.claude/skills/wigolo-search/SKILL.md'],
      removed: [], refused: [], notices: [],
    });
    const lines: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => { lines.push(String(c)); return true; }) as typeof process.stdout.write;
    try {
      await runInit(['--non-interactive', '--agents=cursor', '--skip-verify']);
    } finally {
      process.stdout.write = origOut;
    }
    const out = lines.join('');
    expect(out).toContain('2 files written');
    expect(out).not.toContain('8 skills');
  });
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
    // Fixture uses the agents-requested-but-failed case: since wave-2 S8 a
    // missing browser is 'lazy' (self-installs on first use) and can no longer
    // produce this state, but a requested agent that failed to register still does.
    summarizeSetupMock.mockReturnValueOnce({
      lines: ['Setup: 5/6 ready', '  ✗ agents(none) — no agent configured'],
      readyCount: 5,
      total: 6,
      requiredFailed: true,
      exitCode: 1,
    });

    const code = await runInit(['--non-interactive', '--agents=cursor', '--skip-verify']);
    expect(code).toBe(1);
  });

  it('runs doctor cold checks (not a live verify) after setup', async () => {
    // init replaced the live-network verify with doctor cold checks — presence
    // probes only, no download, no searxng spin. This runs on the default path.
    await runInit(['--non-interactive', '--agents=cursor']);
    expect(runDoctorColdChecksMock).toHaveBeenCalledTimes(1);
  });

  it('runs doctor cold checks even under --no-warmup (presence-only, no download)', async () => {
    await runInit(['--non-interactive', '--agents=cursor', '--no-warmup']);
    expect(runDoctorColdChecksMock).toHaveBeenCalledTimes(1);
    expect(runWarmupMock).not.toHaveBeenCalled();
  });

  it('returns 2 on unknown agent id', async () => {
    const code = await runInit(['--non-interactive', '--agents=not-real']);
    expect(code).toBe(2);
    expect(runWarmupMock).not.toHaveBeenCalled();
  });

  it('engine-only (no --agents) probes with agentsRequested:false; JSON status ok, exit 0', async () => {
    // Case (a): a non-interactive install with no --agents is engine-only mode.
    // init must tell the classifier NOT to require agents, and the honest
    // summary (mocked ok) yields exit 0 + status "ok".
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { writes.push(String(c)); return true; });
    let code: number;
    try {
      code = await runInit(['--non-interactive', '--skip-verify', '--json']);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);
    // The classifier was told agents were NOT requested.
    expect(probeSetupStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentsRequested: false }),
    );
    const parsed = JSON.parse(writes.join('').trim());
    expect(parsed.status).toBe('ok');
    expect(parsed.requiredFailed).toBe(false);
  });

  it('--agents given → probes with agentsRequested:true (guard stays active)', async () => {
    // Case (b) at the init seam: because --agents was given, init must keep the
    // failure guard active by passing agentsRequested:true to the classifier.
    await runInit(['--non-interactive', '--agents=cursor', '--skip-verify']);
    expect(probeSetupStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentsRequested: true }),
    );
  });

  it('json status agrees with exit code on the failure path (status error, exit 1)', async () => {
    // Case (d): when the classifier reports a required failure, the --json status
    // and the process exit code must both signal error — never disagree.
    summarizeSetupMock.mockReturnValueOnce({
      lines: ['Setup: 5/6 ready', '  ✗ agents(none) — no agent configured'],
      readyCount: 5,
      total: 6,
      requiredFailed: true,
      exitCode: 1,
    });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { writes.push(String(c)); return true; });
    let code: number;
    try {
      code = await runInit(['--non-interactive', '--agents=cursor', '--skip-verify', '--json']);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(1);
    const parsed = JSON.parse(writes.join('').trim());
    expect(parsed.status).toBe('error');
    // Agreement: a non-'ok' status must line up with a non-zero exit.
    expect(parsed.status === 'ok').toBe(code === 0);
  });

  it('--non-interactive --no-warmup with NO --agents sets up config only, no downloads (no gatekeeping)', async () => {
    // Marketing contract: wigolo works for ANY MCP-capable agent, so a user whose
    // agent has no built-in installer (e.g. Hermes) must still complete init
    // headlessly. --agents is optional: agent wiring is skipped, exit 0.
    // --no-warmup is the download-nothing escape hatch: runWarmup NEVER fires.
    const code = await runInit(['--non-interactive', '--no-warmup']);
    expect(code).toBe(0);
    expect(runWarmupMock).not.toHaveBeenCalled(); // --no-warmup: zero downloads
    expect(selectAgentsMock).not.toHaveBeenCalled(); // no interactive prompt
    expect(applyConfigsMock).not.toHaveBeenCalled(); // no agent wiring
  });

  it('--non-interactive (default) runs runWarmup(["--all"]) exactly once (full setup)', async () => {
    // Full setup is the default: even engine-only mode (no --agents) downloads
    // every component so setup failures surface loudly.
    const code = await runInit(['--non-interactive']);
    expect(code).toBe(0);
    expect(runWarmupMock).toHaveBeenCalledTimes(1);
    expect(runWarmupMock.mock.calls[0]?.[0]).toEqual(['--all', '--skip-verify']);
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
