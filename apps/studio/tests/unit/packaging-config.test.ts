import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import config, {
  ASAR_UNPACK,
  BROKER_ASAR_UNPACK,
  NATIVE_ASAR_UNPACK,
  OMIT_CLOSURE_ENV,
  OMIT_ENV,
  resolveAsarUnpack,
  wigoloRuntimeClosure,
} from '../../electron-builder.config';

const appPkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * The core package's manifest, read through the INSTALLED package rather than at a fixed depth above
 * this file.
 *
 * `../../../../package.json` is the same file today only because `"wigolo": "file:../.."` makes
 * `node_modules/wigolo` a link back to the repository root. Resolve it as a package and the assertion
 * below keeps meaning "every dependency core declares", instead of quietly becoming "every dependency
 * the enclosing repository declares" — which is the same sentence while the link holds and a vacuous
 * one the moment `wigolo` is a real install.
 */
const WIGOLO_PKG_DIR = realpathSync(join(REPO_ROOT, 'node_modules', 'wigolo'));
const corePkg = JSON.parse(readFileSync(join(WIGOLO_PKG_DIR, 'package.json'), 'utf8')) as {
  name: string;
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
    for (const globs of Object.values(ASAR_UNPACK)) {
      for (const g of globs) expect(g.startsWith('**/node_modules/')).toBe(true);
    }
  });
});

describe('the DB broker runs on plain Node, so its module graph cannot be archived', () => {
  // Found by LAUNCHING the packaged app: the gateway came up and the broker did not. Typecheck, unit,
  // e2e and CI were all green. The broker is spawned as a plain-Node child (spec §13.7) and plain Node
  // has no asar layer, so every file it loads has to exist on the real filesystem.
  it('unpacks node_modules wholesale rather than a curated dependency list', () => {
    // Measured 2026-08-17: the broker entry reaches 305 files inside the wigolo package and 19
    // external packages directly, each with its own transitive tree. A curated subset is a list that
    // goes stale on the next import anyone adds — and goes stale INVISIBLY, because nothing but a
    // packaged launch can notice. The blunt glob is the point, not an oversight.
    expect(BROKER_ASAR_UNPACK['studio-db-broker']).toEqual(['**/node_modules/**']);
  });

  it('covers the wigolo package itself, which ships no binary for smartUnpack to notice', () => {
    // electron-builder's smartUnpack rescues module roots that contain a `.node`/`.dylib`. The wigolo
    // package contains none, and neither do the pure-JS packages the broker imports, so the heuristic
    // cannot rescue any of this. That is why the glob has to be declared and not left to inference.
    const globs = resolveAsarUnpack(undefined);
    expect(globs).toContain('**/node_modules/**');
  });

  it('is droppable on its own so a negative control can re-break exactly this', () => {
    const got = resolveAsarUnpack('studio-db-broker');
    expect(got).not.toContain('**/node_modules/**');
    // The native pins must survive it, or the control cannot tell "the broker glob mattered" from
    // "the artifact is broken everywhere".
    expect(got).toContain('**/node_modules/better-sqlite3/**');
    expect(got).toContain('**/node_modules/sqlite-vec/**');
  });

  it('subsumes every native glob, which makes an un-omitted native control vacuous', () => {
    // This is the trap the native control already fell into once via smartUnpack, in a new guise:
    // `**/node_modules/**` unpacks onnxruntime-node whether or not its own glob was dropped. Any
    // control aimed at a native entry must drop this key too. Asserted so the coupling is enforced
    // rather than remembered.
    for (const globs of Object.values(NATIVE_ASAR_UNPACK)) {
      for (const g of globs) expect(g.startsWith('**/node_modules/')).toBe(true);
    }
    expect(resolveAsarUnpack('onnxruntime-node')).toContain('**/node_modules/**');
  });
});

