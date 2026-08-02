import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfig } from '../../../src/config.js';

// These tests pin the D5 lazy-aware exit contract: a fresh install must NOT
// exit 1, must NOT download models, and must report missing components as
// "lazy — downloads on first use" rather than failures. WHY: P1's per-channel
// acceptance is literally "wigolo doctor green on a fresh install" — a doctor
// that degrades on a missing (but lazily-acquired) browser, or on an absent
// searxng bootstrap under the default core backend, makes that impossible.

vi.mock('node:child_process', () => ({ execSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});
vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/playwright/chromium/chrome'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/playwright/firefox/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/playwright/webkit/webkit'), launch: vi.fn(okLaunch) },
  };
});

// The model providers download on load. A passive doctor MUST NOT call these on
// a fresh dir — the mocks record whether the download path was ever touched.
const getEmbedProviderMock = vi.fn(async () => ({ modelId: 'BAAI/bge-small-en-v1.5', dim: 384, embed: vi.fn() }));
const getRerankProviderMock = vi.fn(async () => ({
  modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
  rerank: vi.fn().mockResolvedValue([{ id: '0', score: 0.9 }]),
}));
vi.mock('../../../src/providers/embed-provider.js', () => ({ getEmbedProvider: (...a: unknown[]) => getEmbedProviderMock(...(a as [])) }));
vi.mock('../../../src/providers/rerank-provider.js', () => ({ getRerankProvider: (...a: unknown[]) => getRerankProviderMock(...(a as [])) }));

vi.mock('../../../src/cache/db.js', () => {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (typeof sql === 'string' && sql.includes('vec_version')) return { get: vi.fn(() => ({ v: '0.1.7' })) };
      return { get: vi.fn(() => ({ n: 0, last_at: null })) };
    }),
  };
  return { initDatabase: vi.fn(() => db), closeDatabase: vi.fn(), getDatabase: vi.fn(() => db), isVecExtensionLoaded: vi.fn(() => true) };
});
vi.mock('../../../src/search/core/rss/feed-config.js', () => ({ loadFeedConfig: vi.fn(() => ({ feeds: [], sources: [] })) }));

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { runDoctor } from '../../../src/cli/doctor.js';

// Read the REAL package.json (node:fs is mocked below) via importActual.
const { readFileSync: realReadFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
const PKG_VERSION = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = realReadFileSync(join(here, '..', '..', '..', 'package.json'), 'utf-8');
  return (JSON.parse(raw as string) as { version: string }).version;
})();

function okProc(stdout = ''): ReturnType<typeof spawnSync> {
  return { status: 0, stdout, stderr: '', signal: null, pid: 1, output: [], error: undefined } as ReturnType<typeof spawnSync>;
}

function failProc(): ReturnType<typeof spawnSync> {
  return { status: 1, stdout: '', stderr: '', signal: null, pid: 1, output: [], error: undefined } as ReturnType<typeof spawnSync>;
}

let outBuffer = '';
let stdoutBuffer = '';
let writeSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  outBuffer = '';
  stdoutBuffer = '';
  resetConfig();
  vi.clearAllMocks();
  delete process.env.WIGOLO_SEARCH;
  vi.mocked(readdirSync).mockReturnValue([] as never);
  vi.mocked(writeFileSync).mockReturnValue(undefined);
  vi.mocked(unlinkSync).mockReturnValue(undefined);
  writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { outBuffer += String(chunk); return true; });
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdoutBuffer += String(chunk); return true; });
});

afterEach(() => {
  resetConfig();
  delete process.env.WIGOLO_SEARCH;
  writeSpy.mockRestore();
  stdoutSpy.mockRestore();
});

/**
 * Simulate a fresh install: default core backend, no browser binary on disk, no
 * model caches, no searxng bootstrap. The data dir itself is writable.
 */
function mockFreshInstall(): void {
  vi.mocked(spawnSync).mockImplementation((cmd, args) => {
    const joined = [cmd, ...((args ?? []) as string[])].join(' ');
    if (joined.includes('--version')) return okProc('Python 3.12.4');
    return okProc();
  });
  // Nothing on disk: no browser binary, no state.json, no model dirs.
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(readdirSync).mockReturnValue([] as never);
  vi.mocked(readFileSync).mockReturnValue('');
}

