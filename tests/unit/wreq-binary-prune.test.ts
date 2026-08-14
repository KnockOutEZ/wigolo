import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { planBinaryPrune, WREQ_PLATFORM_BINARIES } from '../../scripts/prune/wreq-binaries.mjs';
import { hasLoadableWreqBinary, wreqHostBinaries } from '../../src/cli/doctor.js';

/*
 * WHY these tests exist.
 *
 * `wreq-js@2.3.1` ships all seven prebuilt napi binaries in ONE tarball — 53.3 MiB of
 * `rust/wreq-js.<target>.node`, of which at most one pair can ever be loaded — and the prune
 * deletes six of them out of a user's install. The file it must never delete is the one the
 * loader requires, and losing that does not merely cost bytes: it silently disables the
 * TLS-impersonation tier, which is the anti-bot capability users churn over. So the decision
 * lives in a pure function and is asserted here rather than being discoverable only by running
 * an install and finding out that Cloudflare-fronted sites stopped working.
 *
 * The size measurement that motivates it is recorded on the G-DIET gate; a unit test cannot
 * perform an npm install. What IS testable is the decision, and every assertion below is about
 * a way the decision could strand a user.
 *
 * The real seven-binary layout of wreq-js@2.3.1, as shipped.
 */
const FULL_TREE = [
  'wreq-js.darwin-arm64.node',
  'wreq-js.darwin-x64.node',
  'wreq-js.linux-arm64-gnu.node',
  'wreq-js.linux-arm64-musl.node',
  'wreq-js.linux-x64-gnu.node',
  'wreq-js.linux-x64-musl.node',
  'wreq-js.win32-x64-msvc.node',
];

/** Every host the package's own loader claims to support. */
const SUPPORTED_HOSTS: Array<[string, string, string[]]> = [
  ['darwin', 'arm64', ['wreq-js.darwin-arm64.node']],
  ['darwin', 'x64', ['wreq-js.darwin-x64.node']],
  ['win32', 'x64', ['wreq-js.win32-x64-msvc.node']],
  ['linux', 'x64', ['wreq-js.linux-x64-gnu.node', 'wreq-js.linux-x64-musl.node']],
  ['linux', 'arm64', ['wreq-js.linux-arm64-gnu.node', 'wreq-js.linux-arm64-musl.node']],
];

describe('planBinaryPrune keeps exactly the binaries that can be loaded', () => {
  it('keeps only the host binary on darwin-arm64 and removes the other six', () => {
    const plan = planBinaryPrune(FULL_TREE, 'darwin', 'arm64');
    expect(plan.keep).toEqual(['wreq-js.darwin-arm64.node']);
    expect(plan.remove).toEqual([
      'wreq-js.darwin-x64.node',
      'wreq-js.linux-arm64-gnu.node',
      'wreq-js.linux-arm64-musl.node',
      'wreq-js.linux-x64-gnu.node',
      'wreq-js.linux-x64-musl.node',
      'wreq-js.win32-x64-msvc.node',
    ]);
  });

  it('removes the SAME-platform other architecture too', () => {
    // The tempting shortcut is to prune by platform name, which would leave darwin-x64 behind —
    // 7.4 MiB on an arm64 machine that nothing there can ever load. Selection is per-TARGET, and
    // this is the assertion that would notice a later simplification giving that back.
    expect(planBinaryPrune(FULL_TREE, 'darwin', 'arm64').remove).toContain('wreq-js.darwin-x64.node');
  });

  it('never proposes removing a binary the host could load, from any supported host', () => {
    for (const [platform, arch, expected] of SUPPORTED_HOSTS) {
      const plan = planBinaryPrune(FULL_TREE, platform, arch);
      expect(plan.keep, `${platform}/${arch}`).toEqual(expected);
      for (const kept of expected) {
        expect(plan.remove, `${platform}/${arch}`).not.toContain(kept);
      }
      expect(plan.remove, `${platform}/${arch}`).toHaveLength(FULL_TREE.length - expected.length);
    }
  });
});

