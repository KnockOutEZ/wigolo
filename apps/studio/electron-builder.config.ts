import type { Configuration } from 'electron-builder';

/**
 * S16-alpha packaging: a dev-channel, UNSIGNED, darwin-arm64-only local artifact. Code signing,
 * notarization, and the win/linux targets are deliberately S16-final and absent here — a dev build
 * that pretends to be shippable is worse than one that is obviously not.
 *
 * The whole point of this config is `asarUnpack`. See NATIVE_ASAR_UNPACK below.
 */

/**
 * Native packages that must stay whole on the real filesystem instead of being sealed into
 * `app.asar`, keyed by the module whose load they rescue.
 *
 * READ THIS BEFORE TRUSTING THE LIST: these globs are a PIN, not the mechanism. Measured
 * 2026-08-17 against electron-builder 26.15.3 — all four entries are ALREADY covered by
 * electron-builder's own `smartUnpack` heuristic, and an artifact built with every glob here deleted
 * still loads all four modules. `app-builder-lib/out/asar/unpackDetector.js` walks the file set, and
 * on any file matching `isLibOrExe()` (`.dll .exe .dylib .so .node`, plus an extensionless
 * `isBinaryFileSync` fallback) it adds that file's **`moduleRootPath`** — the whole package — to
 * `autoUnpackDirs`. Whole packages, not lone files. That also means the `.dylib`-only packages
 * (`@img/sharp-libvips-darwin-arm64`, `sqlite-vec-darwin-arm64`) are detected on their own merits;
 * they do not depend on a sibling `.node` being noticed first.
 *
 * So what is the pin FOR? It survives the heuristic being disabled (`asar.smartUnpack: false`) or
 * outgrown — a future native package whose payload the detector does not recognise, or an upstream
 * change to what counts as a binary. It also states the requirement by name, which a heuristic
 * cannot: reading this file tells you which four packages must never be archived, and why.
 *
 * WHAT ACTUALLY BREAKS when a package is archived (measured, see below): the binding gets extracted
 * to a temp file on `dlopen`, stranded from the sibling libraries it names by `@rpath`, and the load
 * fails on the LIBRARY, not the binding — `@rpath/libonnxruntime.*.dylib`,
 * `@rpath/libvips-cpp.*.dylib`. `vec0.dylib` is worse: SQLite opens it by absolute path through
 * `sqlite3_load_extension`, so the asar layer never sees the call and cannot help at all. None of
 * this is visible to a loose (unpackaged) run, which is why the claim needed an executed artifact.
 *
 * The proof and the falsification both live in `tests/e2e/packaging.spec.ts`: it builds a second
 * artifact with entries dropped (see OMIT_ENV below) AND `smartUnpack` off — off is what isolates
 * the pin as the thing under test — then asserts the matching module fails while the retained ones
 * still pass. Do not prune an entry on the strength of this comment; drop it, rebuild that control,
 * and watch the probe go red first.
 */
export const NATIVE_ASAR_UNPACK: Readonly<Record<string, readonly string[]>> = {
  // The embedding backend. `bin/napi-v3/darwin/arm64/onnxruntime_binding.node` needs its sibling
  // `libonnxruntime.*.dylib` in the same directory on disk.
  'onnxruntime-node': ['**/node_modules/onnxruntime-node/**'],
  // sharp's JS shim resolves the platform package, whose binding then reaches into a THIRD package
  // for libvips — `@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node` ->
  // `@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.*.dylib`. An unpack scoped to one of the three
  // is not enough, so `@img/**` covers the family (including `@img/colour`, also required).
  sharp: ['**/node_modules/sharp/**', '**/node_modules/@img/**'],
  // The cache DB and FTS5 ride on this one. Raw V8 addon, not N-API — see the `npmRebuild` note.
  'better-sqlite3': ['**/node_modules/better-sqlite3/**'],
  // `getLoadablePath()` returns an absolute path to `vec0.dylib` that SQLite itself opens. Nothing
  // in the asar layer ever sees that call, so the file has to genuinely exist on disk.
  'sqlite-vec': ['**/node_modules/sqlite-vec/**', '**/node_modules/sqlite-vec-*/**'],
};

/**
 * Negative-control seam. Comma-separated keys of NATIVE_ASAR_UNPACK to DROP from the packaged
 * artifact, so a test can build a deliberately broken app and prove the probe tells working from
 * broken. Unset in every normal build; a set value is echoed loudly because an artifact built with
 * it is not shippable.
 */
