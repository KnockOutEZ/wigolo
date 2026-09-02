import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStudioSetup } from '../../../src/cli/studio-setup.js';
import { parseCommand } from '../../../src/cli/index.js';

/**
 * `wigolo studio setup` — the stub the extraction shipped, and the route it is wired to.
 *
 * Every arm goes through `parseCommand`, never a hand-built argv. The first cut of this file passed
 * `['studio', 'setup']` and was green while the real CLI answered its own usage block and exited 1,
 * because the parser strips the verb before the handler sees it. A test that invents the argv shape
 * cannot catch that.
 *
 * The verb is filled in next (download, verify, install, first-run pairing). What is pinned here is
 * the part that must be true from the moment the domain layer left: the verb EXISTS and answers, so
 * a user who runs the one command the CLI now advertises for the companion gets an answer rather
 * than `Unknown command`. The route arm is structural on purpose — a stub whose route was never
 * wired would pass every behavioural test in this file and still be unreachable.
 */

const SRC = resolve(fileURLToPath(new URL('../../../src', import.meta.url)));

function captured(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true; });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true; });
  return { out, err, restore: () => { o.mockRestore(); e.mockRestore(); } };
}

describe('wigolo studio setup (stub)', () => {
  it('answers `setup` with an exit code of 0 and says what will happen', async () => {
    const cap = captured();
    try {
      expect(await runStudioSetup(parseCommand(['studio', 'setup']).args)).toBe(0);
    } finally {
      cap.restore();
    }
    expect(cap.out.join('')).toMatch(/companion/i);
  });

  it('refuses an unknown subcommand with a non-zero code and the usage block', async () => {
    const cap = captured();
    try {
      expect(await runStudioSetup(parseCommand(['studio', 'observe']).args)).toBe(1);
    } finally {
      cap.restore();
    }
    expect(cap.err.join('')).toContain('Unknown subcommand');
    expect(cap.err.join('')).toContain('wigolo studio setup');
  });

  it('names no session or flow verb — those went with the companion', async () => {
    const cap = captured();
    try {
      await runStudioSetup(parseCommand(['studio']).args);
    } finally {
      cap.restore();
    }
    const usage = cap.out.join('') + cap.err.join('');
    for (const gone of ['studio_', 'wigolo flow', 'observe', 'marks']) {
      expect(usage, `usage still advertises '${gone}'`).not.toContain(gone);
    }
  });

  it('is what the parser routes `studio setup` to, and reports the arriving install path', async () => {
    const parsed = parseCommand(['studio', 'setup']);
    expect(parsed.command).toBe('studio');
    expect(parsed.args).toEqual(['setup']);
    const cap = captured();
    try {
      expect(await runStudioSetup(parsed.args)).toBe(0);
    } finally {
      cap.restore();
    }
    expect(cap.out.join('')).toMatch(/arriving/i);
  });

  it('leaves `flow` an unknown command rather than a verb that exits 0 in silence', () => {
    // It was in the parser's known set with no case left in the switch, so it fell through the
    // whole routing table and the process exited 0 having done and said nothing.
    expect(parseCommand(['flow', 'list']).command).toBe('unknown');
  });

  it('is the verb `studio` routes to — and `flow` routes nowhere at all', () => {
    // mutation: drop the `case 'studio'` block from index.ts → the first two assertions red.
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(index).toContain("case 'studio':");
    expect(index).toContain('runStudioSetup(args)');
    expect(index).not.toContain("case 'flow':");
    // The MCP `setup` verb is a DIFFERENT route and must survive untouched beside this one.
    expect(index).toContain("case 'setup':");
  });
});
