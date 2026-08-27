import type { Configuration } from 'electron-builder';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

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
 * The studio DB broker is a PLAIN-NODE child process (spec §13.7), and plain Node has no asar layer —
 * the archive is a virtual filesystem Electron patches into its own `fs`, nothing more. Every module
 * the broker loads therefore has to be a real file on disk, or the child dies on `Cannot find module`
 * before it ever writes its `ready` frame.
 *
 * WHY THE GLOB IS THE WHOLE TREE, and not a curated list. The broker entry
 * (`wigolo/dist/daemon/studio-db-broker.js`) pulls in `initSubsystems` from the core server: measured
 * 2026-08-17, 305 files inside the wigolo package reaching 19 external packages directly
 * (@modelcontextprotocol/sdk, playwright, defuddle, linkedom, turndown, pdf-parse, fastembed, the LLM
 * adapters, …), each with its own transitive tree. A hand-maintained subset of that closure is a list
 * that is wrong the moment anyone adds an import — and it fails ONLY in a packaged launch, which is
 * exactly how this defect shipped green through typecheck, unit, e2e and CI. `**\/node_modules/**`
 * cannot be wrong in that direction.
 *
 * NOTE the consequence for the native pins above: this glob SUBSUMES all four of them in a normal
 * build. They stay because they state the requirement by name and survive this entry being narrowed;
 * but any negative control aimed at a native glob must now ALSO omit this key, or the module under
 * test stays unpacked and the control passes for a reason that has nothing to do with the glob.
 */
export const BROKER_ASAR_UNPACK: Readonly<Record<string, readonly string[]>> = {
  'studio-db-broker': ['**/node_modules/**'],
};

/** Everything that must land in `app.asar.unpacked`, keyed by the requirement it satisfies. */
export const ASAR_UNPACK: Readonly<Record<string, readonly string[]>> = {
  ...NATIVE_ASAR_UNPACK,
  ...BROKER_ASAR_UNPACK,
};

/**
 * Negative-control seam. Comma-separated keys of ASAR_UNPACK to DROP from the packaged artifact, so a
 * test can build a deliberately broken app and prove the probe tells working from broken. Unset in
 * every normal build; a set value is echoed loudly because an artifact built with it is not shippable.
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
    if (!(key in ASAR_UNPACK)) {
      throw new Error(
        `${OMIT_ENV}: '${key}' is not one of ${Object.keys(ASAR_UNPACK).join(', ')}. A typo here would silently build a CORRECT artifact and make a negative control pass for the wrong reason.`,
      );
    }
  }
  return Object.entries(ASAR_UNPACK)
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

/**
 * `wigolo`'s OWN runtime dependencies do not ship with it, and electron-builder cannot notice.
 *
 * THE DEFECT THIS EXISTS TO FIX (measured 2026-08-18, artifact copied outside the repo): the packaged
 * app never started. One process, no helpers, no stderr, parked in a modal load error —
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk' imported from
 * app.asar/node_modules/wigolo/dist/daemon/proxy.js`.
 *
 * WHY. electron-builder collects the production dependency tree of `apps/studio/package.json`.
 * `wigolo` is in it (`file:../..`), so the package itself lands in the artifact. Its own 28
 * dependencies do not: npm HOISTS them to the workspace root `node_modules`, which is not under the
 * app directory and is not part of any dependency edge electron-builder walks. `asarUnpack` cannot
 * help — it only chooses archived-vs-unpacked for files that were already collected.
 *
 * WHY NO TEST SAW IT. In-repo the app rescues itself: Node's resolver walks `node_modules` UPWARD out
 * of the `.app` bundle and lands in the developer's workspace. Same escape PR #347 fixed for the
 * broker child, one level up at Electron main. Everything in `packaging.spec.ts` ran inside the repo,
 * so every probe measured a tree that could always cheat. The launch assertion added by this change
 * runs against a copy in the OS temp dir with zero `node_modules` in any ancestor.
 *
 * WHY A COMPUTED CLOSURE AND NOT A LIST. The six packages named in the crash report are a symptom
 * sample, not the closure — the real answer is 386 package directories. A hand-written list is wrong the first
 * time anyone adds an import, and wrong SILENTLY, in the only environment nothing tests. So the
 * closure is derived from the installed tree the same way Node resolves it, and a dependency it
 * cannot find is a BUILD failure, never a quiet omission.
 *
 * The walk is bounded at the wigolo package root. That bound is load-bearing here: this repo is
 * routinely checked out as a nested git worktree under another copy of itself, so an unbounded
 * upward walk would happily satisfy a missing dependency from the PARENT checkout and bake a
 * machine-specific artifact.
 */
