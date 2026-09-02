import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { writeLargeOutput, excerptToFile } from '../../../src/server/large-output.js';

/**
 * PIN 8's fourth lesson (#57): large output goes to a file, and the result inlines an excerpt plus
 * the PATH — law 11's half of the rule, which a retrieval ref alone does not satisfy.
 *
 * The run id becomes a path segment, so it is treated as untrusted input here rather than as a
 * well-formed id: the arms below hold the sanitizer to escaping the directory it is given, not to
 * being called by well-behaved callers.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wigolo-large-output-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeLargeOutput', () => {
  it('writes the payload under the run’s own output directory and returns the path', () => {
    const r = writeLargeOutput({ hello: 'world' }, { dataDir: dir, runId: 'r7fq2', kind: 'settle-diff' });
    expect(r.file).toContain(join('studio', 'runs', 'r7fq2', 'output'));
    expect(r.file.endsWith('.json')).toBe(true);
    expect(JSON.parse(readFileSync(r.file, 'utf-8'))).toEqual({ hello: 'world' });
    expect(r.bytes).toBeGreaterThan(0);
  });

  it('names the file after the kind, so a run’s directory is readable by a human', () => {
    const r = writeLargeOutput([1, 2], { dataDir: dir, runId: 'r7fq2', kind: 'console' });
    expect(r.file.split(sep).pop()).toMatch(/^console-[0-9a-f]{16}\.json$/);
  });

  it('is content-addressed: the same payload twice is one file, not an ever-growing pile', () => {
    const a = writeLargeOutput({ n: 1 }, { dataDir: dir, runId: 'r7fq2', kind: 'find' });
    const b = writeLargeOutput({ n: 1 }, { dataDir: dir, runId: 'r7fq2', kind: 'find' });
    const c = writeLargeOutput({ n: 2 }, { dataDir: dir, runId: 'r7fq2', kind: 'find' });
    expect(b.file).toBe(a.file);
    expect(c.file).not.toBe(a.file);
  });

  // POSIX mode bits only: Windows reports 0o666 for every file, so the assertion below measures the
  // platform rather than the code. `chmod` is still called there; it is a documented no-op.
  it.skipIf(process.platform === 'win32')('writes owner-only, like every other studio artefact on disk', () => {
    const r = writeLargeOutput({ secret: 'ish' }, { dataDir: dir, runId: 'r7fq2', kind: 'find' });
    expect(statSync(r.file).mode & 0o777).toBe(0o600);
  });

  it('puts an unattributed write in a directory that SAYS it is unattributed', () => {
    // Law 1 makes the run the unit of everything; a caller with no run id yet is a visible gap in
    // the path rather than an invisible one in a shared pool.
    for (const runId of [undefined, '', '///']) {
      const r = writeLargeOutput({ x: 1 }, { dataDir: dir, runId, kind: 'find' });
      expect(r.file).toContain(join('runs', 'unattributed', 'output'));
    }
  });

  it('cannot be walked out of its directory by a hostile run id', () => {
    const r = writeLargeOutput({ x: 1 }, { dataDir: dir, runId: '../../../../etc', kind: 'find' });
    expect(r.file).not.toContain('..');
    expect(r.file.startsWith(join(dir, 'studio', 'runs'))).toBe(true);
    expect(existsSync(r.file)).toBe(true);
  });

  it('bounds an absurdly long run id rather than handing it to the filesystem', () => {
    const r = writeLargeOutput({ x: 1 }, { dataDir: dir, runId: 'z'.repeat(400), kind: 'find' });
    const segment = r.file.split(sep).slice(-2)[0] === 'output' ? r.file.split(sep).slice(-3)[0] : '';
    expect(segment.length).toBeLessThanOrEqual(64);
  });
});

describe('excerptToFile', () => {
  const opts = () => ({ dataDir: dir, runId: 'r7fq2', kind: 'find' });

  it('writes nothing when the set fits — the excerpt IS the whole set', () => {
    const r = excerptToFile([1, 2, 3], 3, opts());
    expect(r.inline).toEqual([1, 2, 3]);
    expect(r.spilled).toBe(0);
    expect(r.file).toBeUndefined();
  });

  it('inlines the head and writes the WHOLE set, not the tail', () => {
    // A file that held only the remainder would force a reader to stitch two halves back together
    // to see what actually happened; the file is a complete artefact on its own.
    const items = Array.from({ length: 10 }, (_, i) => `row ${i}`);
    const r = excerptToFile(items, 4, opts());
    expect(r.inline).toEqual(['row 0', 'row 1', 'row 2', 'row 3']);
    expect(r.spilled).toBe(6);
    expect(JSON.parse(readFileSync(r.file as string, 'utf-8'))).toEqual(items);
  });

  it('copies the inline excerpt rather than aliasing the caller’s array', () => {
    const items = [1, 2];
    const r = excerptToFile(items, 5, opts());
    expect(r.inline).not.toBe(items);
    expect(r.inline).toEqual(items);
  });
});
