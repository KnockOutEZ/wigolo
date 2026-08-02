import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Mock the packaged-binary detector so we can drive both branches of the
// sqlite-vec loader without actually running inside a pkg snapshot.
const isPackagedMock = vi.hoisted(() => vi.fn<() => boolean>());
vi.mock('../../../src/util/packaged.js', () => ({
  isPackagedBinary: isPackagedMock,
}));

// Import AFTER the mock is registered.
const { initDatabase, closeDatabase, isVecExtensionLoaded } = await import(
  '../../../src/cache/db.js'
);
const sv = await import('sqlite-vec');

describe('sqlite-vec loading under a packaged binary', () => {
  const dirs: string[] = [];

  // The runtime copies `basename(sv.getLoadablePath())`, which is platform-
  // specific: vec0.dylib (macOS), vec0.so (Linux), vec0.dll/.node (Windows).
  // Derive the expected filename from the same source rather than hardcoding.
  const vecFilename = basename(sv.getLoadablePath());

  beforeEach(() => {
    isPackagedMock.mockReset();
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

  function freshDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-db-vec-'));
    dirs.push(dir);
    return join(dir, 'wigolo.db');
  }

  it('copies the extension out of the snapshot to <dataDir>/native/ and loads it', () => {
    // Simulate running inside the packaged binary. `getLoadablePath()` still
    // resolves to the real installed dylib here (stand-in for the snapshot
    // source), which is what we copy and load from a real path.
    isPackagedMock.mockReturnValue(true);
    const sourcePath = sv.getLoadablePath();

    const dbPath = freshDbPath();
    initDatabase(dbPath);

    // Copy-then-load: the vector extension is active AND a real copy exists in
    // the sibling native/ dir (proving we did NOT dlopen straight from source).
    expect(isVecExtensionLoaded()).toBe(true);
    const nativeCopy = join(dbPath, '..', 'native', vecFilename);
    expect(existsSync(nativeCopy)).toBe(true);
    // The copy matches the source byte-for-byte in size — a real extraction,
    // not an empty stub — so loadExtension had a genuine dylib to dlopen.
    expect(statSync(nativeCopy).size).toBe(statSync(sourcePath).size);
  });

  it('re-uses the existing copy on a warm start (no re-copy when size matches)', () => {
    isPackagedMock.mockReturnValue(true);
    const dbPath = freshDbPath();

    initDatabase(dbPath);
    const nativeCopy = join(dbPath, '..', 'native', vecFilename);
    const firstMtime = statSync(nativeCopy).mtimeMs;
    closeDatabase();

    // Second init against the same data dir: the copy already exists with the
    // right size, so it must not be rewritten (mtime unchanged).
    initDatabase(dbPath);
    expect(statSync(nativeCopy).mtimeMs).toBe(firstMtime);
    expect(isVecExtensionLoaded()).toBe(true);
  });

  it('never creates native/ on the npm/source path (not packaged)', () => {
    // Default source path: load straight via sqlite-vec, never copy.
    isPackagedMock.mockReturnValue(false);

    const dbPath = freshDbPath();
    initDatabase(dbPath);

    expect(isVecExtensionLoaded()).toBe(true);
    const nativeDir = join(dbPath, '..', 'native');
    expect(existsSync(nativeDir)).toBe(false);
  });
});
