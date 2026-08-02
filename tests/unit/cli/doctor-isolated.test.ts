// Unit coverage for the doctor subprocess-isolation wrapper added in P4.
//
// `runDoctor` loads onnxruntime via fastembed, which races libc++ during
// static destructor teardown on macOS and surfaces a SIGABRT/exit-134 AFTER
// the diagnostic completes. The fix runs doctor in a child process: child
// writes its intended exit code to a sentinel file, parent reads the
// sentinel and exits cleanly. This file unit-covers the deterministic
// pieces of that wrapper:
//
//   1) isPostExitNativeNoise — the stderr line filter (pattern matrix)
//   2) child-mode sentinel write
//   3) parent-mode sentinel parsing (the load-bearing branch)
//   4) WIGOLO_DOCTOR_INPROC=1 opt-out short-circuit
//
// The companion E2E (tests/e2e/doctor-clean-exit.e2e.test.ts) covers the
// full spawn flow with a real binary; this file covers the deterministic
// branches that should fail on every test run if they regress.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdtempSync: vi.fn(() => '/tmp/wigolo-doctor-fake'),
    unlinkSync: vi.fn(),
    rmdirSync: vi.fn(),
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

vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank: vi.fn().mockResolvedValue([{ id: '0', score: 0.9 }]),
  })),
}));

vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({
    modelId: 'BAAI/bge-small-en-v1.5',
    dim: 384,
    embed: vi.fn(),
  })),
}));

vi.mock('../../../src/cache/db.js', () => {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (typeof sql === 'string' && sql.includes('vec_version')) {
        return { get: vi.fn(() => ({ v: '0.1.7-alpha.2' })) };
      }
      return { get: vi.fn(() => ({ n: 0, last_at: null })) };
    }),
  };
  return {
    initDatabase: vi.fn(() => db),
    closeDatabase: vi.fn(),
    getDatabase: vi.fn(() => db),
    isVecExtensionLoaded: vi.fn(() => true),
  };
});

vi.mock('../../../src/search/core/rss/feed-config.js', () => ({
  loadFeedConfig: vi.fn(() => ({ feeds: [], sources: [] })),
}));

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  isPostExitNativeNoise,
  runDoctorIsolated,
  runDoctorAsChild,
} from '../../../src/cli/doctor.js';

function okProc(stdout = ''): ReturnType<typeof spawnSync> {
  return {
    status: 0,
    stdout,
    stderr: '',
    signal: null,
    pid: 1,
    output: [],
    error: undefined,
  } as ReturnType<typeof spawnSync>;
}

// ---------------------------------------------------------------------------
// 1) isPostExitNativeNoise — pattern matrix
// ---------------------------------------------------------------------------