interface ClosureEntry {
  /** Package directory, relative to the workspace root `node_modules`, with `/` separators. */
  readonly rel: string;
  /** Package name, for diagnostics. */
  readonly name: string;
}

function readPackageJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
}

/** Node's directory resolution for `name`, starting at `fromDir` and refusing to pass `boundary`. */
function resolvePackageDir(name: string, fromDir: string, boundary: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dir === boundary) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Every package `wigolo` can reach at runtime: `dependencies`, `optionalDependencies` and
 * non-optional `peerDependencies`, transitively.
 *
 * Keyed by DIRECTORY, not by name. npm nests a package whenever two requirers want incompatible
 * versions, and a name-keyed set would collapse `express/node_modules/debug` into the root `debug` and
 * ship one version where two are needed.
 *
 * TWO roots, and conflating them is a real defect rather than a tidiness point. `workspaceRoot` is
 * where npm HOISTS to — it fixes `modulesDir` and it is the ceiling every walk refuses to pass.
 * `wigoloPkgDir` is the manifest the walk STARTS from. Under `"wigolo": "file:../.."` the two are one
 * path, because the dependency's package root is the workspace root itself, so the single-argument
 * form was indistinguishable from correct. They separate the moment `wigolo` is a real installed
 * dependency: the manifest then lives at `<workspaceRoot>/node_modules/wigolo`, while its 28
 * dependencies are still hoisted to `<workspaceRoot>/node_modules`. Starting AND bounding the walk at
 * the package directory makes the very first hoisted dependency unresolvable, and the walk throws
 * "not installed at or below" for a package that is installed one level up.
 */
export function wigoloRuntimeClosure(
  workspaceRoot: string,
  wigoloPkgDir: string = workspaceRoot,
): { modulesDir: string; entries: ClosureEntry[] } {
  const modulesDir = join(workspaceRoot, 'node_modules');
  const found = new Map<string, ClosureEntry>();
  const visited = new Set<string>([wigoloPkgDir]);
  const queue: string[] = [wigoloPkgDir];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const pkg = readPackageJson(dir);
    const peerMeta = (pkg.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
    const wanted: Array<[string, boolean]> = [
      ...Object.keys((pkg.dependencies ?? {}) as object).map((n): [string, boolean] => [n, false]),
      ...Object.keys((pkg.optionalDependencies ?? {}) as object).map((n): [string, boolean] => [n, true]),
      ...Object.keys((pkg.peerDependencies ?? {}) as object).map((n): [string, boolean] => [
        n,
        peerMeta[n]?.optional === true,
      ]),
    ];

    for (const [name, optional] of wanted) {
      const dep = resolvePackageDir(name, dir, workspaceRoot);
      if (dep === undefined) {
        // Optional deps legitimately go uninstalled (platform-specific bindings, opt-in extras).
        if (optional) continue;
        throw new Error(
          `wigoloRuntimeClosure: '${name}', required by ${dir}, is not installed at or below ${workspaceRoot}. ` +
            `Run npm install at the workspace root. Shipping without it would produce an artifact that ` +
            `only starts on a machine that has this repository checked out.`,
        );
      }
      if (!dep.startsWith(modulesDir + sep)) {
        throw new Error(
          `wigoloRuntimeClosure: '${name}' resolved to ${dep}, outside ${modulesDir}. The artifact can ` +
            `only carry packages that live under the workspace root node_modules.`,
        );
      }
      if (visited.has(dep)) continue;
      visited.add(dep);
      queue.push(dep);
      found.set(dep, { rel: relative(modulesDir, dep).split(sep).join('/'), name });
    }
  }

  return { modulesDir, entries: [...found.values()].sort((a, b) => a.rel.localeCompare(b.rel)) };
}

/**
 * Negative-control seam for the closure, separate from {@link OMIT_ENV} because it removes a
 * different mechanism: OMIT_ENV drops `asarUnpack` globs (archived vs unpacked), this drops the
 * collection of wigolo's dependencies entirely and reproduces the pre-fix artifact.
 */
export const OMIT_CLOSURE_ENV = 'WIGOLO_PACK_OMIT_CLOSURE';

