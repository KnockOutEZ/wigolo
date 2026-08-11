import { describe, it, expect } from 'vitest';
import { isInsideAppArchive, isPackagedBinary } from '../../../src/util/packaged.js';

/**
 * The gate that decides whether a loadable extension needs extracting before
 * SQLite's library loader is handed its path.
 *
 * The property under test is NOT "does this string contain .asar" — it is "can
 * the operating system resolve this path". Those differ in exactly one place
 * that matters, and it is the place a careless implementation gets wrong: the
 * `.unpacked` sibling directory is the REMEDY for archived native files, so
 * treating it as archived would divert precisely the files someone had already
 * fixed, and would do it silently.
 */
describe('isInsideAppArchive', () => {
  it('flags a path inside an app archive, because the archive is a file and the OS cannot walk into it', () => {
    expect(
      isInsideAppArchive('/Applications/Wigolo.app/Contents/Resources/app.asar/node_modules/sqlite-vec-darwin-arm64/vec0.dylib')
    ).toBe(true);
  });

  it('does NOT flag the .unpacked sibling — that directory is real, and it is the fix', () => {
    // If this ever returns true, correctly-unpacked extensions get needlessly
    // copied and, worse, the diagnostic starts blaming packaging for a build
    // that was already packaged right.
    expect(
      isInsideAppArchive('/Applications/Wigolo.app/Contents/Resources/app.asar.unpacked/node_modules/sqlite-vec-darwin-arm64/vec0.dylib')
    ).toBe(false);
  });

  it('flags an archive under any name, not just the conventional app.asar', () => {
    // Packaging tools emit more than one archive, so keying on the literal
    // string "app.asar" would miss the others.
    expect(isInsideAppArchive('/opt/x/Resources/node_modules.asar/sqlite-vec/vec0.so')).toBe(true);
  });

  it('flags a Windows-separated archive path, so the guard is not silently macOS/Linux-only', () => {
    expect(
      isInsideAppArchive('C:\\Program Files\\Wigolo\\resources\\app.asar\\node_modules\\sqlite-vec\\vec0.dll')
    ).toBe(true);
  });

  it('leaves an ordinary node_modules path alone, so the npm/source path keeps loading in place', () => {
    expect(isInsideAppArchive('/repo/node_modules/sqlite-vec-darwin-arm64/vec0.dylib')).toBe(false);
  });

  it('does not flag a path merely mentioning asar inside a longer segment', () => {
    // `asar` appearing in a normal directory name must not trigger extraction.
    expect(isInsideAppArchive('/repo/node_modules/asar-tools/vec0.dylib')).toBe(false);
    expect(isInsideAppArchive('/home/quasar/project/vec0.so')).toBe(false);
  });

  it('is independent of the single-file-binary signal, which cannot see an archive at all', () => {
    // The whole defect: an Electron install sets no `process.pkg`, so the old
    // gate was false and the archive path took the failing branch. These two
    // detectors must stay separate answers to separate questions.
    expect(isPackagedBinary()).toBe(false);
    expect(isInsideAppArchive('/x/app.asar/vec0.dylib')).toBe(true);
  });
});
