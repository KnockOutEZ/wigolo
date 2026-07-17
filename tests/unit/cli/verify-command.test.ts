/**
 * Unit tests for the standalone `wigolo verify` command (SP6).
 *
 * WHY: the spec's "Done when" names non-interactive machine-readable output +
 * exit code as a delivery criterion. These tests pin the flag parsing and the
 * exit-code contract (allPassed → 0, any hard failure → 1) with the
 * verifyEndToEnd deps mocked — no live network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('parseVerifyFlags', () => {
  it('defaults to plain=false, help=false, json=false', async () => {
    const { parseVerifyFlags } = await import('../../../src/cli/verify.js');
    expect(parseVerifyFlags([])).toEqual({ plain: false, help: false, json: false });
  });

  it('sets plain for --plain, -y, and --non-interactive', async () => {
    const { parseVerifyFlags } = await import('../../../src/cli/verify.js');
    expect(parseVerifyFlags(['--plain']).plain).toBe(true);
    expect(parseVerifyFlags(['-y']).plain).toBe(true);
    expect(parseVerifyFlags(['--non-interactive']).plain).toBe(true);
  });

  it('sets help for --help and -h', async () => {
    const { parseVerifyFlags } = await import('../../../src/cli/verify.js');
    expect(parseVerifyFlags(['--help']).help).toBe(true);
    expect(parseVerifyFlags(['-h']).help).toBe(true);
  });

  it('sets json for --json', async () => {
    const { parseVerifyFlags } = await import('../../../src/cli/verify.js');
    expect(parseVerifyFlags(['--json']).json).toBe(true);
  });

  it('ignores unknown flags without throwing', async () => {
    const { parseVerifyFlags } = await import('../../../src/cli/verify.js');
    expect(parseVerifyFlags(['--unknown', 'positional'])).toEqual({ plain: false, help: false, json: false });
  });
});

describe('runVerifyE2E — exit-code contract', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.resetModules();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 0 on --help without running probes', async () => {
    const { runVerifyE2E } = await import('../../../src/cli/verify.js');
    const code = await runVerifyE2E(['--help']);
    expect(code).toBe(0);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('--help does not advertise the retired --non-interactive alias', async () => {
    // The alias still PARSES (see parseVerifyFlags above) but is a silent
    // no-op — unattended is the default — so help must not resurrect it.
    const { runVerifyE2E } = await import('../../../src/cli/verify.js');
    await runVerifyE2E(['--help']);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Usage: wigolo verify');
    expect(written).toContain('--plain');
    expect(written).not.toContain('--non-interactive');
  });

  it('returns 0 when verifyEndToEnd reports allPassed=true', async () => {
    vi.doMock('../../../src/cli/tui/actions/verify-e2e.js', () => ({
      buildDefaultDeps: vi.fn().mockResolvedValue({}),
      verifyEndToEnd: vi.fn().mockResolvedValue({
        capabilities: [{ capability: 'search', status: 'pass', detail: 'ok' }],
        mcpWiringResults: [],
        allPassed: true,
        hardFailureCount: 0,
      }),
      formatVerifyResultPlain: vi.fn().mockReturnValue(['PASS search ok']),
    }));
    const { runVerifyE2E } = await import('../../../src/cli/verify.js');
    const code = await runVerifyE2E(['--plain']);
    expect(code).toBe(0);
  });

  it('returns 1 when verifyEndToEnd reports a hard failure', async () => {
    vi.doMock('../../../src/cli/tui/actions/verify-e2e.js', () => ({
      buildDefaultDeps: vi.fn().mockResolvedValue({}),
      verifyEndToEnd: vi.fn().mockResolvedValue({
        capabilities: [{ capability: 'fetch', status: 'fail', detail: 'network down' }],
        mcpWiringResults: [],
        allPassed: false,
        hardFailureCount: 1,
      }),
      formatVerifyResultPlain: vi.fn().mockReturnValue(['FAIL fetch network down']),
    }));
    const { runVerifyE2E } = await import('../../../src/cli/verify.js');
    const code = await runVerifyE2E(['--plain']);
    expect(code).toBe(1);
  });

  it('--json emits the verify result on stdout with an exit-code-meaningful status (pass → 0)', async () => {
    // WHY (D8): AI-drivable verify. `wigolo verify --json | jq -e '.status'`.
    let stdoutOutput = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += String(chunk);
      return true;
    });
    vi.doMock('../../../src/cli/tui/actions/verify-e2e.js', () => ({
      buildDefaultDeps: vi.fn().mockResolvedValue({}),
      verifyEndToEnd: vi.fn().mockResolvedValue({
        capabilities: [{ capability: 'search', status: 'pass', detail: 'ok' }],
        mcpWiringResults: [],
        allPassed: true,
        hardFailureCount: 0,
      }),
      formatVerifyResultPlain: vi.fn().mockReturnValue(['PASS search ok']),
    }));
    const { runVerifyE2E } = await import('../../../src/cli/verify.js');
    const code = await runVerifyE2E(['--json']);
    stdoutSpy.mockRestore();
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed).toHaveProperty('status', 'ok');
    expect(parsed).toHaveProperty('allPassed', true);
    expect(Array.isArray(parsed.capabilities)).toBe(true);
    // Pretty lines must not be on stdout.
    expect(stdoutOutput).not.toContain('PASS search ok');
  });

  it('--json reports status=failed and exits 1 on a hard failure', async () => {
    let stdoutOutput = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += String(chunk);
      return true;
    });
    vi.doMock('../../../src/cli/tui/actions/verify-e2e.js', () => ({
      buildDefaultDeps: vi.fn().mockResolvedValue({}),
      verifyEndToEnd: vi.fn().mockResolvedValue({
        capabilities: [{ capability: 'fetch', status: 'fail', detail: 'network down' }],
        mcpWiringResults: [],
        allPassed: false,
        hardFailureCount: 1,
      }),
      formatVerifyResultPlain: vi.fn().mockReturnValue(['FAIL fetch network down']),
    }));
    const { runVerifyE2E } = await import('../../../src/cli/verify.js');
    const code = await runVerifyE2E(['--json']);
    stdoutSpy.mockRestore();
    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed).toHaveProperty('status', 'failed');
    expect(parsed).toHaveProperty('allPassed', false);
  });

  it('writes the formatted summary lines to stderr', async () => {
    const formatted = ['[wigolo verify] line 1', '[wigolo verify] line 2'];
    vi.doMock('../../../src/cli/tui/actions/verify-e2e.js', () => ({
      buildDefaultDeps: vi.fn().mockResolvedValue({}),
      verifyEndToEnd: vi.fn().mockResolvedValue({
        capabilities: [],
        mcpWiringResults: [],
        allPassed: true,
        hardFailureCount: 0,
      }),
      formatVerifyResultPlain: vi.fn().mockReturnValue(formatted),
    }));
    const { runVerifyE2E } = await import('../../../src/cli/verify.js');
    await runVerifyE2E(['--plain']);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('line 1');
    expect(written).toContain('line 2');
  });
});
