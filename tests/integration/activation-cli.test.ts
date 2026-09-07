/**
 * The three process-entry surfaces on an UNREGISTERED install (PX brief §0a.1,
 * issue #336): one-shot tool runs, the REPL, and `serve`.
 *
 * WHAT THIS FILE USED TO PIN. Under PX2 each of these three checked activation
 * once at process entry and stopped: a one-shot exited 1 with the refusal on
 * stderr, the REPL returned `failures: 1` before readline ever attached, and
 * `serve` called `process.exit(1)` before binding. §0a.1 made the hard gate
 * Studio-only, so all three now start and run with no account, and every arm
 * below is the inverse of the one it replaced.
 *
 * WHY EACH ARM IS STILL WORTH ITS SECONDS. The three surfaces had three DIFFERENT
 * refusal shapes — an exit code, a returned failure count, and a `process.exit`
 * — so a gate left behind in any one of them fails differently and would be
 * invisible to a sweep over the other two. `serve` is the sharpest: its refusal
 * was a real `process.exit(1)` before the listener, which is indistinguishable
 * from a crash unless something asserts the bind path is reached.
 *
 * The unregistered condition is real: a fresh temp data dir with no account
 * state, evaluated by the shipped disk-backed checker. The suite as a whole runs
 * activated (tests/setup.ts), which is why each arm resets the checker first.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../src/config.js';
import { ACTIVATION_REFUSALS } from '../../src/account/gate.js';
import { setActivationChecker } from '../../src/server/activation.js';
import { installActivated } from '../unit/server/activation-fixture.js';
import { runTool } from '../../src/cli/tool-run.js';
import { startShell } from '../../src/repl/shell.js';
import { runDaemon } from '../../src/cli/daemon.js';
import type { ReplDeps } from '../../src/repl/commands/types.js';

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/** Capture direct `process.stderr.write` calls (runTool and serve write there). */
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return { text: () => chunks.join(''), restore: () => { process.stderr.write = original; } };
}

describe('CLI one-shots, REPL and serve — unregistered', () => {
  let dataDir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-activation-cli-'));
    savedDataDir = process.env.WIGOLO_DATA_DIR;
    process.env.WIGOLO_DATA_DIR = dataDir;
    resetConfig();
    setActivationChecker(null);
  });

  afterEach(() => {
    setActivationChecker(null);
    if (savedDataDir === undefined) delete process.env.WIGOLO_DATA_DIR;
    else process.env.WIGOLO_DATA_DIR = savedDataDir;
    resetConfig();
    vi.restoreAllMocks();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('a one-shot tool run executes with no account and exits 0', async () => {
    // `cache stats` is the one of the ten that reaches a real handler and answers
    // entirely from local state, so this arm can assert the STRONG thing — exit 0,
    // a real result — instead of merely "no refusal was printed". Under PX2 this
    // exact call exited 1 with the refusal and never reached the handler: `cache`
    // was gated like every other tool, because locality is irrelevant to a
    // predicate about which handlers exist.
    const out: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => { out.push(c.toString()); return true; }) as typeof process.stdout.write;
    const err = captureStderr();
    try {
      const code = await runTool('cache', ['stats']);
      expect(code).toBe(0);
      for (const line of Object.values(ACTIVATION_REFUSALS)) {
        expect(err.text()).not.toContain(line);
      }
      expect(out.join('').length).toBeGreaterThan(0);
    } finally {
      err.restore();
      process.stdout.write = originalOut;
    }
  });

  it('`--help` still works unregistered — it always did, and still must', async () => {
    const outChunks: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => { outChunks.push(c.toString()); return true; }) as typeof process.stdout.write;
    const err = captureStderr();
    try {
      const code = await runTool('search', ['--help']);
      expect(code).toBe(0);
      for (const line of Object.values(ACTIVATION_REFUSALS)) {
        expect(err.text()).not.toContain(line);
        expect(outChunks.join('')).not.toContain(line);
      }
    } finally {
      err.restore();
      process.stdout.write = originalOut;
    }
  });

  it('the REPL attaches readline and prints its banner with no account', async () => {
    // The banner is printed by the readline path, which PX2's check returned
    // ABOVE. Its presence is the proof the shell was really built, and
    // `failures: 0` is the proof nothing counted the startup as a failed run.
    const err = sink();
    const out = sink();
    const result = await startShell({} as ReplDeps, {
      input: Readable.from(['exit\n']),
      output: out.stream,
      errorOutput: err.stream,
    });
    expect(result.failures).toBe(0);
    expect(err.text()).toContain('wigolo interactive shell');
    for (const line of Object.values(ACTIVATION_REFUSALS)) {
      expect(err.text()).not.toContain(line);
    }
  });

  it('a registered REPL starts IDENTICALLY — the arm above is about the gate', async () => {
    // THE OUTSIDE SIGNAL. "The unregistered shell started" is only interesting
    // next to a registered one that starts the same way; without this arm a shell
    // that had stopped gating because it had stopped working would read as a pass.
    const restore = installActivated();
    const err = sink();
    const out = sink();
    try {
      const result = await startShell({} as ReplDeps, {
        input: Readable.from(['exit\n']),
        output: out.stream,
        errorOutput: err.stream,
      });
      expect(result.failures).toBe(0);
      expect(err.text()).toContain('wigolo interactive shell');
    } finally {
      restore();
    }
  });

  it('`serve` starts with no account — it never calls process.exit on activation', () => {
    // THE SHARPEST OF THE THREE. PX2's refusal here was a real `process.exit(1)`
    // before the listener existed. `runDaemon` is left to run into its own bind
    // path, and the assertions are that the exit spy was not called with 1 and
    // that the bind-gate banner — the line printed strictly BELOW where the check
    // used to sit — actually reached stderr.
    const err = captureStderr();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      runDaemon([]);
      expect(exit).not.toHaveBeenCalledWith(1);
      expect(err.text()).toContain('Starting daemon on');
      for (const line of Object.values(ACTIVATION_REFUSALS)) {
        expect(err.text()).not.toContain(line);
      }
    } finally {
      exit.mockRestore();
      err.restore();
    }
  });
});
