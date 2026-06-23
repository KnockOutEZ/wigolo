import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';

// Mock DaemonHttpServer to prevent actual server start
vi.mock('../../../src/daemon/http-server.js', () => {
  return {
    DaemonHttpServer: class MockDaemonHttpServer {
      port: number;
      host: string;
      constructor(options: { port: number; host: string }) {
        this.port = options.port;
        this.host = options.host;
      }
      start = vi.fn().mockResolvedValue('http://127.0.0.1:3333');
      stop = vi.fn().mockResolvedValue(undefined);
    },
  };
});

describe('runDaemon', () => {
  const originalEnv = process.env;
  let stderrOutput: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.clearAllMocks();
    stderrOutput = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
      stderrOutput += typeof data === 'string' ? data : new TextDecoder().decode(data);
      return true;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  it('exports runDaemon function', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    expect(typeof runDaemon).toBe('function');
  });

  it('runDaemon accepts args array', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    expect(() => runDaemon([])).not.toThrow();
  });

  it('parses --port flag from args', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--port', '4444']);
    expect(parsed.port).toBe(4444);
  });

  it('defaults port to config value when not specified', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs([]);
    expect(parsed.port).toBe(3333);
  });

  it('parses --host flag from args', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--host', '0.0.0.0']);
    expect(parsed.host).toBe('0.0.0.0');
  });

  it('defaults host to config value when not specified', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs([]);
    expect(parsed.host).toBe('127.0.0.1');
  });

  it('handles --port without value (ignores, uses default)', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--port']);
    expect(parsed.port).toBe(3333);
  });

  it('handles --port with non-numeric value (uses default)', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--port', 'abc']);
    expect(parsed.port).toBe(3333);
  });

  it('handles combined flags', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--port', '5555', '--host', '0.0.0.0']);
    expect(parsed.port).toBe(5555);
    expect(parsed.host).toBe('0.0.0.0');
  });

  it('ignores unknown flags', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--unknown', 'value', '--port', '4444']);
    expect(parsed.port).toBe(4444);
  });

  it('defaults allowRemote to false and parses --allow-remote', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    expect(parseDaemonArgs([]).allowRemote).toBe(false);
    expect(parseDaemonArgs(['--allow-remote']).allowRemote).toBe(true);
  });

  // P6-d finding 2: the prominent remote-exposure WARNING must key off the NON-LOOPBACK bind,
  // not off token minting. An operator-supplied token (minted:false) on a 0.0.0.0 bind is just
  // as remotely reachable, so the operator must still be warned.
  it('emits the remote-exposure WARNING on a non-loopback bind even with an OPERATOR token (not minted-gated)', async () => {
    process.env.WIGOLO_STUDIO_TOKEN = 'pinned-operator-token';
    resetConfig();
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    runDaemon(['--host', '0.0.0.0', '--allow-remote']); // operator token → minted:false
    expect(stderrOutput).toMatch(/WARNING[\s\S]*non-loopback/i);
  });

  // Guard the other side: a loopback bind never emits the remote-exposure WARNING (keyed off
  // non-loopback, NOT "always warn"). Holds before and after the fix.
  it('does NOT emit the remote-exposure WARNING on a loopback bind with an operator token', async () => {
    process.env.WIGOLO_STUDIO_TOKEN = 'pinned-operator-token';
    resetConfig();
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    runDaemon(['--host', '127.0.0.1']);
    expect(stderrOutput).not.toMatch(/WARNING/i);
  });
});

describe('buildServeAuth (audit S3 closure)', () => {
  it('loopback + no token → no auth required (back-compat)', async () => {
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    expect(buildServeAuth({ host: '127.0.0.1', allowRemote: false, configuredToken: null })).toEqual({
      ok: true,
      auth: undefined,
      minted: false,
      remote: false,
    });
  });

  it('loopback + operator token → uses the supplied token', async () => {
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    expect(buildServeAuth({ host: '127.0.0.1', allowRemote: false, configuredToken: 'pinned' })).toEqual({
      ok: true,
      auth: { token: 'pinned', host: '127.0.0.1' },
      minted: false,
      remote: false,
    });
  });

  it('non-loopback WITHOUT --allow-remote → refused', async () => {
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    const d = buildServeAuth({ host: '0.0.0.0', allowRemote: false, configuredToken: null });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.message).toMatch(/allow-remote/i);
  });

  it('non-loopback + --allow-remote + no token → FORCES auth on (minted) — closes S3', async () => {
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    const d = buildServeAuth({ host: '0.0.0.0', allowRemote: true, configuredToken: null });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.minted).toBe(true);
      expect(d.auth?.token).toHaveLength(43);
      expect(d.auth?.host).toBe('0.0.0.0');
    }
  });

  it('non-loopback + --allow-remote + operator token → forces auth with that (stable) token', async () => {
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    expect(buildServeAuth({ host: '0.0.0.0', allowRemote: true, configuredToken: 'pinned' })).toEqual({
      ok: true,
      auth: { token: 'pinned', host: '0.0.0.0' },
      minted: false,
      remote: true,
    });
  });
});

