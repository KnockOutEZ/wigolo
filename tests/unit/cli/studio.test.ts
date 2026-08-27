import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStudio, type StudioChild } from '../../../src/cli/studio.js';
import { SUBSTRATE_RECORD } from '../../../src/studio/substrate-acquire.js';

/**
 * `wigolo studio` is the HUMAN asking for the desktop component, so it launches the acquired
 * substrate visibly and declines in one line when nothing is installed.
 *
 * It used to spawn `npm run dev -w apps/studio`. The studio repo split deleted that workspace and
 * the `workspaces` key with it, so the spawn kept SUCCEEDING (npm starts, then writes
 * `No workspaces found: --workspace=apps/studio` to stderr and exits) — `child.on('error')` never
 * fires for that, which is exactly why the rot survived the split. Every pin below is written
 * against the spawn ARGUMENTS for that reason: a launch that "worked" is not evidence.
 */

interface SpawnCall {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; detached?: boolean };
}

function fakeSpawn(calls: SpawnCall[]): (c: string, a: string[], o: SpawnCall['options']) => StudioChild {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { on: () => undefined, unref: () => undefined };
  };
}

/** Plant a valid acquisition record — valid means the executable it names is really on disk. */
function plantRecord(dataDir: string, executable = 'wigolo-studio'): string {
  const substrateDir = join(dataDir, 'installed');
  mkdirSync(substrateDir, { recursive: true });
  writeFileSync(join(substrateDir, executable), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  mkdirSync(join(dataDir, 'substrate'), { recursive: true });
  writeFileSync(
    join(dataDir, 'substrate', SUBSTRATE_RECORD),
    JSON.stringify({
      version: '0.1.0',
      executable,
      path: substrateDir,
      platform: process.platform,
      arch: process.arch,
      acquiredAt: '2026-08-27T00:00:00.000Z',
      source: 'local-path',
    }),
  );
  return join(substrateDir, executable);
}

describe('runStudio — the acquired substrate is the only launch target', () => {
  let dataDir: string;
  let calls: SpawnCall[];
  let lines: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wig-runstudio-'));
    calls = [];
    lines = [];
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.WIGOLO_STUDIO_HIDDEN;
  });

  it('with a record present, spawns the executable the record names — never npm', () => {
    const exe = plantRecord(dataDir);

    runStudio([], { dataDir, spawnFn: fakeSpawn(calls), log: (m) => lines.push(m) });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(exe);
    expect(calls[0].command).not.toBe('npm');
    // The workspace invocation, spelled out: resurrecting it REDs here even if the record read stays.
    expect(calls[0].args).not.toContain('-w');
    expect(calls[0].args).not.toContain('apps/studio');
  });

  it('launches VISIBLE — the hidden flag is stripped even when the caller inherited it', () => {
    // Auto-launch is hidden because it serves the agent. This rung is the human asking, so a
    // WIGOLO_STUDIO_HIDDEN already in the shell must not silently swallow the window they asked
    // for. Passing `process.env` straight through REDs this.
    process.env.WIGOLO_STUDIO_HIDDEN = '1';
    plantRecord(dataDir);

    runStudio([], { dataDir, spawnFn: fakeSpawn(calls), log: (m) => lines.push(m) });

    expect(calls).toHaveLength(1);
    expect(calls[0].options.env).toBeDefined();
    expect(calls[0].options.env?.WIGOLO_STUDIO_HIDDEN).toBeUndefined();
  });

  it('with no record, declines in ONE actionable line and spawns nothing', () => {
    runStudio([], { dataDir, spawnFn: fakeSpawn(calls), log: (m) => lines.push(m) });

    expect(calls).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/not installed|no .*installed/i);
    // Actionable: it names the command that installs it, so the decline is not a dead end.
    expect(lines[0]).toContain('wigolo warmup');
  });

  it('a record whose executable has been deleted reads as absent — decline, no spawn', () => {
    // `readSubstrateRecord` validates the executable on disk; this pin fails if runStudio ever
    // starts trusting the JSON alone and hands a missing path to spawn.
    const exe = plantRecord(dataDir);
    rmSync(exe);

    runStudio([], { dataDir, spawnFn: fakeSpawn(calls), log: (m) => lines.push(m) });

    expect(calls).toHaveLength(0);
    expect(lines).toHaveLength(1);
  });

  it('user-facing text stays in capability language and reports the acquired version', () => {
    plantRecord(dataDir);
    runStudio([], { dataDir, spawnFn: fakeSpawn(calls), log: (m) => lines.push(m) });
    runStudio([], { dataDir: join(dataDir, 'empty'), spawnFn: fakeSpawn([]), log: (m) => lines.push(m) });

    expect(lines).toHaveLength(2);
    // Not a vacuous word-ban: the launch line has to come from the record it just read.
    expect(lines[0]).toContain('0.1.0');
    for (const line of lines) {
      expect(line).not.toMatch(/electron|playwright|chromium|npm run dev/i);
    }
  });
});

describe('runStudio — the deleted workspace leaves no residue in the source', () => {
  it('src/cli/studio.ts references no apps/ workspace and no -w flag', () => {
    // The split left ZERO workspace surface: there is no `workspaces` key and no `apps/` on this
    // branch, so any such string here is a path that can only fail. Grep-shaped on purpose — the
    // defect was a second call site the behavioural tests did not reach.
    const src = readFileSync(new URL('../../../src/cli/studio.ts', import.meta.url), 'utf-8');
    expect(src).not.toContain('apps/studio');
    expect(src).not.toMatch(/'-w'|"-w"/);
  });
});
