import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  runSystemCheckMock,
  renderBannerMock,
  getPackageVersionMock,
  runWarmupMock,
  detectAgentsMock,
  selectAgentsMock,
  applyConfigsMock,
  runDoctorColdChecksMock,
  probeSetupStatusMock,
  summarizeSetupMock,
  runConfigMock,
  wasUninstalledMock,
  saveInitConfigMock,
  installSkillsMock,
  readInitConfigMock,
  promptExtrasMock,
} = vi.hoisted(() => ({
  runSystemCheckMock: vi.fn(),
  renderBannerMock: vi.fn(() => 'BANNER\n'),
  getPackageVersionMock: vi.fn(() => '0.6.3'),
  runWarmupMock: vi.fn(),
  detectAgentsMock: vi.fn(),
  selectAgentsMock: vi.fn(),
  applyConfigsMock: vi.fn(),
  runDoctorColdChecksMock: vi.fn(() => []),
  probeSetupStatusMock: vi.fn(),
  summarizeSetupMock: vi.fn(),
  runConfigMock: vi.fn(),
  wasUninstalledMock: vi.fn(() => false),
  saveInitConfigMock: vi.fn(),
  installSkillsMock: vi.fn(() => ({ written: [], removed: [], refused: [], notices: [] })),
  readInitConfigMock: vi.fn(() => ({})),
  promptExtrasMock: vi.fn(async () => ({})),
}));

vi.mock('../../../src/cli/tui/system-check.js', () => ({
  runSystemCheck: runSystemCheckMock,
}));
vi.mock('../../../src/cli/tui/banner.js', () => ({
  renderBanner: renderBannerMock,
  printAddMcpBanner: vi.fn(),
}));
vi.mock('../../../src/cli/tui/version.js', () => ({
  getPackageVersion: getPackageVersionMock,
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
vi.mock('../../../src/cli/doctor.js', () => ({
  runDoctorColdChecks: runDoctorColdChecksMock,
}));
vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/data' }),
}));
vi.mock('../../../src/cli/tui/utils/config-writer.js', () => ({
  saveInitConfig: saveInitConfigMock,
  readInitConfig: readInitConfigMock,
}));
vi.mock('../../../src/cli/agents/skills/index.js', () => ({
  installSkills: installSkillsMock,
  removeAllSkills: vi.fn(),
  SUPPORTED_AGENTS: ['claude-code', 'codex', 'cursor', 'gemini-cli', 'cline', 'windsurf'],
}));
vi.mock('../../../src/cli/tui/actions/setup-status.js', () => ({
  probeSetupStatus: probeSetupStatusMock,
  defaultProbeDeps: () => ({}),
  summarizeSetup: summarizeSetupMock,
}));
vi.mock('../../../src/cli/config.js', () => ({
  runConfig: runConfigMock,
}));
vi.mock('../../../src/cli/tui/state/uninstall-signal.js', () => ({
  wasUninstalled: wasUninstalledMock,
}));
vi.mock('../../../src/cli/tui/extras-prompt.js', () => ({
  promptExtras: promptExtrasMock,
}));
vi.mock('../../../src/cli/tui/reporter-auto.js', () => ({
  autoReporter: vi.fn(() => ({
    start: vi.fn(),
    success: vi.fn(),
    fail: vi.fn(),
    note: vi.fn(),
  })),
}));

import { runInit } from '../../../src/cli/init.js';

function capture(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as any) = (chunk: any) => { stdout.push(String(chunk)); return true; };
  (process.stderr.write as any) = (chunk: any) => { stderr.push(String(chunk)); return true; };
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origOut as any;
      process.stderr.write = origErr as any;
    },
  };
}

function primeHappyPath(): void {
  runSystemCheckMock.mockResolvedValue({
    node: { ok: true, version: '22.14.0' },
    python: { ok: true, binary: 'python3', version: '3.12.5' },
    docker: { ok: true, version: '29.4.0' },
    disk: { ok: true, freeMb: 50000 },
    hardFailure: false,
  });
  // A full setup resolves a WarmupResult with every component ready (default
  // path downloads browser + embeddings + reranker).
  runWarmupMock.mockResolvedValue({ playwright: 'ok', searxng: 'skipped', embeddings: 'ok', reranker: 'ok' });
  detectAgentsMock.mockReturnValue([
    { id: 'cursor', displayName: 'Cursor', detected: true, installType: 'config-file', configPath: '/h/.cursor/mcp.json' },
  ]);
  selectAgentsMock.mockResolvedValue([]);
  applyConfigsMock.mockResolvedValue([]);
  runDoctorColdChecksMock.mockReturnValue([
    { name: 'browser', status: 'ok', fixable: true, detail: 'chromium launchable' },
    { name: 'embeddings', status: 'ok', fixable: true, detail: 'model cached' },
    { name: 'data-dir', status: 'ok', fixable: false, detail: 'writable (/tmp/data)' },
  ]);
  probeSetupStatusMock.mockResolvedValue([]);
  summarizeSetupMock.mockReturnValue({
    lines: ['Setup: 6/6 ready'],
    readyCount: 6,
    total: 6,
    requiredFailed: false,
    exitCode: 0,
  });
}