describe('planBinaryPrune keeps BOTH libc builds on linux', () => {
  it('keeps gnu AND musl for the host arch', () => {
    // ⚠ THE DECISION THIS SLICE TURNS ON, and it is not a rounding error — it is 8 MiB
    // deliberately left on the floor on linux.
    //
    // The prune runs at postinstall; the load happens later, in a different process. The
    // package's own `detectLibc()` reads `process.env.LIBC ?? process.env.npm_config_libc`
    // FIRST, and `npm_config_libc` is set by npm during an install and absent at runtime. So
    // install-time detection and run-time detection can legitimately disagree on the same
    // machine, and an install-time answer therefore cannot be allowed to bind a run-time
    // selection. Keeping both removes the entire class rather than trying to predict it.
    expect(planBinaryPrune(FULL_TREE, 'linux', 'x64').keep).toEqual([
      'wreq-js.linux-x64-gnu.node',
      'wreq-js.linux-x64-musl.node',
    ]);
  });

  it('still removes the OTHER arch entirely on linux', () => {
    // Keeping both libc builds must not soften into keeping all of linux — arch is decided by
    // `process.arch`, which does not vary between install and run.
    const plan = planBinaryPrune(FULL_TREE, 'linux', 'x64');
    expect(plan.remove).toContain('wreq-js.linux-arm64-gnu.node');
    expect(plan.remove).toContain('wreq-js.linux-arm64-musl.node');
  });

  it('keeps the one that IS there when upstream ships only a single libc build', () => {
    // Fail-open: a shrinking upstream matrix must not turn into a refusal that costs the win,
    // nor into removing the only loadable file.
    const gnuOnly = FULL_TREE.filter((f) => f !== 'wreq-js.linux-x64-musl.node');
    const plan = planBinaryPrune(gnuOnly, 'linux', 'x64');
    expect(plan.keep).toEqual(['wreq-js.linux-x64-gnu.node']);
    expect(plan.remove).not.toContain('wreq-js.linux-x64-gnu.node');
  });
});

