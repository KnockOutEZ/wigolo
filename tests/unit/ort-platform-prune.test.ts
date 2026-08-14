import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { planPlatformPrune, locateOrtRoots, findOutermostInstallRoot } from '../../scripts/prune/ort-platforms.mjs';

/*
 * WHY these tests exist.
 *
 * The prune deletes 178 MiB of prebuilt native runtimes out of a user's install, and the ONE
 * directory it must never delete is the one that gets loaded. That decision — which pairs go,
 * which stays — is the whole risk, so it lives in a pure function and is tested here rather
 * than being discoverable only by running an install and seeing whether inference still works.
 *
 * The measurement that motivates it is not repeated here, because a unit test cannot perform
 * an npm install; it is recorded on the G-DIET gate. What IS testable is the decision, and
 * every assertion below is about a way the decision could strand a user.
 *
 * The real six-pair layout of onnxruntime-node@1.21.0, as shipped.
 */
const FULL_TREE = {
  darwin: ['arm64', 'x64'],
  linux: ['arm64', 'x64'],
  win32: ['arm64', 'x64'],
};

const ALL_HOSTS: Array<[string, string]> = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
];

describe('planPlatformPrune keeps exactly the pair that can be loaded', () => {
  it('keeps the host pair and removes the other five', () => {
    const plan = planPlatformPrune(FULL_TREE, 'darwin', 'arm64');
    expect(plan.keep).toBe('darwin/arm64');
    expect(plan.remove).toEqual(['darwin/x64', 'linux/arm64', 'linux/x64', 'win32/arm64', 'win32/x64']);
  });

  it('removes the SAME-platform other architecture too', () => {
    // The tempting shortcut is to prune whole platform directories, which is also how the
    // opportunity was first sized (linux + win32 = 144 MiB). It leaves darwin/x64 behind — 34 MiB
    // on this host that nothing on an arm64 machine can ever load. Pruning by PAIR rather than by
    // platform is worth the extra 34 MiB, and this is the assertion that would notice a later
    // simplification quietly giving it back.
    expect(planPlatformPrune(FULL_TREE, 'darwin', 'arm64').remove).toContain('darwin/x64');
  });

  it('never proposes removing the host pair, from any of the six hosts', () => {
    for (const [platform, arch] of ALL_HOSTS) {
      const plan = planPlatformPrune(FULL_TREE, platform, arch);
      expect(plan.remove, `${platform}/${arch}`).not.toContain(`${platform}/${arch}`);
      expect(plan.remove).toHaveLength(5);
      expect(plan.keep).toBe(`${platform}/${arch}`);
    }
  });
});

