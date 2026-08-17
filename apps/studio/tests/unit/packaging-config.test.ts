import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import config, { NATIVE_ASAR_UNPACK, OMIT_ENV, resolveAsarUnpack } from '../../electron-builder.config';

const appPkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const corePkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

describe('asarUnpack native module coverage', () => {
  // Measured on the real artifact (tests/e2e/packaging.spec.ts): with these entries dropped and
  // electron-builder's smartUnpack heuristic off, `onnxruntime-node` dies on
  // `@rpath/libonnxruntime.1.21.0.dylib` and `sharp` on `@rpath/libvips-cpp.8.17.3.dylib`. Each key
  // here is a module whose load has been observed to break without its globs.
  it.each(['onnxruntime-node', 'sharp', 'better-sqlite3', 'sqlite-vec'])('covers %s', (mod) => {
    expect(NATIVE_ASAR_UNPACK[mod]?.length ?? 0).toBeGreaterThan(0);
  });

  it("unpacks sharp's libvips package, not just sharp itself", () => {
    // The binding and the library it needs live in DIFFERENT npm packages —
    // @img/sharp-darwin-arm64 -> @img/sharp-libvips-darwin-arm64. Unpacking only `sharp/**` leaves
    // the binding sealed away from libvips and dlopen fails on @rpath. This is the single easiest
    // entry to "tidy away" while believing sharp is still covered.
    expect(NATIVE_ASAR_UNPACK.sharp).toContain('**/node_modules/@img/**');
  });

  it("unpacks sqlite-vec's platform package, not just the JS wrapper", () => {
    // `getLoadablePath()` returns a path into sqlite-vec-<platform>, and SQLite opens that file
    // itself. Unpacking only the wrapper hands SQLite an absolute path to a file that is not there.
    expect(NATIVE_ASAR_UNPACK['sqlite-vec']).toContain('**/node_modules/sqlite-vec-*/**');
  });

  it('every glob is anchored under node_modules so it cannot swallow app code', () => {
    // A bare `**/onnxruntime-node/**` would also match anything under out/, quietly excluding built
    // app code from the archive.
    for (const globs of Object.values(NATIVE_ASAR_UNPACK)) {
      for (const g of globs) expect(g.startsWith('**/node_modules/')).toBe(true);
    }
  });
});

describe(`${OMIT_ENV} negative-control seam`, () => {
  it('unset means every glob ships', () => {
    const all = Object.values(NATIVE_ASAR_UNPACK).flat();
    expect(resolveAsarUnpack(undefined).sort()).toEqual([...all].sort());
    expect(resolveAsarUnpack('').sort()).toEqual([...all].sort());
  });

  it('drops exactly the named module and keeps the others', () => {
    // The control has to be surgical. If dropping one key also dropped a neighbour, a failing probe
    // would not tell us which glob mattered.
    const got = resolveAsarUnpack('onnxruntime-node');
    expect(got).not.toContain('**/node_modules/onnxruntime-node/**');
    expect(got).toContain('**/node_modules/@img/**');
    expect(got).toContain('**/node_modules/better-sqlite3/**');
  });

  it('drops several when several are named', () => {
    const got = resolveAsarUnpack('onnxruntime-node, sharp');
    expect(got).not.toContain('**/node_modules/onnxruntime-node/**');
    expect(got).not.toContain('**/node_modules/@img/**');
    expect(got).not.toContain('**/node_modules/sharp/**');
    expect(got).toContain('**/node_modules/sqlite-vec/**');
  });

  it('throws on an unknown key instead of silently building a correct artifact', () => {
    // The whole value of a negative control is that it FAILS. A typo'd key that was quietly ignored
    // would build a fully-working app, the probe would pass, and we would record that as proof the
    // glob is unnecessary — the exact wrong conclusion.
    expect(() => resolveAsarUnpack('onnxruntime')).toThrow(/not one of/);
  });
});

describe('dev-channel packaging invariants', () => {
  it('is unsigned, un-notarized and darwin-arm64 only', () => {
    // Signing and the other platforms are S16-final. A build that quietly started signing with an
    // ambient keychain identity would produce an artifact nobody meant to make.
    expect(config.mac?.identity).toBeNull();
    expect(config.mac?.notarize).toBe(false);
    expect(config.mac?.target).toEqual([{ target: 'dir', arch: ['arm64'] }]);
  });

  it('publishes nowhere', () => {
    // A dev artifact must never acquire an auto-update channel by inheriting a default.
    expect(config.publish).toBeNull();
  });

  it('keeps npmRebuild off', () => {
    // Not a preference. better-sqlite3 12.9.0 has no electron-v148 prebuild and does not compile
    // against Electron 43's V8 headers, and @electron/rebuild DELETES the existing binary before it
    // tries — so turning this on both fails the build and leaves the workspace unable to run
    // `npm test`. The DB broker is plain Node (spec §13.7), so the Node-ABI binary is the one that
    // has to ship anyway.
    expect(config.npmRebuild).toBe(false);
  });

  it('keeps the asar archive on', () => {
    // asarUnpack only means anything relative to an archive. `asar: false` would make every probe
    // pass for a reason that tells us nothing about a real build.
    expect(config.asar).toBe(true);
  });

  it('excludes the repository source tree that the wigolo workspace link points at', () => {
    // `wigolo` is `file:../..`, so its package root IS this repo. Without these negations the
    // artifact would seal src/, tests/ and internal-docs/ inside app.asar.
    const files = (config.files as string[]).join('\n');
    for (const dir of ['src', 'tests', 'internal-docs', 'benchmarks']) {
      expect(files).toMatch(new RegExp(`!node_modules/wigolo/\\{[^}]*\\b${dir}\\b`));
    }
  });
});

describe('native dependency pins', () => {
  // These are declared on the app as well as the core because npm's dependency tree does not expand
  // a workspace link, so electron-builder cannot see through `wigolo: file:../..` to collect them.
  // Two declarations means two chances to drift — and a drifted pin would package a DIFFERENT binary
  // than the one the core test suite ran against, with nothing failing until the app is launched.
  it.each(['better-sqlite3', 'sharp', 'sqlite-vec', 'fastembed'])('%s matches the core pin', (dep) => {
    expect(appPkg.dependencies[dep]).toBe(corePkg.dependencies[dep]);
  });

  it('declares every native package the unpack list names', () => {
    // If a module is worth an asarUnpack entry it has to actually be in the artifact; electron-builder
    // only collects packages reachable from the app's own dependency tree. onnxruntime-node arrives
    // through fastembed, which is why fastembed is a direct dependency.
    for (const mod of ['better-sqlite3', 'sharp', 'sqlite-vec']) {
      expect(appPkg.dependencies).toHaveProperty(mod);
    }
    expect(appPkg.dependencies).toHaveProperty('fastembed');
  });
});
