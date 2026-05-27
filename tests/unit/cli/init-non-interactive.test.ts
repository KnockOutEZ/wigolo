import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { runWarmupMock, detectAgentsMock, selectAgentsMock, applyConfigsMock, runVerifyMock, systemCheckMock, getAgentHandlerMock, configState } = vi.hoisted(() => ({
  runWarmupMock: vi.fn(),
  detectAgentsMock: vi.fn(),
  selectAgentsMock: vi.fn(),
  applyConfigsMock: vi.fn(),
  runVerifyMock: vi.fn(),
  systemCheckMock: vi.fn(),
  getAgentHandlerMock: vi.fn(),
  configState: { dataDir: '/tmp/data' },
}));

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

  beforeEach(() => {
    tmpHome = join(tmpdir(), `wigolo-init-fc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
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