describe('doctor — fresh-install lazy contract', () => {
  it('exits 0 on a fresh install (missing browser + models + no searxng bootstrap)', async () => {
    mockFreshInstall();
    const code = await runDoctor('/tmp/.wigolo-fresh');
    expect(code).toBe(0);
    expect(outBuffer).toMatch(/Overall: OK/);
  });

  it('reports the missing browser as lazy, not a failure', async () => {
    mockFreshInstall();
    await runDoctor('/tmp/.wigolo-fresh');
    expect(outBuffer).toMatch(/downloads on first use/i);
    expect(outBuffer).not.toMatch(/Overall: DEGRADED/);
  });

  it('SKIPS the searxng bootstrap section on the default core backend', async () => {
    mockFreshInstall();
    await runDoctor('/tmp/.wigolo-fresh');
    // Old contract printed "not bootstrapped — run npx wigolo warmup" and
    // degraded. Under core the whole bootstrap-state section must be absent.
    expect(outBuffer).not.toMatch(/not bootstrapped/);
  });

  it('performs ZERO model downloads on a fresh dir (passive probes only)', async () => {
    mockFreshInstall();
    await runDoctor('/tmp/.wigolo-fresh');
    expect(getEmbedProviderMock).not.toHaveBeenCalled();
    expect(getRerankProviderMock).not.toHaveBeenCalled();
  });

  it('reports embeddings AND reranker as not-installed/lazy on a fresh dir', async () => {
    mockFreshInstall();
    await runDoctor('/tmp/.wigolo-fresh');
    expect(outBuffer).toMatch(/ML reranker:\s+not installed/i);
    expect(outBuffer).toMatch(/Embeddings model:\s+not installed/i);
  });
});

describe('doctor — POSITIVE: models present are reported installed', () => {
  it('reports BOTH embeddings and reranker installed when their (distinct) cache dirs are populated', async () => {
    // GUARD (spec nit 3): a wrong-dir presence check would pass the fresh-dir
    // zero-download negative while ALWAYS reporting missing. The two models
    // cache in DIFFERENT directories — fastembed vs transformers — so we
    // populate each and require BOTH to read as installed.
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const joined = [cmd, ...((args ?? []) as string[])].join(' ');
      if (joined.includes('--version')) return okProc('Python 3.12.4');
      return okProc();
    });
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      return s.endsWith('fastembed') || s.endsWith('transformers') || s.includes('/fake/playwright/');
    });
    vi.mocked(readdirSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('fastembed')) return ['models--BAAI--bge-small-en-v1.5'] as never;
      if (s.endsWith('transformers')) return ['Xenova'] as never;
      return [] as never;
    });
    vi.mocked(readFileSync).mockReturnValue('');

    await runDoctor('/tmp/.wigolo-warm');

    expect(outBuffer).toMatch(/ML reranker:\s+installed/i);
    expect(outBuffer).toMatch(/Embeddings model:\s+installed/i);
    // Still no live model load — presence check is filesystem-only.
    expect(getEmbedProviderMock).not.toHaveBeenCalled();
    expect(getRerankProviderMock).not.toHaveBeenCalled();
  });

  it('reports reranker MISSING when only the embeddings dir is present (wrong-dir guard)', async () => {
    // If both checks pointed at fastembed, this would wrongly say the reranker
    // is installed. Only fastembed is populated → reranker must read missing.
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const joined = [cmd, ...((args ?? []) as string[])].join(' ');
      if (joined.includes('--version')) return okProc('Python 3.12.4');
      return okProc();
    });
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      return s.endsWith('fastembed') || s.includes('/fake/playwright/');
    });
    vi.mocked(readdirSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('fastembed')) return ['models--BAAI--bge-small-en-v1.5'] as never;
      return [] as never;
    });
    vi.mocked(readFileSync).mockReturnValue('');

    await runDoctor('/tmp/.wigolo-partial');

    expect(outBuffer).toMatch(/Embeddings model:\s+installed/i);
    expect(outBuffer).toMatch(/ML reranker:\s+not installed/i);
  });
});