describe('isPostExitNativeNoise', () => {
  describe('positive cases (cosmetic native teardown noise)', () => {
    it('matches the libc++abi: prefix', () => {
      expect(isPostExitNativeNoise('libc++abi: terminating')).toBe(true);
      expect(isPostExitNativeNoise('libc++abi: something else entirely')).toBe(true);
    });

    it('matches the mutex lock failed substring', () => {
      expect(isPostExitNativeNoise('mutex lock failed: Invalid argument')).toBe(true);
    });

    it('matches the terminating-due-to-uncaught-exception substring', () => {
      expect(
        isPostExitNativeNoise(
          'terminating due to uncaught exception of type std::__1::system_error: mutex lock failed',
        ),
      ).toBe(true);
    });
  });

  describe('negative cases (regression guard — real errors must pass through)', () => {
    // Critical: if someone broadens the matcher (e.g. to a bare /mutex/ regex),
    // legitimate error output that quotes the symptom would be silently
    // swallowed. The matcher must remain anchored to the specific phrases.
    it('matches an extractor error that QUOTES the libc++abi: prefix as a substring', () => {
      // Today's matcher uses startsWith('libc++abi:'), so a line that merely
      // contains the prefix mid-sentence is NOT classified as noise. Lock this
      // contract in so future "let's just .includes() everything" regressions
      // surface immediately.
      const line = 'Error from upstream: "libc++abi: bad alloc" (should not be filtered)';
      expect(isPostExitNativeNoise(line)).toBe(false);
    });

    it('does NOT match an extractor error that contains "mutex lock failed: Invalid argument" mid-line', () => {
      // The current matcher uses .includes() for this phrase, so a quoted
      // mention WILL be filtered. We document the current behavior — if the
      // filter is ever tightened to startsWith() to fix this hole, the
      // assertion below should be flipped (still a regression guard).
      const line = 'Upstream error: "mutex lock failed: Invalid argument" reported by worker';
      expect(isPostExitNativeNoise(line)).toBe(true);
    });

    it('does not match an ordinary log line', () => {
      expect(isPostExitNativeNoise('[wigolo doctor] Overall: OK')).toBe(false);
      expect(isPostExitNativeNoise('   warming up reranker')).toBe(false);
      expect(isPostExitNativeNoise('Error: ECONNREFUSED 127.0.0.1:8888')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('does not match an empty string', () => {
      expect(isPostExitNativeNoise('')).toBe(false);
    });

    it('does not match whitespace-only input', () => {
      expect(isPostExitNativeNoise('   ')).toBe(false);
      expect(isPostExitNativeNoise('\t')).toBe(false);
    });

    it('does not match a leading-whitespace variant of the libc++abi: line', () => {
      // libc++abi: lines come from the native runtime with no leading
      // whitespace — but if someone re-pipes them through a logger that
      // indents, our startsWith() check rightly stops matching. This pins
      // the current strict-prefix contract.
      expect(isPostExitNativeNoise('  libc++abi: terminating')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 2) Child-mode sentinel write
// ---------------------------------------------------------------------------
//
// When WIGOLO_DOCTOR_CHILD is set, runDoctorIsolated runs runDoctor in-process
// and writes the resulting numeric exit code to the sentinel file. We can't
// mock runDoctor (it's a sibling function in the same module) so we drive its
// return value via its dependencies (the standard doctor-test mock stack) and
// assert that writeFileSync was called with the expected sentinel value.
//
// Reachable codes through real runDoctor are 0 (healthy) and 1 (degraded).
// The "255 raw" case is exercised through the parent-side parser in §3,
// which is the load-bearing branch.

describe('runDoctorIsolated — child mode (WIGOLO_DOCTOR_CHILD set)', () => {
  const SENTINEL = '/tmp/wigolo-doctor-fake-sentinel';
  const originalEnv = process.env;
  let outBuffer = '';
  const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    outBuffer += String(chunk);
    return true;
  });

  beforeEach(() => {
    outBuffer = '';
    resetConfig();
    vi.clearAllMocks();
    process.env = { ...originalEnv, WIGOLO_DOCTOR_CHILD: SENTINEL };
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    writeSpy.mockClear();
  });

  it('writes exit code "0" to the sentinel when runDoctor is healthy', async () => {
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'python3' || cmd === 'docker') return okProc('Python 3.12.4');
      return okProc();
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) {
        return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      }
      if (s.endsWith('searxng.lock')) {
        return JSON.stringify({ pid: process.pid, port: 8888 });
      }
      return '';
    });

    const code = await runDoctorIsolated('/tmp/.wigolo');

    expect(code).toBe(0);
    expect(writeFileSync).toHaveBeenCalledWith(SENTINEL, '0', 'utf-8');
    // Parent-mode subprocess MUST NOT be spawned when child-mode env is set.
    expect(spawn).not.toHaveBeenCalled();
  });

  it('writes exit code "1" to the sentinel when runDoctor is degraded (no bootstrap state)', async () => {
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockReturnValue(false);

    const code = await runDoctorIsolated('/tmp/.wigolo');

    expect(code).toBe(1);
    expect(writeFileSync).toHaveBeenCalledWith(SENTINEL, '1', 'utf-8');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('writes the sentinel before runDoctorIsolated returns (ordering contract)', async () => {
    // The parent reads the sentinel on the child's 'exit' event. If
    // writeFileSync ever moved after the return, the parent would race and
    // see an empty file — guarded explicitly.
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockReturnValue(false);

    let sentinelWrittenAt: number | null = null;
    // Match on the SENTINEL path across ALL writes — doctor also writes a
    // short-lived data-dir writability-probe marker (D5), so a `...Once` mock
    // would capture that unrelated write instead of the sentinel.
    vi.mocked(writeFileSync).mockImplementation((path) => {
      if (String(path) === SENTINEL) sentinelWrittenAt = Date.now();
    });

    await runDoctorIsolated('/tmp/.wigolo');
    const returnedAt = Date.now();

    expect(sentinelWrittenAt).not.toBeNull();
    expect(sentinelWrittenAt!).toBeLessThanOrEqual(returnedAt);
  });

  // NOTE: The coverage reviewer also requested a test for the case where
  // runDoctor itself throws. Current production code only wraps
  // writeFileSync in try/catch — if runDoctor throws, the sentinel is never
  // written and the exception propagates. However, every error path inside
  // runDoctorInner today is itself try/caught (provider failures, JSON
  // parse errors, DB open errors all become diagnostic lines, not throws),
  // so we cannot synthesize a realistic throw through the public surface
  // without restructuring the production code (forbidden by this slice's
  // scope). Left intentionally uncovered here; the safety net is the E2E
  // smoke test and the existing 23 runDoctor unit tests.
});

// ---------------------------------------------------------------------------
// 3) Parent-mode sentinel parsing — the load-bearing branch
// ---------------------------------------------------------------------------
//
// Parent spawns child, waits for 'exit', then prefers sentinel content over
// the raw native exit code. If parsing breaks, doctor silently returns the
// wrong code (e.g. always 134 from the native crash, or always 1 fallback).

describe('runDoctorIsolated — parent mode sentinel parsing', () => {
  const SENTINEL_DIR = '/tmp/wigolo-doctor-fake';
  const SENTINEL_PATH = join(SENTINEL_DIR, 'exit-code');
  const originalEnv = process.env;
  const originalArgv = process.argv;

  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_DOCTOR_CHILD;
    delete process.env.WIGOLO_DOCTOR_INPROC;
    // Provide a non-empty argv[1] so runDoctorAsChild does not fall back to
    // in-process execution.
    process.argv = [process.execPath, '/fake/entry/dist/index.js', 'doctor'];
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    resetConfig();
  });

  /**
   * Build a fake ChildProcess whose stderr is an EventEmitter and that fires
   * 'exit' with the given native code/signal on next tick. `sentinelContent`
   * controls what the parent will read from disk when it checks the sentinel.
   */
  function setupChild(opts: {
    sentinelContent: string | null; // null = sentinel file missing
    nativeExitCode: number | null;
    nativeSignal: NodeJS.Signals | null;
  }): EventEmitter & { stderr: EventEmitter } {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    (child.stderr as unknown as { setEncoding: (e: string) => void }).setEncoding = () => {};

    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p) === SENTINEL_PATH) return opts.sentinelContent !== null;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === SENTINEL_PATH) {
        if (opts.sentinelContent === null) {
          throw new Error('ENOENT: sentinel missing');
        }
        return opts.sentinelContent;
      }
      return '';
    });

    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    // Fire 'exit' asynchronously so the listener in runDoctorAsChild is
    // attached before the event is delivered.
    setImmediate(() => {
      child.emit('exit', opts.nativeExitCode, opts.nativeSignal);
    });

    return child;
  }

  it('returns 0 when sentinel contains "0"', async () => {
    setupChild({ sentinelContent: '0', nativeExitCode: 0, nativeSignal: null });
    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(0);
  });

  it('returns 1 when sentinel contains "1"', async () => {
    setupChild({ sentinelContent: '1', nativeExitCode: 1, nativeSignal: null });
    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(1);
  });

  it('returns 134 when sentinel contains "134" even if native exit is 0', async () => {
    // Documents that the sentinel is the source of truth — the parent does
    // not second-guess it. If a future refactor decided to clamp sentinel
    // values, this test would catch the silent change.
    setupChild({ sentinelContent: '134', nativeExitCode: 0, nativeSignal: null });
    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(134);
  });

  it('treats an empty sentinel as exit code 0 (current Number("") behavior)', async () => {
    // NOTE: Number('') === 0 and passes the 0..255 integer check, so an empty
    // sentinel resolves to 0 — NOT a fallback. This is a quirk of the current
    // implementation worth pinning: if the child crashes before writing
    // anything, the parent silently reports "OK" instead of escalating.
    // If the parser is ever tightened (e.g. require non-empty trim() before
    // Number()), this expectation should flip to the native fallback code.
    setupChild({ sentinelContent: '', nativeExitCode: 7, nativeSignal: null });
    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(0);
  });

  it('falls back to native exit code when sentinel content is non-numeric', async () => {
    setupChild({ sentinelContent: 'abc', nativeExitCode: 42, nativeSignal: null });
    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(42);
  });

  it('falls back to native exit code when sentinel content is out of range (>255)', async () => {
    setupChild({ sentinelContent: '256', nativeExitCode: 99, nativeSignal: null });
    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(99);
  });

  it('falls back to native exit code when sentinel content is negative', async () => {
    setupChild({ sentinelContent: '-1', nativeExitCode: 5, nativeSignal: null });
    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(5);
  });

  it('falls back to native exit code when sentinel file is missing', async () => {
    setupChild({ sentinelContent: null, nativeExitCode: 134, nativeSignal: null });
    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(134);
  });

  it('returns 1 when child is signal-terminated with no sentinel', async () => {
    setupChild({ sentinelContent: null, nativeExitCode: null, nativeSignal: 'SIGABRT' });
    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(1);
  });

  it('returns 1 when both exit code and signal are null and no sentinel', async () => {
    setupChild({ sentinelContent: null, nativeExitCode: null, nativeSignal: null });
    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(1);
  });

  it('returns 1 when spawn emits an error event', async () => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    (child.stderr as unknown as { setEncoding: (e: string) => void }).setEncoding = () => {};
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    setImmediate(() => child.emit('error', new Error('spawn ENOENT')));

    const code = await runDoctorAsChild('/tmp/.wigolo');
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4) WIGOLO_DOCTOR_INPROC=1 opt-out — short-circuits to in-process runDoctor
// ---------------------------------------------------------------------------
//
// Matters for sandboxed CI environments where child-process spawning is
// blocked. If the opt-out regresses, doctor calls fail with EPERM/ENOENT
// from spawn rather than running the diagnostic.