describe('planBinaryPrune refuses rather than guesses', () => {
  it('removes NOTHING on a host the loader does not support', () => {
    // ⚠ The case that decides whether this script can strand someone. On freebsd the loader
    // throws `Unsupported platform` no matter what is on disk — but the tree might have been
    // populated by some future mechanism we do not model, and then every candidate for removal
    // might be the one that loads. Removing nothing costs bytes; removing the wrong thing costs
    // the user their anti-bot tier, AFTER npm has reported success.
    const plan = planBinaryPrune(FULL_TREE, 'freebsd', 'x64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([]);
    expect(plan.reason).toContain('refusing to prune');
  });

  it('removes NOTHING on a supported platform with an unsupported ARCH', () => {
    // Distinct from the case above and easy to get wrong: a check on the platform name alone
    // would accept linux/riscv64 and then delete all seven binaries.
    const plan = planBinaryPrune(FULL_TREE, 'linux', 'riscv64');
    expect(plan.remove).toEqual([]);
    expect(plan.reason).toContain('refusing to prune');
  });

  it('removes NOTHING when the host binary is absent from the tree', () => {
    // A layout we do not recognise — a renamed target in a future wreq-js, or a partial
    // extraction. We cannot tell that from "already pruned to nothing", so we do not act.
    const withoutHost = FULL_TREE.filter((f) => f !== 'wreq-js.darwin-arm64.node');
    const plan = planBinaryPrune(withoutHost, 'darwin', 'arm64');
    expect(plan.remove).toEqual([]);
    expect(plan.reason).toContain('refusing to prune');
  });
});

describe('planBinaryPrune only ever removes binaries it recognises', () => {
  it('never removes the generic `wreq-js.node` fallback', () => {
    // ⚠ Not hypothetical: the loader's SECOND attempt for every single target is
    // `require('../rust/wreq-js.node')`. It is absent from the published 2.3.1 tarball, but a
    // locally built or repacked install has it, and deleting it there would remove the fallback
    // that a failed primary load depends on.
    const withGeneric = [...FULL_TREE, 'wreq-js.node'];
    expect(planBinaryPrune(withGeneric, 'darwin', 'arm64').remove).not.toContain('wreq-js.node');
  });

  it('never removes a target it has never heard of', () => {
    // The allowlist is the point. If a future wreq-js adds `linux-x64-gnu-2.28` or an
    // `android-arm64` target, the honest answer is "we do not know whether that loads here", and
    // the safe direction is to leave it. Costing bytes is recoverable; deleting the file the
    // loader wanted is not.
    const withFuture = [...FULL_TREE, 'wreq-js.android-arm64.node'];
    const plan = planBinaryPrune(withFuture, 'darwin', 'arm64');
    expect(plan.remove).not.toContain('wreq-js.android-arm64.node');
    expect(plan.remove).toHaveLength(6);
  });

  it('agrees with doctor about which binaries this host can load', () => {
    // ⚠ TWO COPIES OF ONE FACT, PINNED TOGETHER. The prune decides which binary SURVIVES;
    // `wreqHostBinaries` in src/cli/doctor.ts decides whether one is THERE. They cannot share a
    // module — the prune is plain-JS build tooling that never enters the bundled src/ graph — so
    // the only thing stopping them drifting is this assertion. Drift is not cosmetic: if the
    // prune kept a file doctor did not look for, doctor would report the TLS tier dead while it
    // worked; if doctor looked for one the prune deleted, it would report it alive while it was
    // dead. That second direction is the bug this pairing was written to close.
    for (const [platform, arch] of [...SUPPORTED_HOSTS.map(([p, a]) => [p, a]), ['freebsd', 'x64'], ['linux', 'riscv64']] as Array<[string, string]>) {
      expect(wreqHostBinaries(platform, arch), `${platform}/${arch}`).toEqual(
        planBinaryPrune(FULL_TREE, platform, arch).keep,
      );
    }
  });

  it('reports the tier DEAD when the prune has left no binary this host can load', () => {
    // ⚠ THE STATE THIS PRUNE NEWLY CREATES. Resolving the package says nothing about `rust/`, so
    // the old resolve-only probe answered "available" for a tree with no binaries at all and
    // doctor printed `wreq-js ✓` over a dead tier. Pre-prune that was close to unreachable —
    // npm's os/cpu filtering meant package-present implied binary-present — so this assertion
    // exists because THIS change made the state reachable.
    const root = mkdtempSync(join(tmpdir(), 'wreq-doctor-'));
    trees.push(root);
    mkdirSync(join(root, 'rust'), { recursive: true });
    expect(hasLoadableWreqBinary(root, process.platform, process.arch)).toBe(false);
  });

  it('reports the tier ALIVE on exactly what the prune leaves behind', () => {
    // The must-not-fire direction: the prune and the probe have to agree, or doctor calls a
    // working tier dead. Built from the planner's own keep-set so the two cannot drift apart.
    const root = mkdtempSync(join(tmpdir(), 'wreq-doctor-'));
    trees.push(root);
    mkdirSync(join(root, 'rust'), { recursive: true });
    const kept = planBinaryPrune(FULL_TREE, process.platform, process.arch).keep;
    for (const name of kept) writeFileSync(join(root, 'rust', name), 'x');
    expect(hasLoadableWreqBinary(root, process.platform, process.arch)).toBe(kept.length > 0);
  });

  it('recognises exactly the seven targets the package declares', () => {
    // Pins the allowlist against the manifest's `napi.targets`. If upstream's matrix changes,
    // this is the assertion that makes someone look rather than silently pruning to a stale list.
    expect([...WREQ_PLATFORM_BINARIES].sort()).toEqual([...FULL_TREE].sort());
  });
});

describe('planBinaryPrune is idempotent', () => {
  it('proposes nothing on a tree it has already pruned, and does NOT call that a refusal', () => {
    // npm re-runs a package's postinstall on installs that did not re-extract it, so the second
    // run is the common case, not an edge one. It must report "nothing to do" — a refusal there
    // would read as a broken layout in the install log every time.
    const plan = planBinaryPrune(['wreq-js.darwin-arm64.node'], 'darwin', 'arm64');
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual(['wreq-js.darwin-arm64.node']);
    expect(plan.reason).not.toContain('refusing');
    expect(plan.reason).toContain('nothing to do');
  });

  it('is stable under re-application on linux, where two files survive', () => {
    const first = planBinaryPrune(FULL_TREE, 'linux', 'arm64');
    const second = planBinaryPrune(first.keep, 'linux', 'arm64');
    expect(second.remove).toEqual([]);
    expect(second.keep).toEqual(first.keep);
  });
});

/*
 * The seam, not the decision.
 *
 * ⚠ These exist because the decision being right is NOT enough: the postinstall also has to FIND
 * the package, and the way this fails is silent. `require.resolve('wreq-js/package.json')` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED — wreq-js declares an `exports` map with no `./package.json`
 * entry, exactly like onnxruntime-web and fastembed — so the obvious spelling would find nothing,
 * report nothing, and cost the entire win while the install log looked clean.
 *
 * The layout that matters most is the one NOBODY runs while developing: wigolo installed as a
 * DEPENDENCY, which is what `npx wigolo` and `npm i wigolo` actually produce. The gate measures a
 * tree where wigolo's own package.json is the install root, so the gate alone cannot prove this.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRUNE_RUNNER = join(REPO_ROOT, 'scripts', 'prune', 'run.mjs');
const trees: string[] = [];

afterAll(() => {
  for (const dir of trees) rmSync(dir, { recursive: true, force: true });
});

/** Plant a fake `wreq-js` with all seven binaries under `<at>/node_modules`. */
function plantWreq(at: string): void {
  const pkg = join(at, 'node_modules', 'wreq-js');
  mkdirSync(join(pkg, 'rust'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'wreq-js', version: '2.3.1' }));
  for (const name of FULL_TREE) writeFileSync(join(pkg, 'rust', name), 'x'.repeat(1024));
}

