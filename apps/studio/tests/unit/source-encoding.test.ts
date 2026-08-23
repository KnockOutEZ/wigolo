import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * WHY this sweep exists.
 *
 * `TabStrip.tsx` carried a literal NUL byte inside a string literal for weeks. The byte is invisible in
 * an editor and harmless at runtime — but git classifies a file containing one as BINARY. `git diff`
 * printed `Bin 2180 -> 4619 bytes` with no hunks, `--stat` reported 0 insertions, `git grep` answered
 * `Binary file matches`, and every content-level sweep in this repo — including the token sweep next
 * door, which reads from disk and so was the one thing that still saw it — skipped or under-reported it.
 * Every diff-based review of that file since the byte landed was reviewing nothing.
 *
 * So the defect class is not "a NUL is wrong". It is: a source file can silently stop being reviewable.
 * The guard therefore asserts a property of the BYTES ON DISK across the whole tracked tree, not a
 * property of one file — the file that goes dark next will be a different one.
 *
 * Below 0x09 is the range that matters: 0x00 is what makes git call a file binary, and 0x01–0x08 are
 * equally unprintable and have no business in source. TAB (0x09), LF (0x0A) and CR (0x0D) are legal and
 * deliberately not swept — CRLF/BOM policy is a separate question this guard does not answer.
 */
const FORBIDDEN_MAX_BYTE = 0x08;

const REPO_ROOT = join(import.meta.dirname, '../../../..');

/**
 * ENUMERATED FROM GIT, not listed. A hand-maintained list of files cannot fail when a file is added to
 * the tree, which is exactly how the byte survived: it lived in a file nobody thought to name. Asking
 * git for the tracked set means a new renderer component, a new preload, a new migration and a new
 * package are all swept the day they land, with no edit here.
 */
const SWEPT_TREES = ['src', 'apps'] as const;

/**
 * Tracked binary ASSETS (an icon, a font) would legitimately contain these bytes. There are none today,
 * and that is load-bearing: an empty allowlist means the sweep covers literally every tracked file under
 * `src/` and `apps/`. Adding an asset costs one deliberate line here — which is the point. A silent
 * extension filter would instead let the next `.icns` in, and the one after it that is really a source
 * file with a wrong name.
 */
const BINARY_ASSET_ALLOWLIST: readonly string[] = [];

/** The floor that stops this whole file from passing vacuously if `git ls-files` ever returns nothing. */
const MINIMUM_SWEPT_FILES = 500;

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SWEPT_TREES], {
    cwd: REPO_ROOT,
    encoding: 'buffer',
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0)
    .filter((p) => !BINARY_ASSET_ALLOWLIST.includes(p));
}

interface ControlByteHit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly byte: string;
}

/**
 * The guard itself, as a pure function over bytes so the red probe below can run it against a file that
 * is NOT in the repo. A guard that can only be pointed at the tree it is supposed to police can never be
 * shown to fire.
 */
export function findControlBytes(path: string, contents: Buffer): ControlByteHit[] {
  const hits: ControlByteHit[] = [];
  let line = 1;
  let column = 1;
  for (const byte of contents) {
    if (byte <= FORBIDDEN_MAX_BYTE) {
      hits.push({ path, line, column, byte: `0x${byte.toString(16).padStart(2, '0')}` });
    }
    if (byte === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return hits;
}

describe('tracked source files stay reviewable', () => {
  it('sweeps the whole tracked tree, not a list — the floor proves the enumeration resolved', () => {
    expect(trackedFiles().length).toBeGreaterThanOrEqual(MINIMUM_SWEPT_FILES);
  });

  it('contains no control byte below 0x09 — one makes git treat the source as binary and every diff blind', () => {
    const hits = trackedFiles().flatMap((rel) =>
      findControlBytes(rel, readFileSync(join(REPO_ROOT, rel))),
    );
    expect(
      hits.map((h) => `${h.path}:${h.line}:${h.column} contains ${h.byte}`),
      'write the character as an escape sequence instead of the raw byte',
    ).toEqual([]);
  });

  it('fires on a planted NUL — the guard is capable of failing', () => {
    const fixture = join(mkdtempSync(join(tmpdir(), 'wigolo-nul-probe-')), 'planted.tsx');
    writeFileSync(fixture, Buffer.from('const key = \'\x00human\';\n', 'utf8'));

    const hits = findControlBytes('planted.tsx', readFileSync(fixture));

    expect(hits).toEqual([{ path: 'planted.tsx', line: 1, column: 14, byte: '0x00' }]);
  });

  it('accepts tab, newline and carriage return — the sweep is not a whitespace policy', () => {
    expect(findControlBytes('ok.ts', Buffer.from('a\tb\r\nc\n', 'utf8'))).toEqual([]);
  });
});