describe('doctor — python/docker runtime prerequisite is searxng-scoped', () => {
  // WHY: python/docker exist ONLY to bootstrap/run the optional search-engine
  // sidecar. On the default core backend a machine (e.g. a slim container) with
  // neither runtime is perfectly healthy — degrading there fails the P1
  // "doctor green on a fresh install" acceptance for the Docker channel. This
  // is the same D5 gate the searxng section and collectFixableChecks use.
  function mockNoRuntimes(): void {
    // Every external process probe fails: no python3, docker --version fails.
    vi.mocked(spawnSync).mockImplementation(() => failProc());
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readdirSync).mockReturnValue([] as never);
    vi.mocked(readFileSync).mockReturnValue('');
  }

  it('exits 0 with python AND docker both missing under the default core backend', async () => {
    mockNoRuntimes();
    const code = await runDoctor('/tmp/.wigolo-slim');
    expect(outBuffer).toMatch(/Python 3:\s+not available/);
    expect(outBuffer).toMatch(/Docker:\s+not available/);
    expect(code).toBe(0);
    expect(outBuffer).toMatch(/Overall: OK/);
  });

  it('STILL degrades on missing python+docker when searxng is configured (isolated: bootstrap ready)', async () => {
    // The bootstrap is READY, so the ONLY degradation source left is the
    // runtime check — this guard fails if the gate over-fires and turns the
    // check off for configured-searxng installs too.
    process.env.WIGOLO_SEARCH = 'searxng';
    resetConfig();
    vi.mocked(spawnSync).mockImplementation(() => failProc());
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('state.json'));
    vi.mocked(readdirSync).mockReturnValue([] as never);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/sx' });
      return '';
    });

    const code = await runDoctor('/tmp/.wigolo-sx-noruntime');

    expect(outBuffer).toMatch(/status:\s+ready/);
    expect(code).toBe(1);
    expect(outBuffer).toMatch(/Overall: DEGRADED/);
  });
});

describe('doctor — searxng section gating does not over-fire', () => {
  it('STILL reports the searxng section when the backend is configured (searxng)', async () => {
    process.env.WIGOLO_SEARCH = 'searxng';
    resetConfig();
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    // No bootstrap state → the configured backend degrades as before.
    vi.mocked(existsSync).mockImplementation((p) => !String(p).endsWith('state.json') && !String(p).includes('/fake/playwright/'));
    vi.mocked(readdirSync).mockReturnValue([] as never);
    vi.mocked(readFileSync).mockReturnValue('');

    const code = await runDoctor('/tmp/.wigolo-sx');

    expect(outBuffer).toMatch(/not bootstrapped/);
    expect(code).toBe(1);
    delete process.env.WIGOLO_SEARCH;
    resetConfig();
  });
});

describe('doctor — broken browser still degrades (lazy ≠ blind)', () => {
  it('exits 1 when chromium is on disk but will not launch (corrupt install)', async () => {
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const joined = [cmd, ...((args ?? []) as string[])].join(' ');
      if (joined.includes('--version')) return okProc('1.50.0');
      return okProc();
    });
    // Binary present on disk everywhere → chromiumOnDisk true, but launch fails.
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['model'] as never);
    vi.mocked(readFileSync).mockReturnValue('');
    const { chromium } = await import('playwright');
    vi.mocked(chromium.launch).mockRejectedValueOnce(new Error('crashed on launch') as never);

    const code = await runDoctor('/tmp/.wigolo-broken');

    expect(code).toBe(1);
    expect(outBuffer).toMatch(/will not launch|Overall: DEGRADED/i);
  });
});

describe('doctor — data-dir writability probe', () => {
  it('emits an actionable failed check naming the dir when the data dir is unwritable', async () => {
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readdirSync).mockReturnValue([] as never);
    vi.mocked(readFileSync).mockReturnValue('');
    // The writability probe writes a temp marker; simulate EACCES.
    vi.mocked(writeFileSync).mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    const code = await runDoctor('/data/.wigolo-ro', { json: true });
    const parsed = JSON.parse(stdoutBuffer);
    const wc = parsed.checks.find((c: { name: string }) => c.name === 'data-dir');
    expect(wc).toBeDefined();
    expect(wc.status).toBe('failed');
    expect(String(wc.detail)).toContain('/data/.wigolo-ro');
    expect(code).toBe(1);
  });

  it('passes the writability check when the data dir is writable', async () => {
    mockFreshInstall();
    const code = await runDoctor('/tmp/.wigolo-fresh', { json: true });
    const parsed = JSON.parse(stdoutBuffer);
    const wc = parsed.checks.find((c: { name: string }) => c.name === 'data-dir');
    expect(wc).toBeDefined();
    expect(wc.status).toBe('ok');
    expect(code).toBe(0);
  });
});

describe('doctor --json — version + install_channel', () => {
  it('includes version matching package.json and an install_channel field', async () => {
    mockFreshInstall();
    // getVersion() reads package.json via the mocked readFileSync; return the
    // real file for that one path so the assertion tests the true version.
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('package.json')) return realReadFileSync(p as string, 'utf-8');
      return '';
    });
    await runDoctor('/tmp/.wigolo-fresh', { json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.version).toBe(PKG_VERSION);
    expect(parsed).toHaveProperty('install_channel');
    expect(['binary', 'npm-or-source']).toContain(parsed.install_channel);
  });
});