/**
 * A throwaway install tree holding a fake `wreq-js` with all seven binaries.
 *
 * ⚠ Built under the OS tmpdir, i.e. OUTSIDE this checkout. A fixture inside the repo would sit
 * under a node_modules the runner could walk up into, and the prune would operate on the real
 * dependency tree instead of the fixture.
 */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'wreq-prune-'));
  trees.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host-app', version: '1.0.0' }));
  plantWreq(root);
  return root;
}

/** Run the real postinstall driver against `resolveFrom`, returning its stdout. */
function runPrune(resolveFrom: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [PRUNE_RUNNER, resolveFrom], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** The binaries left in `root`'s wreq-js after a run. */
function survivors(root: string): string[] {
  return readdirSync(join(root, 'node_modules', 'wreq-js', 'rust')).sort();
}

/**
 * What SHOULD survive a run on whatever host the suite is executing on.
 *
 * ⚠ Derived from the planner rather than hardcoded to darwin, and the refusal branch is not
 * decoration. On a host outside the loader's supported matrix — win32 on arm64, or linux on
 * anything but x64/arm64 — the correct behaviour is to remove NOTHING, so the expected survivors
 * are the whole tree. Asserting `plan.keep` unconditionally would red on exactly those runners
 * for doing the right thing, which is a cross-platform failure discovered in CI rather than here.
 */
function expectedSurvivors(): string[] {
  const plan = planBinaryPrune(FULL_TREE, process.platform, process.arch);
  return plan.remove.length > 0 ? [...plan.keep].sort() : [...FULL_TREE].sort();
}

/**
 * The log line the driver must emit on THIS host — `removing` where the host is supported,
 * `refusing to prune` where it is not.
 *
 * ⚠ WHY THE SURVIVOR SET ALONE IS NOT ENOUGH. On a host outside the loader's matrix
 * `expectedSurvivors()` is the whole tree, so an assertion on it passes for a prune that
 * correctly refused AND for one that never found the package, never ran, or silently threw. That
 * is a test that can pass for the wrong reason on a future runner. Pairing it with the reason
 * the driver PRINTED makes both outcomes fail-loud instead of vacuous.
 */
function expectedPruneVerb(): RegExp {
  return planBinaryPrune(FULL_TREE, process.platform, process.arch).remove.length > 0
    ? /wreq-js binary prune — keeping .*removing \d+ non-host/
    : /wreq-js binary prune — .*refusing to prune/;
}

describe('the postinstall driver finds wreq-js and prunes it', () => {
  it('prunes when wigolo IS the install root — the layout the budget gate measures', () => {
    const root = makeTree();
    const out = runPrune(root);
    expect(out).toMatch(expectedPruneVerb());
    expect(survivors(root)).toEqual(expectedSurvivors());
  });

  it('prunes the HOISTED copy when wigolo is installed as a dependency', () => {
    // ⚠ THE LAYOUT A REAL `npx wigolo` / `npm i wigolo` USER GETS, and the one the gate cannot
    // see. wigolo sits at <root>/node_modules/wigolo while wreq-js is hoisted beside it at
    // <root>/node_modules/wreq-js — so the runner has to walk UP and ACROSS, not just down. A
    // resolver-based lookup that happened to work from a checkout can fail exactly here.
    const root = makeTree();
    const asDependency = join(root, 'node_modules', 'wigolo');
    mkdirSync(asDependency, { recursive: true });
    const out = runPrune(asDependency);
    expect(out).toMatch(expectedPruneVerb());
    expect(survivors(root)).toEqual(expectedSurvivors());
  });

  it('leaves every binary in place when the prune is opted out of', () => {
    // The documented escape hatch for anyone deliberately assembling a multi-arch tree. If it
    // stops covering this prune, that person silently loses six binaries they asked to keep.
    const root = makeTree();
    runPrune(root, { WIGOLO_SKIP_ORT_PRUNE: '1' });
    expect(survivors(root)).toEqual([...FULL_TREE].sort());
  });

  /*
   * ⚠ THE BOUND, AND WHY IT IS NOT OPTIONAL.
   *
   * The walk-up used to halt only on finding `node_modules/<name>`, so from a nested install it
   * would climb past its OWN install root and out into whatever sat above — and prune a
   * `wreq-js` belonging to a different project. `npm i wigolo --omit=optional` inside a nested
   * package, next to a workspace root whose hoisted `wreq-js` is deliberately multi-arch (a
   * Docker build context, a multi-platform CI cache), is a real arrangement, and its owner has
   * no reason to have set the opt-out. This is the same defect #304 fixed for the onnxruntime
   * scan, so the bound is that commit's `findInstallRoot`, reused rather than reinvented.
   */
  function makeNestedLayout(): { outer: string; proj: string; wigolo: string } {
    const outer = mkdtempSync(join(tmpdir(), 'wreq-outer-'));
    trees.push(outer);
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'outer', version: '1.0.0' }));
    plantWreq(outer); // the FOREIGN tree — belongs to `outer`, not to us

    const proj = join(outer, 'proj');
    const wigolo = join(proj, 'node_modules', 'wigolo');
    mkdirSync(wigolo, { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'proj', version: '1.0.0' }));
    return { outer, proj, wigolo };
  }

  it('MUST-NOT-FIRE: leaves a wreq-js belonging to an enclosing project untouched', () => {
    // wigolo is installed into `proj` with no wreq-js beside it. The only wreq-js reachable by
    // climbing is `outer`'s, and it is not ours to touch. Destroying it would be silent, would
    // survive npm reporting success, and would strand a tree that was multi-arch on purpose.
    const { outer, wigolo } = makeNestedLayout();
    const out = runPrune(wigolo);
    expect(survivors(outer)).toEqual([...FULL_TREE].sort());
    expect(out).not.toContain('removing');
  });

  it('MUST-FIRE: still prunes our OWN copy in that same nested layout', () => {
    // The other direction, and the reason the bound is a bound rather than a deletion: tightening
    // must not cost us the copy we are actually entitled to prune. Same shape as above, except
    // `proj` has its own hoisted wreq-js — that one goes, and `outer`'s still does not.
    //
    // ⚠ THE VERB IS PART OF THE ASSERTION, and this was the one driver test in this file without
    // it. On a host outside the loader's matrix `expectedSurvivors()` is the WHOLE tree, and so is
    // `outer`'s expectation — so both survivor checks pass identically whether the walk reached
    // `proj` at all, whether the driver found the package, and whether it ran. Every CI leg is a
    // supported host, which is exactly what makes that latent rather than harmless: it would go on
    // passing until the day it mattered. The sibling tests already pair the two; this one now does.
    const { outer, proj, wigolo } = makeNestedLayout();
    plantWreq(proj);
    const out = runPrune(wigolo);
    expect(out).toMatch(expectedPruneVerb());
    expect(survivors(proj)).toEqual(expectedSurvivors());
    expect(survivors(outer)).toEqual([...FULL_TREE].sort());
  });

  it('prunes a copy hoisted ABOVE our install root when wigolo itself was nested', () => {
    // ⚠ THE FAIL-OPEN LOSS #307 ACCEPTED, now recovered. npm nests wigolo at
    // `<root>/node_modules/foo/node_modules/wigolo` when `foo` pins a version of one of wigolo's
    // dependencies that the hoisted copy cannot satisfy — and from there the walk used to stop at
    // `<root>/node_modules/foo`, leaving ~46 MiB of wreq-js binaries at `<root>/node_modules`
    // untouched.
    //
    // ⚠ AND THE LOSS WAS UNDERSTATED. #307's note called this an edge case. Nesting at all is the
    // rare part; CONDITIONAL on nesting, npm's hoisting makes the above-root placement the LIKELY
    // one, because hoisting is what puts a shared dependency at the top in the first place. So the
    // bound was costing the bytes in most of the cases it applied to, not a corner of them.
    //
    // `foo` is a package OF `<root>`'s tree, so `<root>/node_modules` is ours exactly as much as
    // `foo` is — which is the distinction that lets this be recovered without reopening the
    // enclosing-project escape asserted two tests up.
    const root = makeTree();
    const wigolo = join(root, 'node_modules', 'foo', 'node_modules', 'wigolo');
    mkdirSync(wigolo, { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'foo', 'package.json'),
      JSON.stringify({ name: 'foo', version: '1.0.0' }),
    );
    const out = runPrune(wigolo);
    expect(out).toMatch(expectedPruneVerb());
    expect(survivors(root)).toEqual(expectedSurvivors());
  });

  it('survives a tree with no wreq-js at all', () => {
    // `--omit=optional` is a supported install, and so is a platform npm skipped. A postinstall
    // that threw here would fail the whole install over an absent optional dependency.
    const root = mkdtempSync(join(tmpdir(), 'wreq-prune-none-'));
    trees.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host-app', version: '1.0.0' }));
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    expect(() => runPrune(root)).not.toThrow();
    expect(existsSync(join(root, 'node_modules', 'wreq-js'))).toBe(false);
  });
});