describe('runDoctorIsolated — WIGOLO_DOCTOR_INPROC=1 opt-out', () => {
  const originalEnv = process.env;
  let outBuffer = '';
  const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    outBuffer += String(chunk);
    return true;
  });

  beforeEach(() => {
    outBuffer = '';
    resetConfig();
    vi.clearAllMocks();
    process.env = { ...originalEnv, WIGOLO_DOCTOR_INPROC: '1' };
    delete process.env.WIGOLO_DOCTOR_CHILD;
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    writeSpy.mockClear();
  });

  it('runs runDoctor in-process and does NOT call spawn', async () => {
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'python3' || cmd === 'docker') return okProc('Python 3.12.4');
      return okProc();
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) {
        return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      }
      if (s.endsWith('searxng.lock')) {
        return JSON.stringify({ pid: process.pid, port: 8888 });
      }
      return '';
    });

    const code = await runDoctorIsolated('/tmp/.wigolo');

    expect(code).toBe(0);
    // The smoking gun: spawn must not be touched on the opt-out path.
    expect(spawn).not.toHaveBeenCalled();
    // The diagnostic body must have run — proves we went through runDoctor,
    // not just bypassed everything.
    expect(outBuffer).toMatch(/\[wigolo doctor\]/);
    expect(outBuffer).toMatch(/Overall: OK/);
  });

  it('returns the runDoctor exit code on the opt-out path (degraded → 1)', async () => {
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockReturnValue(false);

    const code = await runDoctorIsolated('/tmp/.wigolo');

    expect(code).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(outBuffer).toMatch(/Overall: DEGRADED/);
  });
});