describe('planPlatformPrune refuses rather than guesses when it cannot find the host binary', () => {
  it('removes NOTHING when the host platform is absent', () => {
    // ⚠ The case that decides whether this script can strand someone. If the layout is not what
    // we believe — a future onnxruntime-node that renames its directories, a platform we have
    // never seen — then every candidate for removal might be the one that loads. Removing
    // nothing costs bytes. Removing the wrong thing costs the user their install, and it does so
    // AFTER npm reports success.
    const plan = planPlatformPrune(FULL_TREE, 'freebsd', 'x64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toBeNull();
    expect(plan.reason).toContain('refusing to prune');
  });

  it('removes NOTHING when the host platform is present but the host ARCH is not', () => {
    // Distinct from the case above and easy to get wrong: a tree that has `darwin` would satisfy
    // a platform-level check while still having no binary an arm64 process can load. Node's
    // require path is the PAIR, so the guard has to be stated over the pair.
    const plan = planPlatformPrune({ darwin: ['x64'], linux: ['x64'] }, 'darwin', 'arm64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toBeNull();
  });

  it('is idempotent — a second run over an already-pruned tree removes nothing', () => {
    // npm re-runs a package's postinstall on installs that did not re-extract that package, so
    // this runs many times over the same tree. The second run must be a no-op and must not
    // report a refusal, which would read as a fault in the logs of a perfectly healthy install.
    const plan = planPlatformPrune({ darwin: ['arm64'] }, 'darwin', 'arm64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toBe('darwin/arm64');
    expect(plan.reason).not.toContain('refusing');
  });

  it('tolerates the emptied platform directories a previous run leaves behind', () => {
    // The driver removes non-host platform dirs once their arches are gone, but a failed or
    // interrupted removal can leave an empty `linux/`. That must read as "nothing to do", not as
    // a platform whose absence of arches means something.
    const plan = planPlatformPrune({ darwin: ['arm64'], linux: [], win32: [] }, 'darwin', 'arm64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toBe('darwin/arm64');
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * Fixture trees.
 *
 * ⚠ BUILT IN os.tmpdir(), NEVER UNDER THE REPO. Everything below is about which `node_modules` a
 * lookup reaches. A fixture placed inside the checkout is a fixture whose misses are silently
 * answered by the repo's own (or a parent worktree's) `node_modules`, which is precisely the
 * failure this file exists to catch — the test would pass for the wrong reason.
 * ---------------------------------------------------------------------------------------------
 */

/** The six pairs onnxruntime-node@1.21.0 ships, with THIS host's pair guaranteed present. */
const HOST_PAIR = `${process.platform}/${process.arch}`;
const FIXTURE_PAIRS = [
  HOST_PAIR,
  ...['darwin/arm64', 'darwin/x64', 'linux/arm64', 'linux/x64', 'win32/arm64', 'win32/x64']
    .filter((p) => p !== HOST_PAIR)
    .slice(0, 5),
];

function fixtureTree(): Record<string, string[]> {
  const tree: Record<string, string[]> = {};
  for (const pair of FIXTURE_PAIRS) {
    const [plat, arch] = pair.split('/');
    (tree[plat] ??= []).push(arch);
  }
  return tree;
}

const HOST_BYTES = 4096;

/** A platform directory that is entirely removable on this host, whatever host that is. */
const NON_HOST_PLATFORM = Object.keys(fixtureTree()).find((p) => p !== process.platform) as string;

function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

function writePkg(dir: string, manifest: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
}

/**
 * One `onnxruntime-node` install, with `symlinkPlatform`'s directory materialised OUTSIDE the
 * package and linked into place.
 *
 * The symlinked platform dir is not decoration. `d06b8c21` had to teach the layout reader to
 * follow links because `Dirent.isDirectory()` is false for a symlink to a directory, and npm and
 * pnpm both materialise parts of a tree as links. A fixture built only from plain directories
 * cannot notice that regression coming back.
 */
function buildOrtCopy(
  root: string,
  opts: { bytesPerPair: number; symlinkPlatform: string; store: string; tag: string },
): void {
  writePkg(root, { name: 'onnxruntime-node', version: '1.21.0' });
  const binRoot = join(root, 'bin', 'napi-v3');
  mkdirSync(binRoot, { recursive: true });

  for (const [plat, arches] of Object.entries(fixtureTree())) {
    const inPlace = join(binRoot, plat);
    const physical = plat === opts.symlinkPlatform ? join(opts.store, `${opts.tag}-${plat}`) : inPlace;
    mkdirSync(physical, { recursive: true });
    for (const arch of arches) {
      mkdirSync(join(physical, arch), { recursive: true });
      const size = `${plat}/${arch}` === HOST_PAIR ? HOST_BYTES : opts.bytesPerPair;
      writeFileSync(join(physical, arch, 'onnxruntime_binding.node'), Buffer.alloc(size));
    }
    if (physical !== inPlace) linkDir(physical, inPlace);
  }
}

/** An `exports` map with no `./package.json` entry — the real shape of both ORT consumers. */
function consumerManifest(name: string) {
  return { name, version: '1.0.0', exports: { '.': './index.js' } };
}

/**
 * A tree where hoisting was DEFEATED: one hoisted copy plus a second, larger copy nested under
 * @huggingface/transformers and reached through a package symlink, pnpm-style.
 *
 * @returns the install root.
 */
function buildMultiCopyTree(): string {
  // realpathSync because macOS's tmpdir is /var -> /private/var, and `require.resolve` reports
  // the resolved path. Without this the two halves of the locator would disagree about whether
  // they found the same copy and the dedup assertion would be meaningless.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-ort-multi-')));
  const modules = join(root, 'node_modules');
  const store = join(root, '.store');
  mkdirSync(store, { recursive: true });
  writePkg(root, { name: 'some-users-app', version: '0.0.0' });

  // Copy A — hoisted, 0.6 MiB per removable pair (5 pairs -> 3 MiB). A NON-HOST platform dir is
  // the link here, so a reader that stopped following links would leave those pairs behind while
  // still pruning the rest — a partial prune that reports success.
  buildOrtCopy(join(modules, 'onnxruntime-node'), {
    bytesPerPair: 629_146,
    symlinkPlatform: NON_HOST_PLATFORM,
    store,
    tag: 'a',
  });

  // Copy B — nested under a consumer, reached through a symlink, 1.2 MiB per removable pair
  // (5 pairs -> 6 MiB). Deliberately a DIFFERENT size from copy A so an accounting bug that
  // accumulated across copies would report a number no single copy could produce.
  const storeB = join(store, 'onnxruntime-node');
  buildOrtCopy(storeB, {
    bytesPerPair: 1_258_291,
    symlinkPlatform: process.platform, // the HOST platform dir is the link here
    store,
    tag: 'b',
  });

  // wigolo as an installed dependency, WITH a nested node_modules of its own. That detail is
  // load-bearing: the scan starts from this directory, and "walk up until you see a
  // node_modules" would stop right here and scan only wigolo's own nested tree — finding
  // neither ORT copy. The install root has to be derived from the path, not from the first
  // node_modules that happens to exist.
  writePkg(join(modules, 'wigolo'), { name: 'wigolo', version: '0.0.0' });
  writePkg(join(modules, 'wigolo', 'node_modules', 'some-nested-dep'), { name: 'some-nested-dep', version: '1.0.0' });

  writePkg(join(modules, 'fastembed'), consumerManifest('fastembed'));
  const transformers = join(modules, '@huggingface', 'transformers');
  writePkg(transformers, consumerManifest('@huggingface/transformers'));
  mkdirSync(join(transformers, 'node_modules'), { recursive: true });
  linkDir(storeB, join(transformers, 'node_modules', 'onnxruntime-node'));

  return root;
}

/**
 * A tree where wigolo itself was nested: `<root>/node_modules/foo/node_modules/wigolo`, which npm
 * produces when foo pins a version of one of wigolo's dependencies that the hoisted copy cannot
 * satisfy. Both onnxruntime copies sit OUTSIDE wigolo's install root — one hoisted above it, one
 * nested off to the side under `bar` — so the on-disk scan can see neither.
 *
 * @returns the install root.
 */
function buildNestedWigoloTree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-ort-nested-')));
  const modules = join(root, 'node_modules');
  const store = join(root, '.store');
  mkdirSync(store, { recursive: true });
  writePkg(root, { name: 'some-users-app', version: '0.0.0' });

  buildOrtCopy(join(modules, 'onnxruntime-node'), {
    bytesPerPair: 2048,
    symlinkPlatform: 'none',
    store,
    tag: 'hoisted',
  });
  buildPkgWithNestedOrt(join(modules, 'bar'), store, 'sibling');

  writePkg(join(modules, 'foo'), { name: 'foo', version: '1.0.0' });
  writePkg(join(modules, 'foo', 'node_modules', 'wigolo'), { name: 'wigolo', version: '0.0.0' });

  return root;
}

function buildPkgWithNestedOrt(pkgDir: string, store: string, tag: string): void {
  writePkg(pkgDir, { name: pkgDir.split(sep).pop(), version: '1.0.0' });
  buildOrtCopy(join(pkgDir, 'node_modules', 'onnxruntime-node'), {
    bytesPerPair: 2048,
    symlinkPlatform: 'none',
    store,
    tag,
  });
}

/** Exactly what `scripts/prune/run.mjs` uses to find the hoisted copy, bound to `root`'s tree. */
function hoistedResolverFor(root: string) {
  const req = createRequire(join(root, 'noop.cjs'));
  return () => dirname(req.resolve('onnxruntime-node/package.json'));
}

describe('the consumer-resolution strategy this replaced could never contribute a root', () => {
  let root: string;
  beforeAll(() => {
    root = buildMultiCopyTree();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('throws ERR_PACKAGE_PATH_NOT_EXPORTED for BOTH onnxruntime consumers', () => {
    // ⚠ The finding this slice exists for. The old locator resolved `<consumer>/package.json` to
    // learn where a consumer sat, then resolved onnxruntime-node from there. Both consumers
    // declare an `exports` map with no `./package.json` entry, so that first resolve throws and
    // the whole branch was dead — every non-hoisted copy survived a prune that reported success.
    // Asserting the CODE, not the message, because the message carries an absolute path.
    const req = createRequire(join(root, 'noop.cjs'));
    for (const consumer of ['fastembed', '@huggingface/transformers']) {
      let code: string | undefined;
      try {
        req.resolve(`${consumer}/package.json`);
      } catch (err) {
        code = (err as NodeJS.ErrnoException).code;
      }
      expect(code, consumer).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
    }
  });

  it('resolves onnxruntime-node itself, so the probe above can tell a miss from a block', () => {
    // The control. Without it, "both consumers threw" is equally explained by a fixture where
    // nothing resolves at all — a self-corroborating result that proves nothing. onnxruntime-node
    // declares no `exports` map, so it is the one member of this tree that MUST resolve.
    const req = createRequire(join(root, 'noop.cjs'));
    expect(dirname(req.resolve('onnxruntime-node/package.json'))).toBe(
      join(root, 'node_modules', 'onnxruntime-node'),
    );
  });
});

describe('locateOrtRoots finds every copy on disk, not just the hoisted one', () => {
  let root: string;
  beforeAll(() => {
    root = buildMultiCopyTree();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds the nested copy the module resolver cannot reach', () => {
    // ⚠ The regression this slice fixes. On a tree where hoisting was defeated the old locator
    // returned ONE root, so the nested copy kept its ~178 MiB while the install log claimed the
    // prune had happened. Both copies must come back.
    const roots = locateOrtRoots(hoistedResolverFor(root), join(root, 'node_modules', 'wigolo'));
    expect(roots).toHaveLength(2);
    expect(roots).toContain(join(root, 'node_modules', 'onnxruntime-node'));
    expect(roots).toContain(join(root, '.store', 'onnxruntime-node'));
  });

  it('reports the copy both strategies find exactly once', () => {
    // The hoisted copy is reachable by the resolver AND by the on-disk scan. Two entries would
    // prune it twice — harmless — and report its freed bytes twice, which is not.
    const roots = locateOrtRoots(hoistedResolverFor(root), join(root, 'node_modules', 'wigolo'));
    expect(roots.filter((r: string) => r === join(root, 'node_modules', 'onnxruntime-node'))).toHaveLength(1);
  });

  it('still finds every copy when the resolver throws instead of answering', () => {
    // The resolver throwing is ordinary, not exceptional — a tree can hoist something else, or
    // hoist nothing. If that throw aborted the walk, this tree would silently keep every byte.
    // The on-disk scan is complete on its own, so BOTH copies must survive the resolver's loss.
    const roots = locateOrtRoots(() => {
      throw new Error('MODULE_NOT_FOUND');
    }, join(root, 'node_modules', 'wigolo'));
    expect(roots.sort()).toEqual(
      [join(root, '.store', 'onnxruntime-node'), join(root, 'node_modules', 'onnxruntime-node')].sort(),
    );
  });

  it('returns nothing when onnxruntime-node is not in the tree at all', () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-ort-empty-')));
    mkdirSync(join(empty, 'node_modules'), { recursive: true });
    try {
      expect(
        locateOrtRoots(() => {
          throw new Error('MODULE_NOT_FOUND');
        }, join(empty, 'node_modules', 'wigolo')),
      ).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does NOT reach a copy belonging to a different install above the install root', () => {
    // ⚠ The must-not-fire half. Walking up "until something is found" would let a prune run from
    // `~/project/node_modules/wigolo` delete binaries out of `~/node_modules` — another install's
    // files, on a machine where nobody asked. The scan is bounded to the tree that ran it.
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-ort-outer-')));
    try {
      const store = join(outer, '.store');
      mkdirSync(store, { recursive: true });
      buildOrtCopy(join(outer, 'node_modules', 'onnxruntime-node'), {
        bytesPerPair: 1024,
        symlinkPlatform: 'none',
        store,
        tag: 'outer',
      });
      const inner = join(outer, 'project');
      buildOrtCopy(join(inner, 'node_modules', 'onnxruntime-node'), {
        bytesPerPair: 1024,
        symlinkPlatform: 'none',
        store,
        tag: 'inner',
      });

      const roots = locateOrtRoots(() => {
        throw new Error('MODULE_NOT_FOUND');
      }, join(inner, 'node_modules', 'wigolo'));
      expect(roots).toEqual([join(inner, 'node_modules', 'onnxruntime-node')]);
      expect(roots).not.toContain(join(outer, 'node_modules', 'onnxruntime-node'));
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe('the module resolver is load-bearing where the on-disk scan is blind', () => {
  let root: string;
  beforeAll(() => {
    root = buildNestedWigoloTree();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const wigoloDir = () => join(root, 'node_modules', 'foo', 'node_modules', 'wigolo');

  it('the on-disk scan alone finds NOTHING from a nested install position', () => {
    // ⚠ The premise of the test below, asserted separately so the pair cannot both be satisfied
    // by an accident. wigolo's install root here is `<root>/node_modules/foo`, and that subtree
    // holds no onnxruntime-node: the hoisted copy is a level ABOVE it and bar's nested copy is
    // off to the SIDE. A scan bounded to the caller's own tree — which it must be — cannot see
    // either one, and no widening of the bound would be safe.
    expect(
      locateOrtRoots(() => {
        throw new Error('MODULE_NOT_FOUND');
      }, wigoloDir()),
    ).toEqual([]);
  });

  it('rescues the hoisted copy through the resolver, which the scan cannot reach', () => {
    // ⚠ Without this the `resolveFrom` branch has no test behind it, which is precisely the
    // defect this slice was opened to fix — a resolution strategy nothing exercises. Node's own
    // upward resolution walks `node_modules` ancestors and finds the hoisted copy from a position
    // the bounded scan is blind to. Delete the branch and this tree prunes nothing at all.
    const roots = locateOrtRoots(hoistedResolverFor(root), wigoloDir());
    expect(roots).toEqual([join(root, 'node_modules', 'onnxruntime-node')]);
  });
});

describe('findInstallRoot does not escape the package that called it', () => {
  it('returns nothing for a checkout that has not been installed yet', () => {
    // ⚠ The fallback branch is the only one with no `node_modules` on the path to halt it, so it
    // is the only one that can genuinely escape upward. A bare checkout sitting under some
    // unrelated install must yield NO copies rather than that install's — otherwise a prune run
    // from a source tree deletes another project's binaries.
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-ort-bare-')));
    try {
      const store = join(bare, '.store');
      mkdirSync(store, { recursive: true });
      buildOrtCopy(join(bare, 'node_modules', 'onnxruntime-node'), {
        bytesPerPair: 1024,
        symlinkPlatform: 'none',
        store,
        tag: 'foreign',
      });
      const checkout = join(bare, 'somewhere', 'wigolo');
      writePkg(checkout, { name: 'wigolo', version: '0.0.0' });
      mkdirSync(join(checkout, 'scripts', 'prune'), { recursive: true });

      const roots = locateOrtRoots(() => {
        throw new Error('MODULE_NOT_FOUND');
      }, join(checkout, 'scripts', 'prune'));
      expect(roots).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('still finds the tree of an installed checkout it is run from', () => {
    // The must-FIRE half of the bound above. `npm install` in a checkout, then the postinstall
    // runs from `<checkout>/scripts/prune` — the copy in the checkout's own node_modules is
    // exactly what it is supposed to prune, and a bound that refused here would cost the win.
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-ort-checkout-')));
    try {
      const store = join(bare, '.store');
      mkdirSync(store, { recursive: true });
      writePkg(bare, { name: 'wigolo', version: '0.0.0' });
      mkdirSync(join(bare, 'scripts', 'prune'), { recursive: true });
      buildOrtCopy(join(bare, 'node_modules', 'onnxruntime-node'), {
        bytesPerPair: 1024,
        symlinkPlatform: 'none',
        store,
        tag: 'own',
      });

      const roots = locateOrtRoots(() => {
        throw new Error('MODULE_NOT_FOUND');
      }, join(bare, 'scripts', 'prune'));
      expect(roots).toEqual([join(bare, 'node_modules', 'onnxruntime-node')]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * The layout the resolver escapes through: a FOREIGN install at `outer/node_modules`, and wigolo
 * installed into a project that merely sits beside it.
 *
 * `outer/proj` is not a package of `outer` — it is a different project that happens to live one
 * directory down. Node's resolution does not know that: from `outer/proj/node_modules/wigolo` it
 * walks `outer/proj/node_modules` then `outer/node_modules` and answers with a copy nobody here
 * is entitled to touch.
 *
 * @returns the outer root, the project root, and wigolo's own directory.
 */
function buildSiblingProjectTree(opts: { projHasOwnCopy: boolean }): {
  outer: string;
  proj: string;
  wigolo: string;
} {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-ort-sibling-')));
  const store = join(outer, '.store');
  mkdirSync(store, { recursive: true });
  writePkg(outer, { name: 'outer', version: '1.0.0' });
  buildOrtCopy(join(outer, 'node_modules', 'onnxruntime-node'), {
    bytesPerPair: 1024,
    symlinkPlatform: 'none',
    store,
    tag: 'foreign',
  });

  const proj = join(outer, 'proj');
  writePkg(proj, { name: 'proj', version: '1.0.0' });
  const wigolo = join(proj, 'node_modules', 'wigolo');
  writePkg(wigolo, { name: 'wigolo', version: '0.0.0' });
  if (opts.projHasOwnCopy) {
    buildOrtCopy(join(proj, 'node_modules', 'onnxruntime-node'), {
      bytesPerPair: 1024,
      symlinkPlatform: 'none',
      store,
      tag: 'ours',
    });
  }
  return { outer, proj, wigolo };
}

/** The `<platform>/<arch>` pairs still present in an onnxruntime-node copy. */
function pairsIn(copy: string): string[] {
  const binRoot = join(copy, 'bin', 'napi-v3');
  const out: string[] = [];
  for (const plat of readdirSync(binRoot)) {
    for (const arch of readdirSync(join(binRoot, plat))) out.push(`${plat}/${arch}`);
  }
  return out.sort();
}

describe('the resolver branch is bound to the tree that ran it', () => {
  const trees: string[] = [];
  afterAll(() => {
    for (const dir of trees) rmSync(dir, { recursive: true, force: true });
  });

  it('the resolver really does reach the foreign copy — the escape is observed, not assumed', () => {
    // ⚠ THE CONTROL, and without it every assertion below is self-corroborating. "locateOrtRoots
    // returned nothing" is equally explained by a fixture where nothing resolves at all, and a
    // bound that is never actually challenged is a bound with no evidence behind it. This asserts
    // the outside signal directly: Node's own resolution, from wigolo's position, answers with a
    // package directory belonging to `outer`. onnxruntime-node declares NO `exports` map — unlike
    // its consumers and unlike wreq-js — so `./package.json` resolves and the walk reaches upward.
    // That asymmetry is the whole reason this branch is live here and was dead for wreq-js.
    const { outer, wigolo } = buildSiblingProjectTree({ projHasOwnCopy: false });
    trees.push(outer);
    const req = createRequire(join(wigolo, 'noop.cjs'));
    expect(dirname(req.resolve('onnxruntime-node/package.json'))).toBe(
      join(outer, 'node_modules', 'onnxruntime-node'),
    );
  });

  it('MUST-NOT-FIRE: refuses the copy the resolver reached in an enclosing project', () => {
    // ⚠ The escape, as reproduced. `outer/node_modules/onnxruntime-node` is ~178 MiB of another
    // project's binaries, and that tree may be multi-arch on purpose — a Docker build context, a
    // multi-platform CI cache — whose owner has no reason to have set WIGOLO_SKIP_ORT_PRUNE. The
    // scan half was bounded for exactly this in #304; the resolver half was not, so the same
    // destruction was still one `npm install` away, and npm reports success while it happens.
    const { outer, wigolo } = buildSiblingProjectTree({ projHasOwnCopy: false });
    trees.push(outer);
    expect(locateOrtRoots(hoistedResolverFor(wigolo), wigolo)).toEqual([]);
  });

  it('MUST-FIRE: still returns our OWN copy from that same position', () => {
    // The other direction, and the reason this is a bound and not a deletion of the branch:
    // tightening must not cost us the copy we are entitled to prune. Identical layout, except
    // `proj` has its own hoisted copy — the resolver stops at that one, and it is ours.
    const { outer, proj, wigolo } = buildSiblingProjectTree({ projHasOwnCopy: true });
    trees.push(outer);
    expect(locateOrtRoots(hoistedResolverFor(wigolo), wigolo)).toEqual([
      join(proj, 'node_modules', 'onnxruntime-node'),
    ]);
  });

  it('the DRIVER leaves the enclosing project every pair it had, and says it pruned nothing', () => {
    // ⚠ At the seam the user actually meets, and on the fixture that reproduces the escape:
    // `proj` has NO copy of its own, so the only thing the resolver can reach by climbing is
    // `outer`'s. This is the case where the driver printed
    //   `kept darwin/arm64, removed darwin/x64, linux/arm64, ... (0 MiB)`
    // — a SUCCESSFUL-looking prune — while deleting five of six pairs out of a stranger's tree.
    // ⚠ The pairs AND the log line, because either alone is satisfiable for the wrong reason: an
    // intact tree is equally explained by a driver that crashed before doing anything.
    const { outer, wigolo } = buildSiblingProjectTree({ projHasOwnCopy: false });
    trees.push(outer);
    const runner = fileURLToPath(new URL('../../scripts/prune/run.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [runner, wigolo], { encoding: 'utf8' });

    expect(pairsIn(join(outer, 'node_modules', 'onnxruntime-node'))).toEqual(
      [...FIXTURE_PAIRS].sort(),
    );
    expect(out).not.toContain('platform prune — kept');
  });

  it('the DRIVER still prunes our OWN copy in that same layout', () => {
    // The must-fire half at the same seam, so a "bound" that simply stopped pruning anything at
    // all could not pass this file. `proj` has its own hoisted copy here; it goes, and `outer`'s
    // still does not.
    const { outer, proj, wigolo } = buildSiblingProjectTree({ projHasOwnCopy: true });
    trees.push(outer);
    const runner = fileURLToPath(new URL('../../scripts/prune/run.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [runner, wigolo], { encoding: 'utf8' });

    expect(pairsIn(join(proj, 'node_modules', 'onnxruntime-node'))).toEqual([HOST_PAIR]);
    expect(pairsIn(join(outer, 'node_modules', 'onnxruntime-node'))).toEqual(
      [...FIXTURE_PAIRS].sort(),
    );
    expect(out).toContain(`platform prune — kept ${HOST_PAIR}`);
  });
});

describe('findOutermostInstallRoot answers which TREE a directory belongs to', () => {
  const trees: string[] = [];
  afterAll(() => {
    for (const dir of trees) rmSync(dir, { recursive: true, force: true });
  });

  function tmpTree(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-ort-root-')));
    trees.push(dir);
    return dir;
  }

  it('leaves the ordinary dependency layout exactly where it was', () => {
    // `~/project/node_modules/wigolo` — the overwhelmingly common case, and the one that must not
    // move at all. `~/project` is not itself installed anywhere, so there is nothing above it.
    const root = tmpTree();
    expect(findOutermostInstallRoot(join(root, 'node_modules', 'wigolo'))).toBe(root);
  });

  it('climbs out of a NESTED install to the tree that contains it', () => {
    // ⚠ The case #307 gave up. `<root>/node_modules/foo` is itself a package of `<root>`'s tree,
    // so a copy hoisted to `<root>/node_modules` is ours as much as `foo` is. Stopping at `foo`
    // cost those bytes; the docstring called it an edge case, and it is not — see the note on
    // `locatePackageRoot`.
    const root = tmpTree();
    expect(
      findOutermostInstallRoot(join(root, 'node_modules', 'foo', 'node_modules', 'wigolo')),
    ).toBe(root);
  });

  it('climbs through a SCOPED nesting package too', () => {
    // `@scope/foo` sits one directory deeper than `foo`, because a scope directory is not a
    // package. A predicate that only checked "is my parent named node_modules" stops here and
    // silently gives the scoped half of the ecosystem the old, lossy answer.
    const root = tmpTree();
    expect(
      findOutermostInstallRoot(
        join(root, 'node_modules', '@scope', 'foo', 'node_modules', 'wigolo'),
      ),
    ).toBe(root);
  });

  it('STOPS at a project that merely sits beside another install', () => {
    // ⚠ The distinction the whole fix turns on, stated on its own. `outer/proj` and
    // `<root>/node_modules/foo` are both "the directory above my install root", and exactly one
    // of them is part of our tree. `proj` is not installed into `outer` — it is a different
    // project one directory down — so `outer`'s files are not ours and the climb must not happen.
    const outer = tmpTree();
    const proj = join(outer, 'proj');
    expect(findOutermostInstallRoot(join(proj, 'node_modules', 'wigolo'))).toBe(proj);
  });

  it('does not climb out of a project nested inside somebody else\'s package', () => {
    // The same distinction one level in, and the reason the predicate is "my install root is
    // itself an installed package" rather than the looser "my install root has a node_modules
    // somewhere on its path". A checkout at `outer/node_modules/pkg/proj` has node_modules on its
    // path and is still not a package of `outer` — the loose spelling climbs to `outer` and hands
    // back the escape this slice just closed.
    const outer = tmpTree();
    const proj = join(outer, 'node_modules', 'pkg', 'proj');
    expect(findOutermostInstallRoot(join(proj, 'node_modules', 'wigolo'))).toBe(proj);
  });

  it('still returns nothing for a checkout that has not been installed yet', () => {
    // The fallback branch's refusal, carried through the new climb rather than around it: a bare
    // source tree under some unrelated install must still claim no tree at all.
    const bare = tmpTree();
    const checkout = join(bare, 'somewhere', 'wigolo');
    writePkg(checkout, { name: 'wigolo', version: '0.0.0' });
    mkdirSync(join(checkout, 'scripts', 'prune'), { recursive: true });
    expect(findOutermostInstallRoot(join(checkout, 'scripts', 'prune'))).toBeNull();
  });
});

describe('the driver prunes EVERY copy in a tree where hoisting was defeated', () => {
  const runner = fileURLToPath(new URL('../../scripts/prune/run.mjs', import.meta.url));
  let root: string;
  let stdout: string;

  beforeAll(() => {
    root = buildMultiCopyTree();
    // argv[2] points the driver at this throwaway tree instead of the checkout it runs from.
    stdout = execFileSync(process.execPath, [runner, root], { encoding: 'utf8' });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('leaves both host pairs and removes every non-host pair from BOTH copies', () => {
    for (const copy of [join(root, 'node_modules', 'onnxruntime-node'), join(root, '.store', 'onnxruntime-node')]) {
      const binRoot = join(copy, 'bin', 'napi-v3');
      expect(existsSync(join(binRoot, process.platform, process.arch)), `${copy} host pair`).toBe(true);
      for (const pair of FIXTURE_PAIRS) {
        if (pair === HOST_PAIR) continue;
        expect(existsSync(join(binRoot, ...pair.split('/'))), `${copy} ${pair}`).toBe(false);
      }
    }
  });

  it('reports each copy freed bytes of its own, never the running total', () => {
    // ⚠ `60bf7139` moved this counter inside the per-root loop, but until copies could actually
    // be found more than one at a time there was no tree that could tell the two spellings apart.
    // Copy A's removable pairs total 3 MiB and copy B's total 6 MiB; an accumulating counter
    // reports 9 for the second, a number neither copy contains.
    const reported = [...stdout.matchAll(/platform prune — kept .*?\((\d+) MiB\)/g)].map((m) => Number(m[1]));
    expect(reported).toEqual([3, 6]);
  });
});