for (const flag of [OMIT_ENV, OMIT_CLOSURE_ENV]) {
  if (!process.env[flag]) continue;
  // stderr, not stdout — and unmissable. An artifact built this way is a test fixture.
  process.stderr.write(
    `\n!! ${flag}=${process.env[flag]} — packaging content DROPPED. This artifact is a deliberately broken negative control and must not be shipped or launched as a real build. !!\n\n`,
  );
}

/**
 * The workspace root: where npm hoists `wigolo`'s dependencies to, and the ceiling for every walk in
 * this file — see the nested-worktree note above. Under `"wigolo": "file:../.."` it is also where
 * `wigolo` itself lives, which is why `WIGOLO_ROOT` below resolves to this same path today; when the
 * dependency is a real install the two diverge and both are needed, so nothing here assumes they are
 * one path.
 */
const APP_DIR = realpathSync(import.meta.dirname);
const WORKSPACE_ROOT = realpathSync(join(APP_DIR, '..', '..'));

const WIGOLO_ROOT = (() => {
  // Both ends realpathed, or the `dir === boundary` stop never fires on a symlinked checkout and the
  // walk silently escapes into whatever is above it.
  const found = resolvePackageDir('wigolo', APP_DIR, WORKSPACE_ROOT);
  if (found === undefined) {
    throw new Error(
      `electron-builder.config: cannot resolve the 'wigolo' package from ${APP_DIR} without ` +
        `leaving ${WORKSPACE_ROOT}. Run npm install at the workspace root.`,
    );
  }
  const name = readPackageJson(found).name;
  if (name !== 'wigolo') {
    throw new Error(`electron-builder.config: ${found} is '${String(name)}', not 'wigolo'.`);
  }
  return found;
})();

type FileSet = { from: string; to: string; filter: string[] };

/**
 * `extraResources`, NOT `files` — and that is a measured constraint, not a preference.
 *
 * The closure must end up as real files on disk, because the DB broker is a plain-Node child with no
 * asar layer. Routing it through `files` puts it inside `app.asar`, and `asarUnpack` CANNOT be
 * trusted to pull it back out: `app-builder-lib/out/util/filter.js` matches unpack globs against
 * `file.substring(appDir.length)`, so a source path that is not under the app directory produces a
 * garbage relative string. Measured 2026-08-18 — that garbage happened to match for 31 of the 386
 * packages and not the rest, and it also stopped unpacking sqlite-vec and sharp, which had been
 * working. `extraResources` does not go through that matcher at all.
 *
 * `Contents/Resources/node_modules` is the destination because it is the first `node_modules` ABOVE
 * the archive: resolution from `app.asar/node_modules/wigolo/dist/daemon/proxy.js` misses in the
 * archive's own (virtual) `node_modules` and lands there next. Measured — the whole set has to go
 * there, WITHOUT subtracting the packages electron-builder already ships into
 * `app.asar.unpacked/node_modules`. Those two trees are SIBLINGS and Node only ever walks up, so a
 * package at `Resources/node_modules/http-errors` cannot reach `inherits` in the unpacked tree; a
 * build that subtracted the overlap died on exactly that. The set placed here must be closed under
 * resolution on its own, which costs a duplicated copy of the ~65 MB the two trees share.
 */
const wigoloDependencyResources = (): FileSet[] => {
  if (process.env[OMIT_CLOSURE_ENV]) return [];
  const { modulesDir, entries } = wigoloRuntimeClosure(WORKSPACE_ROOT, WIGOLO_ROOT);
  process.stderr.write(`  • wigolo runtime dependency closure  packages=${entries.length} from=${modulesDir}\n`);
  return [
    {
      from: modulesDir,
      to: 'node_modules',
      filter: [
        ...entries.map((e) => `${e.rel}/**/*`),
        // Two whole classes of file that no runtime ever reads — 88 MB across this closure, measured.
        // `d.ts` is already in electron-builder's own `excludedExts` for the sets it collects itself;
        // `extraResources` gets none of those defaults, so parity has to be stated here. Class rules
        // only: nothing in this filter may name a package.
        '!**/*.{d.ts,map}',
      ],
    },
  ];
};

const config: Configuration = {
  appId: 'dev.wigolo.studio',
  productName: 'Wigolo Studio',
  // Dev channel: never overwrite a signed build's output tree.
  directories: { output: 'release' },

  files: ['out/**', 'package.json', ...WIGOLO_REPO_TRIM],

  extraResources: wigoloDependencyResources(),

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
