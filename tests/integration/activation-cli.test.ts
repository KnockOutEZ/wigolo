/**
 * The activation gate at the three process-entry surfaces (PX2 mini-spec §3):
 * one-shot tool runs, the REPL, and `serve`.
 *
 * These three are short-lived or human-invoked, so unlike MCP they do not serve
 * and then refuse per call — mini-spec §3 pins a single check at entry. What the
 * arms below actually protect:
 *
 *   - `--help` stays open. Help is not a tool call, and an install that cannot
 *     tell you what a command does cannot tell you how to fix itself either.
 *   - The REPL refuses before readline attaches, so an un-activated shell is
 *     never a prompt that rejects everything typed into it.
 *   - `serve` refuses to START. The operator is at a terminal; a daemon that came
 *     up and 403'd every request would be the same outcome, discovered later,
 *     from a different machine.
 *
 * The un-activated condition is real: a fresh temp data dir with no account
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

const REFUSAL = ACTIVATION_REFUSALS.never_activated;

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

describe('activation gate — CLI one-shots, REPL and serve', () => {
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

  it('a one-shot tool run exits 1 with the pinned line on stderr', async () => {
    const err = captureStderr();
    try {
      const code = await runTool('search', ['anything']);
      expect(code).toBe(1);
      expect(err.text()).toContain(REFUSAL);
    } finally {
      err.restore();
    }
  });

  it('`--help` still works un-activated — help is not a tool call', async () => {
    const outChunks: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => { outChunks.push(c.toString()); return true; }) as typeof process.stdout.write;
    const err = captureStderr();
    try {
      const code = await runTool('search', ['--help']);
      expect(code).toBe(0);
      expect(err.text()).not.toContain(REFUSAL);
      expect(outChunks.join('')).not.toContain(REFUSAL);
    } finally {
      err.restore();
      process.stdout.write = originalOut;
    }
  });

  it('the REPL refuses before readline attaches — no prompt that rejects everything', async () => {
    const err = sink();
    const out = sink();
    const result = await startShell({} as ReplDeps, {
      input: Readable.from(['exit\n']),
      output: out.stream,
      errorOutput: err.stream,
    });
    expect(result.failures).toBe(1);
    expect(err.text()).toContain(REFUSAL);
    // The banner is printed by the readline path, which must never be reached.
    expect(err.text()).not.toContain('wigolo interactive shell');
  });

  it('an activated REPL starts normally — the refusal above is the gate, not a broken shell', async () => {
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
      expect(err.text()).not.toContain(REFUSAL);
    } finally {
      restore();
    }
  });

  it('`serve` refuses to start: one line on stderr, exit 1, no listener', () => {
    const err = captureStderr();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      runDaemon([]);
      expect(exit).toHaveBeenCalledWith(1);
      expect(err.text()).toContain(REFUSAL);
      // It refuses BEFORE the bind-gate banner — nothing was started to be torn down.
      expect(err.text()).not.toContain('Starting daemon on');
    } finally {
      exit.mockRestore();
      err.restore();
    }
  });
});
