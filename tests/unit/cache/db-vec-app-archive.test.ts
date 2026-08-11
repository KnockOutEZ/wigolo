import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { writeAppArchive } from '../../helpers/app-archive.js';

/**
 * sqlite-vec loading when the extension ships inside a desktop-app archive.
 *
 * WHY THESE TESTS EXIST AT ALL. The loader already had a copy-the-file-out
 * branch, but it was gated on the single-file-binary signal (`process.pkg`),
 * which is undefined in a desktop app — so an archived extension took the
 * straight-load branch and handed SQLite a path the OS cannot resolve. Every
 * existing test for this loader runs from a loose directory, where that gate is
 * unobservable, which is precisely how the defect shipped. So these build a
 * REAL archive (a single file, per tests/helpers/app-archive.ts) and let the
 * real `ENOTDIR` happen.
 *
 * THE TWO HOSTS DIFFER, and both are covered here because the remedy differs:
 *   - a plain background process (where the cache database actually runs —
 *     better-sqlite3 is built for the Node ABI, so the desktop shell spawns a
 *     plain child for it) has NO archive-aware filesystem layer. An archived
 *     extension is unreachable there, full stop, and copying out cannot rescue
 *     it. The only fix is to ship the file outside the archive, so the test
 *     asserts the diagnostic SAYS that.
 *   - the desktop shell's own process patches `fs` and CAN read into the
 *     archive, so there the copy-out succeeds and the extension loads.
 */

// Real archives are files; the loader must ask sqlite-vec where its artifact
// lives, so that is the seam we steer. `load` stays real — nothing about the
// actual extension is faked, only WHERE we claim to have found it.
const loadablePathMock = vi.hoisted(() => vi.fn<() => string>());
vi.mock('sqlite-vec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sqlite-vec')>();
  return { ...actual, getLoadablePath: loadablePathMock };
});

const warnMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: warnMock, error: vi.fn() }),
}));

const { initDatabase, closeDatabase, isVecExtensionLoaded } = await import(
  '../../../src/cache/db.js'
);
// Deliberately the UNMOCKED module — we need the extension's true on-disk
// location to build a real archive around it.
const actualSv = await vi.importActual<typeof import('sqlite-vec')>('sqlite-vec');

