import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { planPrebuildPrune, SQLITE_PREBUILDS } from '../../scripts/prune/sqlite-prebuilds.mjs';

/*
 * WHY these tests exist.
 *
 * `better-sqlite3@13` ships all eight Node-API prebuilds in ONE tarball — 16 MiB of
 * `prebuilds/<target>.node`, of which at most one (two on linux) can ever be loaded. The prune
 * deletes the rest out of a user's install.
 *
 * ⚠ AND THE COST OF GETTING IT WRONG IS HIGHER HERE THAN FOR ANY OTHER PRUNE IN THIS DIRECTORY.
 * The other three guard optional capabilities: lose the wrong onnxruntime binary and embeddings
 * degrade, lose the wrong wreq-js binary and the TLS tier goes quiet. `better-sqlite3` is the
 * cache database — it is not optional, and its loader does not degrade. When
 * `getPrebuildPath()` finds nothing, `lib/binding.js` falls through to `build/Release`, which v13
 * does not ship, and `require` throws. So deleting the host's prebuild does not make the install
 * smaller-but-working, it makes it broken, AFTER npm has reported success. Every assertion below
 * is about a way the decision could produce that.
 *
 * The size measurement that motivates it is recorded on the G-DIET gate; a unit test cannot
 * perform an npm install. What IS testable is the decision.
 *
 * The real eight-prebuild layout of better-sqlite3@13.0.3, as shipped.
 */
const FULL_TREE = [
  'darwin-arm64.node',
  'darwin-x64.node',
  'linux-arm64.node',
  'linux-x64.node',
  'linuxmusl-arm64.node',
  'linuxmusl-x64.node',
  'win32-arm64.node',
  'win32-x64.node',
];

/** Every host the package's own loader computes a prebuild path for. */
const SUPPORTED_HOSTS: Array<[string, string, string[]]> = [
  ['darwin', 'arm64', ['darwin-arm64.node']],
  ['darwin', 'x64', ['darwin-x64.node']],
  ['win32', 'arm64', ['win32-arm64.node']],
  ['win32', 'x64', ['win32-x64.node']],
  ['linux', 'x64', ['linux-x64.node', 'linuxmusl-x64.node']],
  ['linux', 'arm64', ['linux-arm64.node', 'linuxmusl-arm64.node']],
];

describe('planPrebuildPrune keeps exactly the prebuilds that can be loaded', () => {
  it('keeps only the host prebuild on darwin-arm64 and removes the other seven', () => {
    const plan = planPrebuildPrune(FULL_TREE, 'darwin', 'arm64');
    expect(plan.keep).toEqual(['darwin-arm64.node']);
    expect(plan.remove).toEqual([
      'darwin-x64.node',
      'linux-arm64.node',
      'linux-x64.node',
      'linuxmusl-arm64.node',
      'linuxmusl-x64.node',
      'win32-arm64.node',
      'win32-x64.node',
    ]);
  });

  it('removes the SAME-platform other architecture too', () => {
    // The tempting shortcut is to prune by platform name, which would leave darwin-x64 behind —
    // ~1.9 MiB on an arm64 machine that nothing there can ever load. The loader's target is
    // `${platform}-${arch}`, so selection is per-TARGET.
    expect(planPrebuildPrune(FULL_TREE, 'darwin', 'arm64').remove).toContain('darwin-x64.node');
  });

  it('never proposes removing a prebuild the host could load, from any supported host', () => {
    for (const [platform, arch, expected] of SUPPORTED_HOSTS) {
      const plan = planPrebuildPrune(FULL_TREE, platform, arch);
      expect(plan.keep, `${platform}/${arch}`).toEqual(expected);
      for (const kept of expected) {
        expect(plan.remove, `${platform}/${arch}`).not.toContain(kept);
      }
      expect(plan.remove, `${platform}/${arch}`).toHaveLength(FULL_TREE.length - expected.length);
    }
  });

  it('keeps win32-arm64 — a target the OTHER native prunes in this repo have no equivalent of', () => {
    // ⚠ Not decoration. `wreq-js` ships no win32-arm64 binary, so the sibling prune's host table
    // has no such row, and a reader porting that table across would silently produce an empty
    // keep-set here — which is the refusal branch, i.e. the whole win quietly lost on Windows ARM.
    // better-sqlite3 DOES ship it, so it must be kept, and it must not be confused with x64.
    const plan = planPrebuildPrune(FULL_TREE, 'win32', 'arm64');
    expect(plan.keep).toEqual(['win32-arm64.node']);
    expect(plan.remove).toContain('win32-x64.node');
  });
});

