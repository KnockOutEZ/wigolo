import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { planBinaryPrune, WREQ_PLATFORM_BINARIES } from '../../scripts/prune/wreq-binaries.mjs';

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
  const rust = join(root, 'node_modules', 'wreq-js', 'rust');
  mkdirSync(rust, { recursive: true });
  writeFileSync(join(root, 'node_modules', 'wreq-js', 'package.json'), JSON.stringify({ name: 'wreq-js', version: '2.3.1' }));
  for (const name of FULL_TREE) writeFileSync(join(rust, name), 'x'.repeat(1024));
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

describe('the postinstall driver finds wreq-js and prunes it', () => {
  it('prunes when wigolo IS the install root — the layout the budget gate measures', () => {
    const root = makeTree();
    const out = runPrune(root);
    expect(out).toContain('wreq-js binary prune');
    expect(survivors(root)).toEqual(planBinaryPrune(FULL_TREE, process.platform, process.arch).keep);
  });

  it('prunes the HOISTED copy when wigolo is installed as a dependency', () => {
    // ⚠ THE LAYOUT A REAL `npx wigolo` / `npm i wigolo` USER GETS, and the one the gate cannot
    // see. wigolo sits at <root>/node_modules/wigolo while wreq-js is hoisted beside it at
    // <root>/node_modules/wreq-js — so the runner has to walk UP and ACROSS, not just down. A
    // resolver-based lookup that happened to work from a checkout can fail exactly here.
    const root = makeTree();
    const asDependency = join(root, 'node_modules', 'wigolo');
    mkdirSync(asDependency, { recursive: true });
    runPrune(asDependency);
    expect(survivors(root)).toEqual(planBinaryPrune(FULL_TREE, process.platform, process.arch).keep);
  });

  it('leaves every binary in place when the prune is opted out of', () => {
    // The documented escape hatch for anyone deliberately assembling a multi-arch tree. If it
    // stops covering this prune, that person silently loses six binaries they asked to keep.
    const root = makeTree();
    runPrune(root, { WIGOLO_SKIP_ORT_PRUNE: '1' });
    expect(survivors(root)).toEqual([...FULL_TREE].sort());
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
