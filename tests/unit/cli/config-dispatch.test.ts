/**
 * Tests for the headless flag dispatch in src/cli/config.ts.
 *
 * Why: the "Done when" requires non-interactive parity for every SP5 action.
 * These tests stub the SP5 actions layer and assert that runConfig() parses
 * each flag and dispatches to the correct action with the correct arguments,
 * and returns the correct exit code.
 *
 * Critical guards covered:
 *   - --uninstall WITHOUT --yes does NOT call uninstall (no delete)
 *   - --uninstall --yes DOES call uninstall with confirmed:true
 *   - --cleanup embeddings routes to cleanupComponent('embeddings', ...)
 *   - --export / --import round-trip dispatch
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Stub the SP5 actions layer so we assert dispatch without touching FS/DB.
const computeStorageMock = vi.hoisted(() => vi.fn());
const getCacheStatsActionMock = vi.hoisted(() => vi.fn());
const cleanupComponentMock = vi.hoisted(() => vi.fn());
const exportConfigMock = vi.hoisted(() => vi.fn());
const importConfigMock = vi.hoisted(() => vi.fn());
const uninstallMock = vi.hoisted(() => vi.fn());
const applyHeadlessSetMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/cli/tui/actions/index.js', () => ({
  computeStorage: computeStorageMock,
  getCacheStatsAction: getCacheStatsActionMock,
  cleanupComponent: cleanupComponentMock,
  exportConfig: exportConfigMock,
  importConfig: importConfigMock,
  uninstall: uninstallMock,
  applyHeadlessSet: applyHeadlessSetMock,
}));

// Stub getConfig so dataDir is deterministic.
vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/wigolo-test-datadir' })),
}));

import { runConfig } from '../../../src/cli/config.js';

let stdoutWrite: ReturnType<typeof vi.spyOn>;
let stderrWrite: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Silence output during tests.
  stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutWrite.mockRestore();
  stderrWrite.mockRestore();
  vi.restoreAllMocks();
});

describe('runConfig --storage', () => {
  it('calls computeStorage with the data dir and returns 0', async () => {
    computeStorageMock.mockResolvedValueOnce({ items: [], hogs: [], totalBytes: 0 });
    const code = await runConfig(['--storage']);
    expect(code).toBe(0);
    expect(computeStorageMock).toHaveBeenCalledOnce();
    expect(computeStorageMock).toHaveBeenCalledWith('/tmp/wigolo-test-datadir');
  });
});

describe('runConfig --cache-stats', () => {
  it('calls getCacheStatsAction and returns 0 on success', async () => {
    getCacheStatsActionMock.mockResolvedValueOnce({
      totalEntries: 5, sizeMb: 1.2, oldest: '', newest: '',
    });
    const code = await runConfig(['--cache-stats']);
    expect(code).toBe(0);
    expect(getCacheStatsActionMock).toHaveBeenCalledOnce();
  });

  it('returns 1 when cache stats reports an error', async () => {
    getCacheStatsActionMock.mockResolvedValueOnce({
      totalEntries: 0, sizeMb: 0, oldest: '', newest: '', error: 'db locked',
    });
    const code = await runConfig(['--cache-stats']);
    expect(code).toBe(1);
  });
});

describe('runConfig --cleanup <component>', () => {
  it('--cleanup embeddings routes to cleanupComponent("embeddings", dataDir)', async () => {
    cleanupComponentMock.mockResolvedValueOnce({ ok: true, freedBytes: 2048 });
    const code = await runConfig(['--cleanup', 'embeddings']);
    expect(code).toBe(0);
    expect(cleanupComponentMock).toHaveBeenCalledWith('embeddings', '/tmp/wigolo-test-datadir');
  });

  it('--cleanup=cache (equals form) routes to cleanupComponent("cache", ...)', async () => {
    cleanupComponentMock.mockResolvedValueOnce({ ok: true, freedBytes: 0 });
    const code = await runConfig(['--cleanup=cache']);
    expect(code).toBe(0);
    expect(cleanupComponentMock).toHaveBeenCalledWith('cache', '/tmp/wigolo-test-datadir');
  });

  it('rejects an unknown component without calling cleanupComponent', async () => {
    const code = await runConfig(['--cleanup', 'bogus']);
    expect(code).toBe(1);
    expect(cleanupComponentMock).not.toHaveBeenCalled();
  });

  it('returns 1 when cleanupComponent reports failure', async () => {
    cleanupComponentMock.mockResolvedValueOnce({ ok: false, freedBytes: 0, error: 'EPERM' });
    const code = await runConfig(['--cleanup', 'models']);
    expect(code).toBe(1);
  });
});

describe('runConfig --export', () => {
  it('--export (no path) dispatches to exportConfig with the default export path', async () => {
    exportConfigMock.mockResolvedValueOnce({ ok: true, path: '/x' });
    const code = await runConfig(['--export']);
    expect(code).toBe(0);
    expect(exportConfigMock).toHaveBeenCalledOnce();
    const [exportPath] = exportConfigMock.mock.calls[0] as [string, string];
    expect(exportPath).toMatch(/wigolo-config-export\.json$/);
  });

  it('--export <path> dispatches to exportConfig with the given path', async () => {
    exportConfigMock.mockResolvedValueOnce({ ok: true, path: '/custom/out.json' });
    const code = await runConfig(['--export', '/custom/out.json']);
    expect(code).toBe(0);
    const [exportPath] = exportConfigMock.mock.calls[0] as [string, string];
    expect(exportPath).toBe('/custom/out.json');
  });

  it('returns 1 when exportConfig fails', async () => {
    exportConfigMock.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    const code = await runConfig(['--export']);
    expect(code).toBe(1);
  });
});

describe('runConfig --import <path>', () => {
  it('dispatches to importConfig with the given path and returns 0 on success', async () => {
    importConfigMock.mockResolvedValueOnce({ ok: true });
    const code = await runConfig(['--import', '/incoming.json']);
    expect(code).toBe(0);
    const [importPath] = importConfigMock.mock.calls[0] as [string, string];
    expect(importPath).toBe('/incoming.json');
  });

  it('--import=<path> (equals form) dispatches correctly', async () => {
    importConfigMock.mockResolvedValueOnce({ ok: true });
    const code = await runConfig(['--import=/incoming2.json']);
    expect(code).toBe(0);
    const [importPath] = importConfigMock.mock.calls[0] as [string, string];
    expect(importPath).toBe('/incoming2.json');
  });

  it('returns 1 when importConfig fails', async () => {
    importConfigMock.mockResolvedValueOnce({ ok: false, error: 'bad json' });
    const code = await runConfig(['--import', '/bad.json']);
    expect(code).toBe(1);
  });
});

describe('export/import round-trip dispatch', () => {
  it('export then import dispatch to their respective actions in sequence', async () => {
    exportConfigMock.mockResolvedValueOnce({ ok: true, path: '/rt.json' });
    importConfigMock.mockResolvedValueOnce({ ok: true });

    const exportCode = await runConfig(['--export', '/rt.json']);
    const importCode = await runConfig(['--import', '/rt.json']);

    expect(exportCode).toBe(0);
    expect(importCode).toBe(0);
    expect(exportConfigMock).toHaveBeenCalledOnce();
    expect(importConfigMock).toHaveBeenCalledOnce();
    // The path round-trips: same file out and back in.
    expect((exportConfigMock.mock.calls[0] as [string])[0]).toBe('/rt.json');
    expect((importConfigMock.mock.calls[0] as [string])[0]).toBe('/rt.json');
  });
});

describe('runConfig --set <key>=<value>', () => {
  it('dispatches to applyHeadlessSet with the parsed key and value', async () => {
    applyHeadlessSetMock.mockResolvedValueOnce({
      status: 'ok',
      message: 'Set WIGOLO_SEARCH = hybrid',
      saved: ['searchBackend'],
      propagated: ['claude-code'],
      failed: [],
    });
    const code = await runConfig(['--set', 'WIGOLO_SEARCH=hybrid']);
    expect(code).toBe(0);
    expect(applyHeadlessSetMock).toHaveBeenCalledOnce();
    const arg = applyHeadlessSetMock.mock.calls[0][0] as { key: string; value: string };
    expect(arg.key).toBe('WIGOLO_SEARCH');
    expect(arg.value).toBe('hybrid');
  });

  it('--set=<key>=<value> equals form parses correctly', async () => {
    applyHeadlessSetMock.mockResolvedValueOnce({
      status: 'ok',
      message: 'Set WIGOLO_MAX_BROWSERS = 4',
      saved: ['maxBrowsers'],
      propagated: [],
      failed: [],
    });
    const code = await runConfig(['--set=WIGOLO_MAX_BROWSERS=4']);
    expect(code).toBe(0);
    const arg = applyHeadlessSetMock.mock.calls[0][0] as { key: string; value: string };
    expect(arg.key).toBe('WIGOLO_MAX_BROWSERS');
    expect(arg.value).toBe('4');
  });

  it('preserves an = inside the value (e.g. base64 secrets, query strings)', async () => {
    applyHeadlessSetMock.mockResolvedValueOnce({
      status: 'ok',
      message: '',
      saved: [],
      propagated: [],
      failed: [],
    });
    await runConfig(['--set', 'CUSTOM_FLAG=key=val=trailing']);
    const arg = applyHeadlessSetMock.mock.calls[0][0] as { key: string; value: string };
    expect(arg.key).toBe('CUSTOM_FLAG');
    expect(arg.value).toBe('key=val=trailing');
  });

  it('returns 1 when applyHeadlessSet reports a non-ok status', async () => {
    applyHeadlessSetMock.mockResolvedValueOnce({
      status: 'secret_rejected',
      message: 'cannot set secrets',
      saved: [],
      propagated: [],
      failed: [],
    });
    const code = await runConfig(['--set', 'BRAVE_API_KEY=sk-x']);
    expect(code).toBe(1);
  });
});

describe('runConfig --uninstall (confirmation gate)', () => {
  it('--uninstall WITHOUT --yes does NOT call uninstall and returns 1', async () => {
    const code = await runConfig(['--uninstall']);
    expect(code).toBe(1);
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it('--uninstall --yes calls uninstall with confirmed:true and returns 0', async () => {
    uninstallMock.mockResolvedValueOnce({
      ok: true, dataDirRemoved: true, agentResults: [],
    });
    const code = await runConfig(['--uninstall', '--yes']);
    expect(code).toBe(0);
    expect(uninstallMock).toHaveBeenCalledOnce();
    expect(uninstallMock).toHaveBeenCalledWith({
      dataDir: '/tmp/wigolo-test-datadir',
      confirmed: true,
    });
  });

  it('--yes --uninstall (order-independent) also confirms', async () => {
    uninstallMock.mockResolvedValueOnce({
      ok: true, dataDirRemoved: true, agentResults: [],
    });
    const code = await runConfig(['--yes', '--uninstall']);
    expect(code).toBe(0);
    expect(uninstallMock).toHaveBeenCalledWith({
      dataDir: '/tmp/wigolo-test-datadir',
      confirmed: true,
    });
  });

  it('returns 1 when uninstall reports an error', async () => {
    uninstallMock.mockResolvedValueOnce({
      ok: false, dataDirRemoved: false, agentResults: [], error: 'unsafe path',
    });
    const code = await runConfig(['--uninstall', '--yes']);
    expect(code).toBe(1);
  });
});

describe('runConfig --help', () => {
  it('prints usage and returns 0 without dispatching any action', async () => {
    const code = await runConfig(['--help']);
    expect(code).toBe(0);
    expect(uninstallMock).not.toHaveBeenCalled();
    expect(computeStorageMock).not.toHaveBeenCalled();
  });
});

describe('runConfig --plain --json (machine-readable settings)', () => {
  let tmpDir: string;
  let cfgPath: string;
  let prevConfigPath: string | undefined;

  beforeEach(() => {
    const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-cfg-json-'));
    cfgPath = join(tmpDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ version: 1, settings: { searchBackend: 'hybrid' } }), { mode: 0o600 });
    prevConfigPath = process.env.WIGOLO_CONFIG_PATH;
    process.env.WIGOLO_CONFIG_PATH = cfgPath;
  });

  afterEach(() => {
    if (prevConfigPath === undefined) delete process.env.WIGOLO_CONFIG_PATH;
    else process.env.WIGOLO_CONFIG_PATH = prevConfigPath;
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('emits a single parseable JSON object on stdout with settings and dataDir', async () => {
    // WHY (D8): the --plain companion must be AI-drivable. --json turns the
    // human settings dump into one parseable object; the human table must not
    // be printed to stdout.
    const outLines: string[] = [];
    stdoutWrite.mockImplementation((s: string | Uint8Array) => {
      outLines.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
      return true;
    });
    const code = await runConfig(['--plain', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(outLines.join('').trim());
    expect(parsed.dataDir).toBe('/tmp/wigolo-test-datadir');
    expect(parsed.settings).toBeDefined();
    // Persisted value surfaces in the machine output.
    expect(parsed.settings.searchBackend).toBe('hybrid');
    // The human ASCII table header must NOT be on stdout.
    expect(outLines.join('')).not.toContain('Wigolo current settings');
  });
});