describe('planPrebuildPrune keeps BOTH libc builds on linux', () => {
  it('keeps the glibc AND musl builds for the host arch', () => {
    // ⚠ THE DELIBERATE ~2 MiB LEFT ON THE FLOOR ON LINUX.
    //
    // The loader's `isLinuxMusl()` reads `process.report.getReport().header.glibcVersionRuntime`,
    // which is a genuine runtime probe — better than the env-var sniff `wreq-js` uses, so the
    // reasoning is NOT simply inherited. It still runs in a different PROCESS from this script:
    // the prune happens at install time, and a multi-stage container that populates a tree under
    // glibc and runs it under musl is an ordinary layout, not a contrivance. An install-time
    // answer must not bind a run-time selection, so both stay.
    expect(planPrebuildPrune(FULL_TREE, 'linux', 'x64').keep).toEqual([
      'linux-x64.node',
      'linuxmusl-x64.node',
    ]);
  });

  it('still removes the OTHER arch entirely on linux', () => {
    // Keeping both libc builds must not soften into keeping all of linux — arch is decided by
    // `process.arch`, which does not vary between install and run.
    const plan = planPrebuildPrune(FULL_TREE, 'linux', 'x64');
    expect(plan.remove).toContain('linux-arm64.node');
    expect(plan.remove).toContain('linuxmusl-arm64.node');
  });

  it('keeps the one that IS there when upstream ships only a single libc build', () => {
    // Fail-open: a shrinking upstream matrix must not turn into a refusal that costs the win, nor
    // into removing the only loadable file.
    const gnuOnly = FULL_TREE.filter((f) => f !== 'linuxmusl-x64.node');
    const plan = planPrebuildPrune(gnuOnly, 'linux', 'x64');
    expect(plan.keep).toEqual(['linux-x64.node']);
    expect(plan.remove).not.toContain('linux-x64.node');
  });
});