export const OMIT_ENV = 'WIGOLO_PACK_OMIT_UNPACK';

export function resolveAsarUnpack(omitList: string | undefined): string[] {
  const omit = new Set(
    (omitList ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const key of omit) {
    if (!(key in NATIVE_ASAR_UNPACK)) {
      throw new Error(
        `${OMIT_ENV}: '${key}' is not one of ${Object.keys(NATIVE_ASAR_UNPACK).join(', ')}. A typo here would silently build a CORRECT artifact and make a negative control pass for the wrong reason.`,
      );
    }
  }
  return Object.entries(NATIVE_ASAR_UNPACK)
    .filter(([key]) => !omit.has(key))
    .flatMap(([, globs]) => globs);
}

/**
 * `wigolo` is a `file:../..` workspace dependency, so its package root IS the repository root. Left
 * alone, electron-builder would seal the entire repo — `src/`, `tests/`, `internal-docs/`,
 * `benchmarks/` — into the artifact. Only what the published npm package ships is runtime-relevant.
 */
const WIGOLO_REPO_TRIM: readonly string[] = [
  '!node_modules/wigolo/{src,tests,apps,benchmarks,contracts,sdks,packaging,docs,internal-docs,examples,scripts,.github,.claude,.worktrees,coverage,out,release}',
  '!node_modules/wigolo/{.git,.gitignore,.npmignore,Makefile,tsconfig*.json,vitest*.config.ts,*.log,*.tgz}',
  '!node_modules/wigolo/assets/!(blocks|legacy-skill-hashes.json)',
];

if (process.env[OMIT_ENV]) {
  // stderr, not stdout — and unmissable. An artifact built this way is a test fixture.
  process.stderr.write(
    `\n!! ${OMIT_ENV}=${process.env[OMIT_ENV]} — asarUnpack entries DROPPED. This artifact is a deliberately broken negative control and must not be shipped or launched as a real build. !!\n\n`,
  );
}

const config: Configuration = {
  appId: 'dev.wigolo.studio',
  productName: 'Wigolo Studio',
  // Dev channel: never overwrite a signed build's output tree.
  directories: { output: 'release' },

  files: ['out/**', 'package.json', ...WIGOLO_REPO_TRIM],

  asar: true,
  asarUnpack: resolveAsarUnpack(process.env[OMIT_ENV]),

  /**
   * OFF, and this is a measured decision rather than a default we left alone.
   *
   * better-sqlite3 is the only non-N-API module in the set: 12.9.0 ships a NODE_MODULE_VERSION 127
   * binary and Electron 43 wants 148. A rebuild is the obvious answer and it is not available to us:
   *   - `prebuild-install --runtime electron --target 43.0.0` -> HTTP 404, upstream publishes no
   *     electron-v148 asset for v12.9.0;
   *   - the node-gyp source fallback FAILS against Electron 43's V8 headers — `External::Value()`
   *     gained a required `tag` argument and `SetNativeDataProperty` became ambiguous, so
   *     `src/util/macros.cpp`'s `OnlyAddon` no longer compiles. That is the same V8 break better-
   *     sqlite3 v13 fixes, and the v13 bump is parked (it dropped its `install` script, which makes
   *     `npm ci` hard-fail on Windows without Visual Studio).
   *
   * Leaving `npmRebuild` on is actively harmful here: @electron/rebuild deletes
   * `build/Release/better_sqlite3.node` before it compiles, so the failed build leaves the WORKSPACE
   * without a loadable binary and `npm test` starts failing on an unrelated tree. Measured, not
   * predicted — it happened on the first packaging attempt.
   *
   * Shipping the Node-ABI binary is also the architecturally correct outcome today: the DB broker is
   * a plain-Node child process (spec §13.7 — the Electron main never loads a native module), so
   * NODE_MODULE_VERSION 127 is the ABI that actually has to load. The Electron-side load is a
   * broker-RETIREMENT question, and it is gated on the better-sqlite3 version, NOT on asar.
   */
  npmRebuild: false,

  mac: {
    // `dir` only — a dev artifact we launch locally, not a dmg/zip anyone installs.
    target: [{ target: 'dir', arch: ['arm64'] }],
    // Unsigned by intent (S16-final owns signing). arm64 still gets an ad-hoc signature, which is
    // the minimum macOS will execute.
    identity: null,
    notarize: false,
  },

  // No auto-update channel for a dev artifact.
  publish: null,
};

export default config;