describe('sqlite-vec inside a desktop-app archive', () => {
  const dirs: string[] = [];
  // Resolved from sqlite-vec itself: vec0.dylib / vec0.so / vec0.dll by platform.
  const realExtensionPath = actualSv.getLoadablePath();
  const vecFilename = basename(realExtensionPath);

  beforeEach(() => {
    loadablePathMock.mockReset();
    loadablePathMock.mockReturnValue(realExtensionPath);
    warnMock.mockReset();
  });

  afterEach(() => {
    closeDatabase();
    while (dirs.length) {
      try {
        rmSync(dirs.pop()!, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-asar-vec-'));
    dirs.push(dir);
    return dir;
  }

  function warnedAbout(): string {
    return warnMock.mock.calls.map((c) => JSON.stringify(c)).join('\n');
  }

  it('reports an archived extension as a PACKAGING fault, naming the archive and the remedy', () => {
    // A real archive: `app.asar` is a FILE, so the path below has a file where a
    // directory would need to be and the OS returns ENOTDIR — the genuine
    // production failure, not a simulated one.
    const dir = freshDir();
    const archivePath = join(dir, 'app.asar');
    writeAppArchive(archivePath, [
      { name: 'marker.txt', content: 'archive-ok' },
      { name: vecFilename, sourcePath: realExtensionPath },
    ]);
    loadablePathMock.mockReturnValue(join(archivePath, vecFilename));

    initDatabase(join(dir, 'wigolo.db'));

    // Degrades rather than crashing the process — vector search off, FTS5 fine.
    expect(isVecExtensionLoaded()).toBe(false);

    const warned = warnedAbout();
    // The whole point of the change: the operator must be able to tell a
    // packaging defect from a broken install. Before this, the message was an
    // OS-level "library not loaded" that named neither the archive nor the fix.
    expect(warned).toContain('app.asar');
    expect(warned).toMatch(/packaging problem/i);
    expect(warned).toMatch(/asarUnpack/i);
    // …and it must actively contradict the wrong conclusion, since "reinstall"
    // is what someone reaches for when a library fails to load.
    expect(warned).toMatch(/reinstalling will not change it/i);
  });

  it('records the offending path and archive verdict on the warning, so a log alone is diagnosable', () => {
    const dir = freshDir();
    const archivePath = join(dir, 'app.asar');
    writeAppArchive(archivePath, [{ name: vecFilename, sourcePath: realExtensionPath }]);
    loadablePathMock.mockReturnValue(join(archivePath, vecFilename));

    initDatabase(join(dir, 'wigolo.db'));

    const payload = warnMock.mock.calls.find((c) => c[0]?.includes('sqlite-vec'))?.[1];
    expect(payload).toBeDefined();
    expect(payload.extensionPath).toContain('app.asar');
    expect(payload.insideAppArchive).toBe(true);
  });

  it('extracts and loads when the host CAN read the archive, and vector search really works', () => {
    // Stands in for the desktop shell's archive-aware `fs`: from that process a
    // path inside the archive IS readable, so `copyFileSync` succeeds. A real
    // directory named `*.asar` reproduces exactly that readability while keeping
    // the test in plain Node — measured separately, the shell's patched `fs`
    // does copy a byte-identical file out of a genuine archive.
    const dir = freshDir();
    const archiveDir = join(dir, 'app.asar');
    mkdirSync(archiveDir, { recursive: true });
    const inArchive = join(archiveDir, vecFilename);
    copyFileSync(realExtensionPath, inArchive);
    loadablePathMock.mockReturnValue(inArchive);

    const dbPath = join(dir, 'wigolo.db');
    const db = initDatabase(dbPath);

    // Routed to copy-out, not loaded in place.
    expect(isVecExtensionLoaded()).toBe(true);
    const extracted = join(dir, 'native', vecFilename);
    expect(existsSync(extracted)).toBe(true);
    expect(statSync(extracted).size).toBe(statSync(realExtensionPath).size);

    // The extension is genuinely functional, not merely "did not throw": a vec0
    // virtual table exercises the extension's own registered module, which only
    // exists if the copied file really was dlopen'd and its init symbol ran.
    // (rowid is bound as BigInt because vec0 rejects a float-typed primary key,
    // and better-sqlite3 binds a plain JS number as REAL.)
    db.exec('create virtual table vt using vec0(embedding float[4])');
    db.prepare('insert into vt(rowid, embedding) values (?, ?)').run(
      1n,
      Buffer.from(new Float32Array([1, 2, 3, 4]).buffer)
    );
    expect(db.prepare('select count(*) as c from vt').get()).toEqual({ c: 1 });
  });

  it('still loads in place from an ordinary directory, so the npm/source path is untouched', () => {
    const dir = freshDir();
    initDatabase(join(dir, 'wigolo.db'));

    expect(isVecExtensionLoaded()).toBe(true);
    // No extraction: copying on the normal path would be pure overhead.
    expect(existsSync(join(dir, 'native'))).toBe(false);
  });

  it('does not divert the .unpacked sibling, which is the correctly-packaged case', () => {
    // Regression guard for the subtle half of the gate: `app.asar.unpacked` is a
    // real directory that packaging tools emit as the FIX. If the detector
    // treated it as archived, an already-correct build would start copying and
    // the diagnostic would blame packaging that was right.
    const dir = freshDir();
    const unpacked = join(dir, 'app.asar.unpacked');
    mkdirSync(unpacked, { recursive: true });
    const target = join(unpacked, vecFilename);
    copyFileSync(realExtensionPath, target);
    loadablePathMock.mockReturnValue(target);

    initDatabase(join(dir, 'wigolo.db'));

    expect(isVecExtensionLoaded()).toBe(true);
    expect(existsSync(join(dir, 'native'))).toBe(false);
  });
});