describe('planPrebuildPrune refuses rather than guesses', () => {
  it('removes NOTHING on a host the loader computes no prebuild for', () => {
    // ⚠ The case that decides whether this script can break someone's install. On freebsd
    // `getPrebuildPath()` returns null and the package can only work via a source build under
    // `build/Release` — but the `prebuilds/` tree might have been populated by some mechanism we
    // do not model, and then every candidate for removal might be the one that loads.
    const plan = planPrebuildPrune(FULL_TREE, 'freebsd', 'x64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([]);
    expect(plan.reason).toContain('refusing to prune');
  });

  it('removes NOTHING on a supported platform with an unsupported ARCH', () => {
    // Distinct from the case above and easy to get wrong: a check on the platform name alone
    // would accept linux/riscv64 and then delete all eight prebuilds, leaving a tree whose cache
    // database cannot open at all.
    const plan = planPrebuildPrune(FULL_TREE, 'linux', 'riscv64');
    expect(plan.remove).toEqual([]);
    expect(plan.reason).toContain('refusing to prune');
  });

  it('removes NOTHING when the host prebuild is absent from the tree', () => {
    // A source-built or partially-extracted tree. We cannot tell that from "already pruned to
    // nothing", so we do not act — and here inaction is the only safe direction, because the
    // loader's fallback path (`build/Release`) may be exactly what such a tree is relying on.
    const withoutHost = FULL_TREE.filter((f) => f !== 'darwin-arm64.node');
    const plan = planPrebuildPrune(withoutHost, 'darwin', 'arm64');
    expect(plan.remove).toEqual([]);
    expect(plan.reason).toContain('refusing to prune');
  });
});

describe('planPrebuildPrune only ever removes prebuilds it recognises', () => {
  it('never removes a target it has never heard of', () => {
    // The allowlist is the point. If a future better-sqlite3 adds `android-arm64` or a
    // glibc-versioned target, the honest answer is "we do not know whether that loads here".
    const withFuture = [...FULL_TREE, 'android-arm64.node'];
    const plan = planPrebuildPrune(withFuture, 'darwin', 'arm64');
    expect(plan.remove).not.toContain('android-arm64.node');
    expect(plan.remove).toHaveLength(7);
  });

  it('never removes a non-prebuild file that shares the directory', () => {
    // `prebuilds/` is the package's own directory and a future release may put a manifest or a
    // checksum file in it. Only the eight known targets are removable.
    const withStray = [...FULL_TREE, 'index.json', 'README.md'];
    const plan = planPrebuildPrune(withStray, 'darwin', 'arm64');
    expect(plan.remove).not.toContain('index.json');
    expect(plan.remove).not.toContain('README.md');
  });

  it('recognises exactly the eight targets the package ships', () => {
    // Pins the allowlist against the published tarball. If upstream's matrix changes, this is the
    // assertion that makes someone look rather than silently pruning to a stale list.
    expect([...SQLITE_PREBUILDS].sort()).toEqual([...FULL_TREE].sort());
  });

  it('MUST-NOT-FIRE: `linuxmusl` is never produced by interpolating process.platform', () => {
    // ⚠ THE TRAP THIS ALLOWLIST EXISTS FOR, pinned as a property rather than a comment. These
    // names look interpolatable — `${platform}-${arch}.node` — and for six of the eight they are.
    // `linuxmusl` is not a value `process.platform` ever takes, so a pattern-based prune that
    // trusted interpolation would classify both musl builds as foreign on EVERY linux host and
    // delete the file a musl host is the only one that can load. Asserting the keep-set contains a
    // name no host reports is what makes that failure impossible to reintroduce quietly.
    const keep = planPrebuildPrune(FULL_TREE, 'linux', 'x64').keep;
    expect(keep).toContain('linuxmusl-x64.node');
    expect(keep.some((f: string) => f.startsWith(`${'linux'}-`))).toBe(true);
  });
});

describe('planPrebuildPrune is idempotent', () => {
  it('proposes nothing on a tree it has already pruned, and does NOT call that a refusal', () => {
    // npm re-runs a package's postinstall on installs that did not re-extract it, so the second
    // run is the common case, not an edge one. It must report "nothing to do" — a refusal there
    // would read as a broken layout in the install log every time.
    const plan = planPrebuildPrune(['darwin-arm64.node'], 'darwin', 'arm64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual(['darwin-arm64.node']);
    expect(plan.reason).not.toContain('refusing');
    expect(plan.reason).toContain('nothing to do');
  });

  it('is stable under re-application on linux, where two files survive', () => {
    const first = planPrebuildPrune(FULL_TREE, 'linux', 'arm64');
    const second = planPrebuildPrune(first.keep, 'linux', 'arm64');
    expect(second.remove).toEqual([]);
    expect(second.keep).toEqual(first.keep);
  });
});

/*
 * The seam, not the decision.
 *
 * The driver also has to FIND the package. `better-sqlite3` declares no `exports` map, so unlike
 * wreq-js the resolver spelling would work here — but the walk-up is shared code with a bound that
 * matters, and the layout that matters most is the one nobody runs while developing: wigolo
 * installed as a DEPENDENCY, which is what `npx wigolo` and `npm i wigolo` produce.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRUNE_RUNNER = join(REPO_ROOT, 'scripts', 'prune', 'run.mjs');
const trees: string[] = [];

afterAll(() => {
  for (const dir of trees) rmSync(dir, { recursive: true, force: true });
});

/** Plant a fake `better-sqlite3` with all eight prebuilds under `<at>/node_modules`. */
function plantSqlite(at: string): void {
  const pkg = join(at, 'node_modules', 'better-sqlite3');
  mkdirSync(join(pkg, 'prebuilds'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '13.0.3' }));
  for (const name of FULL_TREE) writeFileSync(join(pkg, 'prebuilds', name), 'x'.repeat(1024));
}

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'bs3-prune-'));
  trees.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host-app', version: '1.0.0' }));
  plantSqlite(root);
  return root;
}