// D13 — the MINTED per-launch remote bearer is delivered via a 0600 handle file, not echoed to
// stderr (terminal/shell-log scrollback is a leak surface). Fail CLOSED on write error. All pins
// enter through real startup (runDaemon); the minted path needs a non-loopback bind + --allow-remote
// + NO operator token. Landmines: loopback path untouched (P6-d back-compat), 0600 owner-only, the
// token value never reaches stderr.
describe('D13 — minted serve bearer via a 0600 handle file (not stderr)', () => {
  const originalEnv = process.env;
  let dataDir: string;
  let stderrOutput: string;
  const exitCalls: number[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_STUDIO_TOKEN; // unset -> the per-launch token is MINTED on a remote bind
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-d13-'));
    process.env.WIGOLO_DATA_DIR = dataDir;
    resetConfig();
    vi.clearAllMocks();
    stderrOutput = '';
    exitCalls.length = 0;
    vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
      stderrOutput += typeof data === 'string' ? data : new TextDecoder().decode(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null): never => {
      exitCalls.push(typeof code === 'number' ? code : 0);
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(dataDir, { recursive: true, force: true });
    resetConfig();
    vi.restoreAllMocks();
  });

  const bearerPath = () => join(dataDir, 'serve-bearer');

  it('D13-1: writes the minted REMOTE bearer to a 0600 file', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    runDaemon(['--host', '0.0.0.0', '--allow-remote']);
    // flipped value: the bearer file exists (no file on current code -> RED).
    expect(existsSync(bearerPath())).toBe(true);
    expect(readFileSync(bearerPath(), 'utf-8')).toHaveLength(43); // minted token format
    expect(statSync(bearerPath()).mode & 0o777).toBe(0o600); // owner-only (MUT 0644 -> RED)
  });

  it('D13-2: does NOT echo the minted bearer VALUE to stderr — points to the file instead', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    runDaemon(['--host', '0.0.0.0', '--allow-remote']);
    // flipped value: no "label: <long-token>" echo (current code prints the token -> RED).
    expect(stderrOutput).not.toMatch(/bearer token[^\n]*: \S{20,}/i);
    expect(stderrOutput).toMatch(/serve-bearer/); // the PATH is surfaced instead
    // strengthening (GREEN state): the actual written token never appears in stderr.
    if (existsSync(bearerPath())) {
      expect(stderrOutput).not.toContain(readFileSync(bearerPath(), 'utf-8'));
    }
  });

  it('D13-3: fail-closed on a handle-file write error — refuses, no stderr-fallback', async () => {
    // Force the write to fail: point dataDir at a regular FILE so mkdirSync throws.
    const filePath = join(dataDir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    process.env.WIGOLO_DATA_DIR = filePath;
    resetConfig();
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    // process.exit is mocked to throw -> the fail-closed path surfaces as a throw (no quiet return).
    expect(() => runDaemon(['--host', '0.0.0.0', '--allow-remote'])).toThrow(/process\.exit/);
    expect(exitCalls).toContain(1); // refused
    expect(stderrOutput).toMatch(/error|refus/i);
    expect(stderrOutput).not.toMatch(/bearer token[^\n]*: \S{20,}/i); // no fallback leak
  });

  it('D13-4: loopback-default (no --allow-remote) still works WITHOUT a handle file', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    expect(() => runDaemon(['--host', '127.0.0.1'])).not.toThrow();
    expect(existsSync(bearerPath())).toBe(false); // no bearer file on the loopback path (MUT require-file -> RED)
    expect(exitCalls).toHaveLength(0); // no refusal
  });
});