describe(`${OMIT_ENV} negative-control seam`, () => {
  it('unset means every glob ships', () => {
    const all = Object.values(ASAR_UNPACK).flat();
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

  it('excludes the repository source tree a linked wigolo checkout points at', () => {
    // Under `"wigolo": "file:../.."` the dependency's package root IS a repository checkout, so
    // without these negations the artifact would seal src/, tests/ and internal-docs/ inside
    // app.asar. A real installed `wigolo` contains only its published `files` set and the negations
    // match nothing — they are inert there, not wrong, and they must survive: a linked checkout stays
    // a supported topology and is what every contributor builds from.
    const files = (config.files as string[]).join('\n');
    for (const dir of ['src', 'tests', 'internal-docs', 'benchmarks']) {
      expect(files).toMatch(new RegExp(`!node_modules/wigolo/\\{[^}]*\\b${dir}\\b`));
    }
  });
});

describe("wigolo's own dependencies have to be carried into the artifact", () => {
  /**
   * Found by copying the packaged app OUT of the repository and launching it: one process, no
   * helpers, no stderr, parked in a modal load error —
   * `ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk' imported from
   * .../node_modules/wigolo/dist/daemon/proxy.js`. electron-builder collects the app's dependency
   * tree, `wigolo` is in it, and `wigolo`'s own 28 dependencies are NOT: npm hoists them to the
   * workspace root and `npm list` from the app directory does not report them under the `file:` link.
   *
   * In-repo the app rescues itself by resolving up and out of the `.app` into the workspace, which is
   * why nothing caught it. These run on every push; `tests/e2e/packaging.spec.ts` proves the same
   * thing against a real artifact staged outside the repo.
   */
  const { modulesDir, entries } = wigoloRuntimeClosure(REPO_ROOT, WIGOLO_PKG_DIR);
  const shipped = new Set(entries.map((e) => e.rel));

  it('walks the core manifest, not the enclosing repository - the closure cannot be vacuous', () => {
    // The anti-vacuity arm for the two roots. If this file ever went back to walking a single root,
    // the assertions below would still pass while measuring the wrong dependency set: an enclosing
    // repository that declares five dependencies would report a five-package "closure" as complete.
    // Core declares dozens, so the name check plus a floor pins that the walk started from core.
    expect(corePkg.name).toBe('wigolo');
    expect(Object.keys(corePkg.dependencies).length).toBeGreaterThan(10);
    expect(entries.length).toBeGreaterThan(Object.keys(corePkg.dependencies).length);
  });

  it("carries every one of the core package's direct dependencies", () => {
    // Read from package.json, never listed here. A literal list would be satisfied by the six
    // packages the crash report happened to name and would go stale on the next `npm install <x>`.
    for (const name of Object.keys(corePkg.dependencies)) {
      expect(shipped.has(name), `${name} is a wigolo dependency and is missing from the artifact`).toBe(true);
    }
  });

  it('is closed under resolution, so nothing it carries can reach a package it does not', () => {
    // THE property, and the one a plausible-looking optimisation broke: an earlier attempt subtracted
    // the packages electron-builder already ships into `app.asar.unpacked/node_modules`, and the app
    // died on `Cannot find module 'inherits'`. That tree and this one are SIBLINGS — Node only walks
    // up — so a set placed above the archive cannot borrow from a set placed inside it.
    const missing: string[] = [];
    for (const { rel } of entries) {
      const dir = join(modulesDir, rel);
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        // Node's own lookup, restricted to what the artifact actually contains: nested first, then
        // each ancestor up to the root of the shipped tree.
        let segments = rel.split('/');
        let found = false;
        for (;;) {
          if (shipped.has([...segments, 'node_modules', dep].join('/')) || (segments.length === 0 && shipped.has(dep))) {
            found = true;
            break;
          }
          if (segments.length === 0) break;
          segments = segments.slice(0, -1);
        }
        if (!found) missing.push(`${rel} -> ${dep}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('resolves every shipped package to a directory that really exists', () => {
    for (const { rel } of entries) expect(existsSync(join(modulesDir, rel, 'package.json'))).toBe(true);
  });

  it('lands above the archive, where resolution from inside app.asar can reach it', () => {
    // `Contents/Resources/node_modules` is the first `node_modules` ABOVE `app.asar`. Measured: a
    // destination of `app.asar.unpacked/node_modules` does NOT work — resolution from
    // `app.asar/node_modules/wigolo/…` consults the archive's virtual node_modules and then
    // `Resources/node_modules`, and never looks inside the sibling unpacked tree.
    const sets = config.extraResources as Array<{ from: string; to: string; filter: string[] }>;
    expect(sets).toHaveLength(1);
    expect(sets[0].to).toBe('node_modules');
    expect(sets[0].from).toBe(modulesDir);
  });

  it('names no package in its exclusions', () => {
    // The exclusions are allowed to remove FILE CLASSES that no runtime reads. The moment one names a
    // package it becomes the hand-maintained list this whole mechanism exists to avoid.
    const sets = config.extraResources as Array<{ filter: string[] }>;
    const negations = sets[0].filter.filter((p) => p.startsWith('!'));
    expect(negations).toEqual(['!**/*.{d.ts,map}']);
  });

  it('fails the build rather than shipping a gap, when a dependency is not installed', () => {
    // The failure mode this guards is silence. A closure that quietly skipped what it could not find
    // would produce an artifact that starts on the build machine and nowhere else — which is exactly
    // the defect, rebuilt inside the fix.
    expect(() => wigoloRuntimeClosure(join(REPO_ROOT, 'apps'))).toThrow();
  });
});

describe(`${OMIT_CLOSURE_ENV} negative-control seam`, () => {
  it('is a seam of its own, not folded into the asarUnpack one', () => {
    // The two remove different mechanisms: OMIT_ENV decides archived-vs-unpacked for files already
    // collected, this decides whether wigolo's dependencies are collected at all. A control that
    // conflated them could not tell which one it had broken.
    expect(OMIT_CLOSURE_ENV).not.toBe(OMIT_ENV);
    expect(() => resolveAsarUnpack('wigolo-closure')).toThrow(/not one of/);
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