/** Run the real postinstall driver against `resolveFrom`, returning its stdout. */
function runPrune(resolveFrom: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [PRUNE_RUNNER, resolveFrom], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** The prebuilds left in `root`'s better-sqlite3 after a run. */
function survivors(root: string): string[] {
  return readdirSync(join(root, 'node_modules', 'better-sqlite3', 'prebuilds')).sort();
}

/**
 * What SHOULD survive a run on whatever host the suite is executing on.
 *
 * Derived from the planner rather than hardcoded to darwin: on a host outside the loader's matrix
 * the correct behaviour is to remove NOTHING, so the expected survivors are the whole tree.
 */
function expectedSurvivors(): string[] {
  const plan = planPrebuildPrune(FULL_TREE, process.platform, process.arch);
  return plan.remove.length > 0 ? [...plan.keep].sort() : [...FULL_TREE].sort();
}

/**
 * The log line the driver must emit on THIS host.
 *
 * ⚠ WHY THE SURVIVOR SET ALONE IS NOT ENOUGH. On a host outside the loader's matrix
 * `expectedSurvivors()` is the whole tree, so an assertion on it passes for a prune that correctly
 * refused AND for one that never found the package, never ran, or silently threw. Pairing it with
 * the reason the driver PRINTED makes both outcomes fail-loud instead of vacuous.
 */
function expectedPruneVerb(): RegExp {
  return planPrebuildPrune(FULL_TREE, process.platform, process.arch).remove.length > 0
    ? /better-sqlite3 prebuild prune — keeping .*removing \d+ non-host/
    : /better-sqlite3 prebuild prune — .*refusing to prune/;
}

describe('the postinstall driver finds better-sqlite3 and prunes it', () => {
  it('prunes when wigolo IS the install root — the layout the budget gate measures', () => {
    const root = makeTree();
    const out = runPrune(root);
    expect(out).toMatch(expectedPruneVerb());
    expect(survivors(root)).toEqual(expectedSurvivors());
  });

  it('prunes the HOISTED copy when wigolo is installed as a dependency', () => {
    // ⚠ THE LAYOUT A REAL `npx wigolo` / `npm i wigolo` USER GETS, and the one the gate cannot
    // see: wigolo at <root>/node_modules/wigolo, better-sqlite3 hoisted beside it.
    const root = makeTree();
    const asDependency = join(root, 'node_modules', 'wigolo');
    mkdirSync(asDependency, { recursive: true });
    const out = runPrune(asDependency);
    expect(out).toMatch(expectedPruneVerb());
    expect(survivors(root)).toEqual(expectedSurvivors());
  });

  it('leaves every prebuild in place when the prune is opted out of', () => {
    // The documented escape hatch for anyone deliberately assembling a multi-arch tree.
    const root = makeTree();
    runPrune(root, { WIGOLO_SKIP_ORT_PRUNE: '1' });
    expect(survivors(root)).toEqual([...FULL_TREE].sort());
  });

  it('MUST-NOT-FIRE: leaves a better-sqlite3 belonging to an enclosing project untouched', () => {
    // wigolo is installed into `proj` with no better-sqlite3 beside it. The only one reachable by
    // climbing belongs to `outer`, and destroying its prebuilds would break a DIFFERENT project's
    // database — silently, after npm reported success, in a tree that was multi-arch on purpose.
    const outer = mkdtempSync(join(tmpdir(), 'bs3-outer-'));
    trees.push(outer);
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'outer', version: '1.0.0' }));
    plantSqlite(outer);
    const proj = join(outer, 'proj');
    const wigolo = join(proj, 'node_modules', 'wigolo');
    mkdirSync(wigolo, { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'proj', version: '1.0.0' }));

    const out = runPrune(wigolo);
    expect(survivors(outer)).toEqual([...FULL_TREE].sort());
    expect(out).not.toMatch(/better-sqlite3 prebuild prune — keeping .*removing/);
  });

  it('survives a tree with no better-sqlite3 at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'bs3-prune-none-'));
    trees.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host-app', version: '1.0.0' }));
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    expect(() => runPrune(root)).not.toThrow();
    expect(existsSync(join(root, 'node_modules', 'better-sqlite3'))).toBe(false);
  });

  it('survives a better-sqlite3 with no prebuilds/ directory — the v12 source-build layout', () => {
    // ⚠ THE REGRESSION DIRECTION OF THIS WHOLE SLICE. Before the v13 bump the package had no
    // `prebuilds/` at all, only `build/Release`. Anyone whose tree still looks like that (a source
    // build, or a downgrade) must see the driver do nothing quietly rather than throw and fail
    // their install.
    const root = mkdtempSync(join(tmpdir(), 'bs3-prune-src-'));
    trees.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host-app', version: '1.0.0' }));
    const pkg = join(root, 'node_modules', 'better-sqlite3');
    mkdirSync(join(pkg, 'build', 'Release'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '12.9.0' }));
    writeFileSync(join(pkg, 'build', 'Release', 'better_sqlite3.node'), 'x');

    expect(() => runPrune(root)).not.toThrow();
    expect(existsSync(join(pkg, 'build', 'Release', 'better_sqlite3.node'))).toBe(true);
  });
});