describe('runInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderBannerMock.mockReturnValue('BANNER\n');
    getPackageVersionMock.mockReturnValue('0.6.3');
    installSkillsMock.mockReturnValue({ written: [], removed: [], refused: [], notices: [] });
    readInitConfigMock.mockReturnValue({});
    promptExtrasMock.mockResolvedValue({});
    runDoctorColdChecksMock.mockReturnValue([
      { name: 'browser', status: 'ok', fixable: true, detail: 'chromium launchable' },
      { name: 'data-dir', status: 'ok', fixable: false, detail: 'writable (/tmp/data)' },
    ]);
    probeSetupStatusMock.mockResolvedValue([]);
    summarizeSetupMock.mockReturnValue({
      lines: ['Setup: 6/6 ready'],
      readyCount: 6,
      total: 6,
      requiredFailed: false,
      exitCode: 0,
    });
  });

  it('exits 0 on all-ok system (non-interactive path)', async () => {
    primeHappyPath();
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toContain('BANNER');
      expect(out).toContain('Node');
      expect(out).toContain('22.14.0');
      expect(out).toContain('Python');
      expect(out).toContain('3.12.5');
      expect(out).toContain('Docker');
    } finally {
      cap.restore();
    }
  });

  it('exits 1 and reports no registered agents in JSON when a config result fails', async () => {
    primeHappyPath();
    applyConfigsMock.mockResolvedValue([{
      id: 'opencode',
      displayName: 'OpenCode',
      configPath: '/home/test/.config/opencode/opencode.json',
      ok: false,
      code: 'PARSE_ERROR',
      message: 'legacy OpenCode config migration failed: invalid JSONC',
    }]);
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=opencode', '--json']);
      expect(code).toBe(1);
      expect(cap.stderr.join('')).toContain('Writing OpenCode config failed');
      expect(cap.stderr.join('')).toContain('legacy OpenCode config migration failed');
      const summary = JSON.parse(cap.stdout.join('').trim());
      expect(summary.status).toBe('error');
      expect(summary.agentsRegistered).toEqual([]);
      expect(saveInitConfigMock).not.toHaveBeenCalled();
      expect(installSkillsMock).not.toHaveBeenCalled();
    } finally {
      cap.restore();
    }
  });

  it('keeps earlier successful agents in JSON when a later config fails', async () => {
    primeHappyPath();
    applyConfigsMock.mockResolvedValue([
      {
        id: 'cursor',
        displayName: 'Cursor',
        configPath: '/home/test/.cursor/mcp.json',
        ok: true,
        code: 'OK',
      },
      {
        id: 'opencode',
        displayName: 'OpenCode',
        configPath: '/home/test/.config/opencode/opencode.json',
        ok: false,
        code: 'UNEXPECTED_ERROR',
        message: 'writer exploded',
      },
    ]);
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor,opencode', '--json']);
      expect(code).toBe(1);
      const summary = JSON.parse(cap.stdout.join('').trim());
      expect(summary.status).toBe('error');
      expect(summary.agentsRegistered).toEqual(['cursor']);
      expect(saveInitConfigMock).not.toHaveBeenCalled();
    } finally {
      cap.restore();
    }
  });

  it('does not claim global instructions were updated for MCP-only OpenCode', async () => {
    primeHappyPath();
    applyConfigsMock.mockResolvedValue([{
      id: 'opencode',
      displayName: 'OpenCode',
      configPath: '/home/test/.config/opencode/opencode.json',
      ok: true,
      code: 'OK',
    }]);
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=opencode', '--no-warmup']);
      expect(code).toBe(0);
      const output = cap.stdout.join('') + cap.stderr.join('');
      expect(output).not.toContain('Global instructions updated');
      expect(output).toContain('MCP configuration updated');
    } finally {
      cap.restore();
    }
  });

  it('exits 1 when Node is too old', async () => {
    runSystemCheckMock.mockResolvedValue({
      node: { ok: false, version: '18.0.0', message: 'requires Node 20+' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: false },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: true,
    });
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(1);
      const out = cap.stdout.join('');
      expect(out).toMatch(/requires Node 20/i);
    } finally {
      cap.restore();
    }
  });

  it('warns but exits 0 when only Python 3 is missing (optional — search-engine sidecar)', async () => {
    // WHY: Python powers only the opt-in search-engine sidecar; the default core
    // install needs none. Missing Python must NOT abort init — it used to print
    // "Setup cannot continue" and return 1, blocking Python-less machines.
    primeHappyPath();
    runSystemCheckMock.mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: false, message: 'Python 3 not found.' },
      docker: { ok: false },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: false,
    });
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      // The Python line itself must read as optional and name the sidecar — not
      // the old scary "install Python to continue" blocker hint.
      expect(out).toMatch(/search engine sidecar/i);
      expect(out).not.toMatch(/python\.org|brew install/i);
    } finally {
      cap.restore();
    }
  });

  it('warns but exits 0 when Docker is missing (optional)', async () => {
    primeHappyPath();
    runSystemCheckMock.mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: false },
      disk: { ok: true, freeMb: 50000 },
      hardFailure: false,
    });
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toMatch(/docker.*optional|optional.*docker/i);
    } finally {
      cap.restore();
    }
  });

  it('warns but exits 0 when disk space is low', async () => {
    primeHappyPath();
    runSystemCheckMock.mockResolvedValue({
      node: { ok: true, version: '22.14.0' },
      python: { ok: true, binary: 'python3', version: '3.12.5' },
      docker: { ok: true, version: '29.4.0' },
      disk: { ok: false, freeMb: 200, message: 'only 200 MB free' },
      hardFailure: false,
    });
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toMatch(/200 MB|disk/i);
    } finally {
      cap.restore();
    }
  });

  it('writes banner to stdout not stderr', async () => {
    primeHappyPath();
    const cap = capture();
    try {
      await runInit(['--non-interactive', '--agents=cursor']);
      expect(cap.stdout.join('')).toContain('BANNER');
      expect(cap.stderr.join('')).not.toContain('BANNER');
    } finally {
      cap.restore();
    }
  });

  it('returns 2 on unknown flag', async () => {
    const cap = capture();
    try {
      const code = await runInit(['--some-future-flag', 'value']);
      expect(code).toBe(2);
      expect(cap.stderr.join('')).toContain('--some-future-flag');
    } finally {
      cap.restore();
    }
  });

  it('non-interactive path runs the full setup (runWarmup(["--all"])) by DEFAULT', async () => {
    // Full setup is the default: a manual init downloads every component so
    // setup failures surface loudly. runWarmup(['--all']) is the single gate
    // that pulls browser + embeddings + reranker. The interactive delegate must
    // NOT be reached on the non-interactive path.
    primeHappyPath();
    const cap = capture();
    try {
      await runInit(['--non-interactive', '--agents=cursor']);
      expect(runWarmupMock).toHaveBeenCalledTimes(1);
      expect(runWarmupMock.mock.calls[0]?.[0]).toEqual(['--all', '--skip-verify']);
      expect(runConfigMock).not.toHaveBeenCalled();
    } finally {
      cap.restore();
    }
  });

  it('non-interactive path runs doctor cold checks after setup and exits 0', async () => {
    primeHappyPath();
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(0);
      expect(runDoctorColdChecksMock).toHaveBeenCalledTimes(1);
    } finally {
      cap.restore();
    }
  });

  it('non-interactive path with --no-warmup runs NO warmup and does NOT invoke doctor download probes', async () => {
    // --no-warmup is the download-nothing escape hatch. runWarmup is the single
    // installer gate; not calling it proves zero model/browser bytes are
    // written. Doctor cold checks still run (presence-only, no download).
    primeHappyPath();
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor', '--no-warmup']);
      expect(code).toBe(0);
      expect(runWarmupMock).not.toHaveBeenCalled();
      expect(runConfigMock).not.toHaveBeenCalled();
    } finally {
      cap.restore();
    }
  });

  it('--warmup is an explicit-on alias — still runs the full setup once', async () => {
    primeHappyPath();
    const cap = capture();
    try {
      await runInit(['--non-interactive', '--agents=cursor', '--warmup']);
      expect(runWarmupMock).toHaveBeenCalledTimes(1);
      expect(runWarmupMock.mock.calls[0]?.[0]).toEqual(['--all', '--skip-verify']);
    } finally {
      cap.restore();
    }
  });

  it('--no-warmup prints the components-on-first-use hint', async () => {
    // The download-nothing path tells the user how to pre-cache later.
    primeHappyPath();
    const cap = capture();
    try {
      await runInit(['--non-interactive', '--agents=cursor', '--no-warmup']);
      const all = cap.stdout.join('') + cap.stderr.join('');
      expect(all).toMatch(/components download on first use/i);
      expect(all).toMatch(/wigolo warmup --all/);
    } finally {
      cap.restore();
    }
  });

  it('component-download failure still wires the agent, persists config, and exits 0', async () => {
    // Exit 0 even on component-download failure: log the failure with the fix,
    // still register the agent + persist config. The component lazy-retries.
    primeHappyPath();
    runWarmupMock.mockResolvedValue({
      playwright: 'failed', playwrightError: 'network blocked',
      searxng: 'skipped', embeddings: 'ok', reranker: 'ok',
    });
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(0);
      // Agent wiring + config persist still happened.
      expect(applyConfigsMock).toHaveBeenCalledTimes(1);
      expect(saveInitConfigMock).toHaveBeenCalledTimes(1);
      // The degraded report names the component and its fix.
      const all = cap.stdout.join('') + cap.stderr.join('');
      expect(all).toMatch(/Browser engine: failed/i);
      expect(all).toMatch(/network blocked/);
      expect(all).toMatch(/Fix:/);
    } finally {
      cap.restore();
    }
  });

  it('a thrown warmup (not a per-component failure) is swallowed — init still exits 0', async () => {
    primeHappyPath();
    runWarmupMock.mockRejectedValue(new Error('disk read-only'));
    const cap = capture();
    try {
      const code = await runInit(['--non-interactive', '--agents=cursor']);
      expect(code).toBe(0);
      expect(applyConfigsMock).toHaveBeenCalledTimes(1);
      const all = cap.stdout.join('') + cap.stderr.join('');
      expect(all).toMatch(/Component setup failed: disk read-only/);
    } finally {
      cap.restore();
    }
  });

  describe('--json (machine-readable summary)', () => {
    it('emits a single JSON object on stdout that parses; human report goes to stderr', async () => {
      primeHappyPath();
      const cap = capture();
      try {
        const code = await runInit(['--non-interactive', '--agents=cursor', '--json']);
        expect(code).toBe(0);
        // The ENTIRE stdout must parse as JSON — no banner / report lines mixed in.
        const parsed = JSON.parse(cap.stdout.join('').trim());
        expect(parsed.status).toBe('ok');
        expect(parsed.path).toBe('plain');
        // Full setup is the default → warmup ran.
        expect(parsed.warmup).toBe(true);
        expect(Array.isArray(parsed.agentsRegistered)).toBe(true);
        expect(parsed.agentsRegistered).toEqual(['cursor']);
        expect(parsed.configPersisted).toBe(true);
        // Human report (banner) must NOT pollute stdout under --json.
        expect(cap.stdout.join('')).not.toContain('BANNER');
        expect(cap.stderr.join('')).toContain('BANNER');
      } finally {
        cap.restore();
      }
    });

    it('--json carries per-component status (capability-language keys) + doctor + agents/config', async () => {
      primeHappyPath();
      runWarmupMock.mockResolvedValue({
        playwright: 'ok', searxng: 'skipped', embeddings: 'ok', reranker: 'failed', rerankerError: 'download 503',
      });
      const cap = capture();
      try {
        await runInit(['--non-interactive', '--agents=cursor', '--json']);
        const parsed = JSON.parse(cap.stdout.join('').trim());
        // Capability-language keys — NOT playwright/searxng.
        expect(parsed.components.browserEngine).toBe('ready');
        expect(parsed.components.embeddings).toBe('ready');
        expect(parsed.components.reranker).toBe('failed');
        expect(parsed.components.rerankerError).toBe('download 503');
        expect(parsed).not.toHaveProperty('playwright');
        // Doctor cold-check results are included.
        expect(Array.isArray(parsed.doctor)).toBe(true);
        expect(parsed.doctor.length).toBeGreaterThan(0);
        expect(parsed.agentsRegistered).toEqual(['cursor']);
        expect(parsed.configPersisted).toBe(true);
      } finally {
        cap.restore();
      }
    });

    it('--no-warmup --json marks every component skipped (lazy) and exits 0', async () => {
      primeHappyPath();
      const cap = capture();
      try {
        const code = await runInit(['--non-interactive', '--agents=cursor', '--no-warmup', '--json']);
        expect(code).toBe(0);
        const parsed = JSON.parse(cap.stdout.join('').trim());
        expect(parsed.warmup).toBe(false);
        expect(parsed.components.browserEngine).toBe('skipped');
        expect(parsed.components.embeddings).toBe('skipped');
        expect(parsed.components.reranker).toBe('skipped');
      } finally {
        cap.restore();
      }
    });

    it('--json still exits 0 (status ok) even when a component download failed', async () => {
      primeHappyPath();
      runWarmupMock.mockResolvedValue({
        playwright: 'failed', playwrightError: 'blocked', searxng: 'skipped', embeddings: 'ok', reranker: 'ok',
      });
      const cap = capture();
      try {
        const code = await runInit(['--non-interactive', '--agents=cursor', '--json']);
        expect(code).toBe(0);
        const parsed = JSON.parse(cap.stdout.join('').trim());
        expect(parsed.status).toBe('ok');
        expect(parsed.components.browserEngine).toBe('failed');
        expect(parsed.components.browserEngineError).toBe('blocked');
      } finally {
        cap.restore();
      }
    });
  });

  describe('full setup on BOTH init paths by default; --no-warmup skips downloads', () => {
    let prevTTY: boolean | undefined;
    let prevCI: string | undefined;
    let prevGha: string | undefined;

    beforeEach(() => {
      prevTTY = process.stdout.isTTY;
      prevCI = process.env.CI;
      prevGha = process.env.GITHUB_ACTIONS;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;
      runConfigMock.mockResolvedValue(0);
      runWarmupMock.mockResolvedValue({ playwright: 'ok', searxng: 'skipped', embeddings: 'ok', reranker: 'ok' });
      wasUninstalledMock.mockReturnValue(false);
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
      if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
      if (prevGha === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prevGha;
    });

    // MEMORY TRAP (binding): every behavior change is verified on BOTH init paths.
    // runWarmup(['--all']) is the single gate that invokes the browser / embedding
    // / reranker installers — so runWarmup CALLED with ['--all'] proves the full
    // setup fires on that path; NOT-called under --no-warmup proves zero bytes.
    it('plain (non-interactive) default: runWarmup(["--all"]) — the installer gate — fires', async () => {
      primeHappyPath();
      const cap = capture();
      try {
        await runInit(['--non-interactive', '--agents=cursor']);
        expect(runWarmupMock).toHaveBeenCalledTimes(1);
        expect(runWarmupMock.mock.calls[0]?.[0]).toEqual(['--all', '--skip-verify']);
      } finally {
        cap.restore();
      }
    });

    it('plain default on a bare TTY: runWarmup(["--all"]) fires', async () => {
      primeHappyPath();
      selectAgentsMock.mockResolvedValue([]);
      const cap = capture();
      try {
        await runInit([]);
        expect(runWarmupMock).toHaveBeenCalledTimes(1);
        expect(runWarmupMock.mock.calls[0]?.[0]).toEqual(['--all', '--skip-verify']);
      } finally {
        cap.restore();
      }
    });

    it('plain --no-warmup: runWarmup — the installer gate — is NEVER called (zero bytes)', async () => {
      primeHappyPath();
      const cap = capture();
      try {
        await runInit(['--non-interactive', '--agents=cursor', '--no-warmup']);
        expect(runWarmupMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });

    it('--wizard default: runWarmup(["--all"]) fires after the wizard unmounts', async () => {
      const cap = capture();
      try {
        await runInit(['--wizard']);
        expect(runWarmupMock).toHaveBeenCalledTimes(1);
        expect(runWarmupMock.mock.calls[0]?.[0]).toEqual(['--all', '--skip-verify']);
      } finally {
        cap.restore();
      }
    });

    it('--wizard --no-warmup: runWarmup is NEVER called (zero bytes)', async () => {
      const cap = capture();
      try {
        await runInit(['--wizard', '--no-warmup']);
        expect(runWarmupMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });

    it('--wizard default runs doctor cold checks after setup and exits 0', async () => {
      const cap = capture();
      try {
        const code = await runInit(['--wizard']);
        expect(code).toBe(0);
        expect(runDoctorColdChecksMock).toHaveBeenCalledTimes(1);
      } finally {
        cap.restore();
      }
    });
  });

  describe('--wizard mounts the Ink entry; default TTY does not', () => {
    let prevTTY: boolean | undefined;
    let prevCI: string | undefined;
    let prevGha: string | undefined;

    beforeEach(() => {
      prevTTY = process.stdout.isTTY;
      prevCI = process.env.CI;
      prevGha = process.env.GITHUB_ACTIONS;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;
      runConfigMock.mockResolvedValue(0);
      runWarmupMock.mockResolvedValue({ playwright: 'ok', searxng: 'skipped', embeddings: 'ok', reranker: 'ok' });
      wasUninstalledMock.mockReturnValue(false);
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
      if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
      if (prevGha === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prevGha;
    });

    it('--wizard invokes the Ink entry (runConfig --force-wizard)', async () => {
      // runConfig(['--force-wizard']) is the single delegate that mounts the Ink
      // TUI (runConfig → runEntry → render). Its invocation IS the Ink mount.
      const cap = capture();
      try {
        await runInit(['--wizard']);
        expect(runConfigMock).toHaveBeenCalledTimes(1);
        expect(runConfigMock.mock.calls[0]?.[0]).toEqual(['--force-wizard']);
      } finally {
        cap.restore();
      }
    });

    it('default TTY init does NOT invoke the Ink entry', async () => {
      primeHappyPath();
      selectAgentsMock.mockResolvedValue([]);
      const cap = capture();
      try {
        await runInit([]);
        expect(runConfigMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });

    it('--wizard in a non-TTY context errors clearly (does NOT silently fall back)', async () => {
      // Ink requires a real terminal. A user who explicitly asked for the guided
      // wizard on a non-TTY must get a clear error (exit 2) — not a silent
      // downgrade to the unattended flow. It must NOT mount Ink (no runConfig)
      // and must NOT run the plain setup (no warmup).
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      primeHappyPath();
      const cap = capture();
      try {
        const code = await runInit(['--wizard', '--agents=cursor', '--skip-verify']);
        expect(code).toBe(2);
        expect(runConfigMock).not.toHaveBeenCalled();
        expect(runWarmupMock).not.toHaveBeenCalled();
        expect(cap.stderr.join('')).toMatch(/--wizard\/--interactive needs an interactive terminal/i);
      } finally {
        cap.restore();
      }
    });

    it('--interactive in a non-TTY context errors clearly (alias of --wizard)', async () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      primeHappyPath();
      const cap = capture();
      try {
        const code = await runInit(['--interactive', '--agents=cursor']);
        expect(code).toBe(2);
        expect(runConfigMock).not.toHaveBeenCalled();
        expect(cap.stderr.join('')).toMatch(/needs an interactive terminal/i);
      } finally {
        cap.restore();
      }
    });
  });

  describe('parity: plain-default and --wizard agree on config + agent registrations', () => {
    let prevTTY: boolean | undefined;
    let prevCI: string | undefined;
    let prevGha: string | undefined;

    beforeEach(() => {
      prevTTY = process.stdout.isTTY;
      prevCI = process.env.CI;
      prevGha = process.env.GITHUB_ACTIONS;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;
      runConfigMock.mockResolvedValue(0);
      runWarmupMock.mockResolvedValue({ playwright: 'ok', searxng: 'skipped', embeddings: 'ok', reranker: 'ok' });
      wasUninstalledMock.mockReturnValue(false);
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
      if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
      if (prevGha === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prevGha;
    });

    // Parity contract (D8, LOCKED): identical inputs ⇒ byte-identical persisted
    // config + the same agent-registration set across plain vs --wizard. The
    // wizard path funnels persistence through the SAME shared config machinery
    // (runConfig → the schema catalog + default agent targets + propagation.save)
    // that the plain path resolves from. This test locks the observable persisted
    // shape on the plain (reference) path and asserts the --wizard path routes the
    // identical agent selection through that single shared entry.
    it('plain non-interactive persists agents + init-config for a fixed input; --wizard routes the same', async () => {
      primeHappyPath();
      saveInitConfigMock.mockClear();
      applyConfigsMock.mockClear();

      // Reference path (plain, non-interactive) with a fixed agent selection.
      const capA = capture();
      let plainCode: number;
      try {
        plainCode = await runInit(['--non-interactive', '--agents=cursor', '--skip-verify']);
      } finally {
        capA.restore();
      }
      expect(plainCode).toBe(0);

      // Observable persisted config on the plain path.
      expect(applyConfigsMock).toHaveBeenCalledTimes(1);
      const registeredPlain = applyConfigsMock.mock.calls[0]?.[1];
      expect(registeredPlain).toEqual(['cursor']);
      expect(saveInitConfigMock).toHaveBeenCalledTimes(1);
      const savedPayload = saveInitConfigMock.mock.calls[0]?.[1] as { configuredAgents: string[] };
      expect(savedPayload.configuredAgents).toEqual(['cursor']);

      // --wizard path: delegates to the SINGLE shared config entry with
      // --force-wizard. That entry resolves the same catalog + agent targets +
      // propagation.save the plain path uses, so persistence stays parity-locked.
      runConfigMock.mockClear();
      const capB = capture();
      try {
        await runInit(['--wizard']);
      } finally {
        capB.restore();
      }
      expect(runConfigMock).toHaveBeenCalledTimes(1);
      expect(runConfigMock.mock.calls[0]?.[0]).toEqual(['--force-wizard']);
    });
  });

  describe('default TTY path is plain (NOT Ink)', () => {
    let prevTTY: boolean | undefined;
    let prevCI: string | undefined;
    let prevGha: string | undefined;

    beforeEach(() => {
      prevTTY = process.stdout.isTTY;
      prevCI = process.env.CI;
      prevGha = process.env.GITHUB_ACTIONS;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;
      runConfigMock.mockResolvedValue(0);
      runWarmupMock.mockResolvedValue({ playwright: 'ok', searxng: 'skipped', embeddings: 'ok', reranker: 'ok' });
      wasUninstalledMock.mockReturnValue(false);
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
      if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
      if (prevGha === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prevGha;
    });

    it('default init on a TTY runs the plain path and never mounts Ink (no --force-wizard delegate)', async () => {
      // INVERTED (D8): a bare TTY init used to mount the Ink wizard. Now the
      // default is the plain path on TTY and non-TTY alike — Ink mounts ONLY
      // under --wizard. So runConfig(['--force-wizard']) must NOT be called.
      primeHappyPath();
      selectAgentsMock.mockResolvedValue([]);
      const cap = capture();
      try {
        const code = await runInit([]);
        expect(code).toBe(0);
        expect(runConfigMock).not.toHaveBeenCalled();
        // Plain path renders the banner + system check to stdout.
        expect(cap.stdout.join('')).toContain('BANNER');
      } finally {
        cap.restore();
      }
    });

    it('default init on a TTY runs the full setup (warmup fires)', async () => {
      primeHappyPath();
      selectAgentsMock.mockResolvedValue([]);
      const cap = capture();
      try {
        await runInit([]);
        expect(runWarmupMock).toHaveBeenCalledTimes(1);
        expect(runWarmupMock.mock.calls[0]?.[0]).toEqual(['--all', '--skip-verify']);
      } finally {
        cap.restore();
      }
    });
  });

  describe('unattended-by-default: no prompts on the default path', () => {
    let prevTTY: boolean | undefined;
    let prevCI: string | undefined;
    let prevGha: string | undefined;

    beforeEach(() => {
      prevTTY = process.stdout.isTTY;
      prevCI = process.env.CI;
      prevGha = process.env.GITHUB_ACTIONS;
      // A real terminal — proving the default STILL does not prompt even when a
      // TTY is available (the footgun is that init used to prompt here).
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;
      runConfigMock.mockResolvedValue(0);
      runWarmupMock.mockResolvedValue({ playwright: 'ok', searxng: 'skipped', embeddings: 'ok', reranker: 'ok' });
      wasUninstalledMock.mockReturnValue(false);
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
      if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
      if (prevGha === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prevGha;
    });

    it('(a) default init --agents=cursor wires the agent WITHOUT any prompt call, exit 0', async () => {
      primeHappyPath();
      const cap = capture();
      try {
        const code = await runInit(['--agents=cursor', '--skip-verify']);
        expect(code).toBe(0);
        // The agent is wired from --agents...
        expect(applyConfigsMock).toHaveBeenCalledTimes(1);
        expect(applyConfigsMock.mock.calls[0]?.[1]).toEqual(['cursor']);
        // ...and NEITHER prompt path was ever reached.
        expect(selectAgentsMock).not.toHaveBeenCalled();
        expect(promptExtrasMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });

    it('(b) default init with NO --agents = engine-only + hint, no prompt, exit 0', async () => {
      primeHappyPath();
      const cap = capture();
      try {
        const code = await runInit(['--skip-verify']);
        expect(code).toBe(0);
        expect(applyConfigsMock).not.toHaveBeenCalled();
        expect(selectAgentsMock).not.toHaveBeenCalled();
        expect(promptExtrasMock).not.toHaveBeenCalled();
        const out = cap.stdout.join('');
        expect(out).toMatch(/Engine ready — no agent wiring requested/);
        expect(out).toMatch(/npx wigolo mcp/);
      } finally {
        cap.restore();
      }
    });

    it('(e) --non-interactive is an accepted NO-OP — identical to the default', async () => {
      primeHappyPath();
      const cap = capture();
      try {
        const code = await runInit(['--non-interactive', '--agents=cursor', '--skip-verify']);
        expect(code).toBe(0);
        expect(applyConfigsMock).toHaveBeenCalledTimes(1);
        expect(applyConfigsMock.mock.calls[0]?.[1]).toEqual(['cursor']);
        // Still no prompt — the default already never prompts.
        expect(selectAgentsMock).not.toHaveBeenCalled();
        expect(promptExtrasMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });

    it('(f) --interactive runs the PLAIN-TEXT prompt flow, NOT the Ink wizard', async () => {
      // --interactive is its own mode: the plain-text agent-picker prompt +
      // promptExtras. It must NOT mount the Ink wizard (no runConfig) and it
      // MUST exercise the plain-text prompt path.
      primeHappyPath();
      selectAgentsMock.mockResolvedValue(['cursor']);
      const cap = capture();
      try {
        const code = await runInit(['--interactive']);
        expect(code).toBe(0);
        expect(runConfigMock).not.toHaveBeenCalled();
        expect(selectAgentsMock).toHaveBeenCalledTimes(1);
        expect(promptExtrasMock).toHaveBeenCalledTimes(1);
        // The agent chosen at the prompt is what gets wired.
        expect(applyConfigsMock.mock.calls[0]?.[1]).toEqual(['cursor']);
      } finally {
        cap.restore();
      }
    });

    it('--interactive with an empty picker selection stops with "nothing to do", exit 0', async () => {
      primeHappyPath();
      selectAgentsMock.mockResolvedValue([]);
      const cap = capture();
      try {
        const code = await runInit(['--interactive']);
        expect(code).toBe(0);
        expect(applyConfigsMock).not.toHaveBeenCalled();
        expect(cap.stderr.join('')).toMatch(/No agents selected — nothing to do/);
      } finally {
        cap.restore();
      }
    });

    it('--wizard + --non-interactive: --wizard wins (explicit interactive request)', async () => {
      const cap = capture();
      try {
        const code = await runInit(['--wizard', '--non-interactive']);
        expect(code).toBe(0);
        // Wizard path (Ink) was taken despite the no-op --non-interactive.
        expect(runConfigMock).toHaveBeenCalledTimes(1);
        expect(runConfigMock.mock.calls[0]?.[0]).toEqual(['--force-wizard']);
      } finally {
        cap.restore();
      }
    });

    it('--wizard + --plain opts back out of the wizard (plain wins, no prompt)', async () => {
      primeHappyPath();
      const cap = capture();
      try {
        const code = await runInit(['--wizard', '--plain', '--agents=cursor', '--skip-verify']);
        expect(code).toBe(0);
        expect(runConfigMock).not.toHaveBeenCalled();
        expect(selectAgentsMock).not.toHaveBeenCalled();
        expect(promptExtrasMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });
  });

  describe('--wizard (Ink) path', () => {
    let prevTTY: boolean | undefined;
    let prevCI: string | undefined;
    let prevGha: string | undefined;

    beforeEach(() => {
      prevTTY = process.stdout.isTTY;
      prevCI = process.env.CI;
      prevGha = process.env.GITHUB_ACTIONS;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;
      runConfigMock.mockResolvedValue(0);
      runWarmupMock.mockResolvedValue({ playwright: 'ok', searxng: 'skipped', embeddings: 'ok', reranker: 'ok' });
      wasUninstalledMock.mockReturnValue(false);
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
      if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
      if (prevGha === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prevGha;
    });

    it('--wizard mounts the Ink wizard via runConfig(["--force-wizard"]) and runs the full setup by DEFAULT', async () => {
      const cap = capture();
      try {
        const code = await runInit(['--wizard']);
        expect(code).toBe(0);
        expect(runConfigMock).toHaveBeenCalledTimes(1);
        expect(runConfigMock.mock.calls[0]?.[0]).toEqual(['--force-wizard']);
        // Full setup is the default on the wizard path too — warmup fires after
        // the Ink shell unmounts.
        expect(runWarmupMock).toHaveBeenCalledTimes(1);
        expect(runWarmupMock.mock.calls[0]?.[0]).toEqual(['--all', '--skip-verify']);
      } finally {
        cap.restore();
      }
    });

    it('--wizard --no-warmup runs the wizard but NO warmup (zero bytes)', async () => {
      const cap = capture();
      try {
        const code = await runInit(['--wizard', '--no-warmup']);
        expect(code).toBe(0);
        expect(runConfigMock).toHaveBeenCalledTimes(1);
        expect(runWarmupMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });

    it('--wizard --no-warmup prints the components-on-first-use hint', async () => {
      const cap = capture();
      try {
        await runInit(['--wizard', '--no-warmup']);
        const all = cap.stdout.join('') + cap.stderr.join('');
        expect(all).toMatch(/components download on first use/i);
        expect(all).toMatch(/wigolo warmup --all/);
      } finally {
        cap.restore();
      }
    });

    it('propagates the code when the wizard exits non-zero and skips warmup', async () => {
      runConfigMock.mockResolvedValue(1);
      const cap = capture();
      try {
        const code = await runInit(['--wizard']);
        expect(code).toBe(1);
        expect(runWarmupMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });

    it('a warmup throw is swallowed on the wizard path — exit 0 + logged fix', async () => {
      // Exit 0 even on component-download failure: log the failure, the
      // component lazy-retries. A thrown warmup must NOT fail init.
      runWarmupMock.mockRejectedValue(new Error('browser download blocked'));
      const cap = capture();
      try {
        const code = await runInit(['--wizard']);
        expect(code).toBe(0);
        expect(cap.stderr.join('')).toMatch(/browser download blocked/);
        expect(cap.stderr.join('')).toMatch(/Fix:/);
      } finally {
        cap.restore();
      }
    });

    it('skips warmup when the user uninstalled mid-session', async () => {
      // Navigating to the uninstall screen wipes ~/.wigolo; runInit must not
      // re-run warmup afterward or it would recreate everything just removed.
      wasUninstalledMock.mockReturnValue(true);
      const cap = capture();
      try {
        const code = await runInit(['--wizard']);
        expect(code).toBe(0);
        expect(runConfigMock).toHaveBeenCalledTimes(1);
        expect(runWarmupMock).not.toHaveBeenCalled();
      } finally {
        cap.restore();
      }
    });

    it('installs skills for the wizard-selected agents read back from init-config', async () => {
      // The wizard's finish step persists configuredAgents; runInit's wizard
      // branch reads them back after the Ink shell unmounts and drives the SAME
      // shared engine call the plain path uses.
      readInitConfigMock.mockReturnValue({ configuredAgents: ['claude-code', 'cursor'] });
      const cap = capture();
      try {
        const code = await runInit(['--wizard']);
        expect(code).toBe(0);
      } finally {
        cap.restore();
      }
      expect(installSkillsMock).toHaveBeenCalledTimes(1);
      const arg = installSkillsMock.mock.calls[0]?.[0] as { scope: string; agents: string[] };
      expect(arg.scope).toBe('global');
      expect(arg.agents.sort()).toEqual(['claude-code', 'cursor']);
    });

    it('does NOT install skills after an in-wizard uninstall', async () => {
      // wasUninstalled short-circuits BEFORE the skills step, so an intentional
      // uninstall is never undone by a skills reinstall.
      wasUninstalledMock.mockReturnValue(true);
      readInitConfigMock.mockReturnValue({ configuredAgents: ['claude-code'] });
      const cap = capture();
      try {
        await runInit(['--wizard']);
      } finally {
        cap.restore();
      }
      expect(installSkillsMock).not.toHaveBeenCalled();
    });

    it('installs no skills when the wizard selected no skills-capable agents', async () => {
      readInitConfigMock.mockReturnValue({ configuredAgents: ['vscode', 'zed'] });
      const cap = capture();
      try {
        await runInit(['--wizard']);
      } finally {
        cap.restore();
      }
      expect(installSkillsMock).not.toHaveBeenCalled();
    });
  });
});
