#!/usr/bin/env node
/*
 * The `prepare` lifecycle hook, guarded so it can only ever build when a build is possible.
 *
 * WHY this exists: consumers install this package as a pinned git dependency
 * (`git+https://github.com/KnockOutEZ/wigolo.git#<sha>`). npm resolves a git dependency by
 * cloning it, running its `prepare` script with devDependencies present, and packing the
 * result. `prepare` is the ONLY hook on that path — `prepack` is never invoked, so an install
 * wired through `prepack` exits 0 with no `dist/` and the failure surfaces much later, at the
 * consumer's first `import`. Every `exports` subpath of this package points into `dist/`, and
 * nothing else builds it on install, so without this hook a git-dependency install produces a
 * package whose entire public surface is unresolvable.
 *
 * WHY it is guarded: a bare `"prepare": "npm run build"` breaks the producing repo. Two real
 * call sites run `npm ci --omit=dev` against this tree — `Dockerfile:27` and any
 * production-shaped install — and `prepare` runs there too, with `tsup`/`typescript` absent.
 * Bare, that is a hard exit 1 on an install that has no reason to build anything.
 *
 * So: resolve the build toolchain. Present (a git-dependency clone, a dev checkout) means
 * build. Absent (`--omit=dev`, a production install) means no-op at exit 0 — the consumer
 * asked for runtime files and there is nothing to compile for them.
 *
 * The CI `gate` job is the third case and is handled at the call site instead: it needs
 * devDependencies (it is a `tsc --noEmit` gate) but must not build, so it passes
 * `--ignore-scripts` to `npm ci` and keeps its stated no-build invariant verbatim.
 *
 * The fourth case is every OTHER CI job. They all have devDependencies AND a resolvable
 * toolchain, so `prepare` fires on their plain `npm ci` and full-builds — and then they run
 * their own explicit `npm run build` and build a second time, on a 3-OS matrix, for minutes
 * apiece. Worse, in `lint-build-unit` it inverts the fail-fast order the job is built around:
 * lint is supposed to precede the build so a type error cannot hide behind a build failure,
 * and an install-time build puts a build first regardless of step order. Those jobs opt out
 * with `WIGOLO_SKIP_PREPARE=1`, which is deliberately NOT `--ignore-scripts`: that flag would
 * also skip DEPENDENCIES' install scripts (native module builds the test jobs need), whereas
 * this variable is read by this script alone and suppresses exactly one build.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Opt-out for a caller that will build explicitly itself. Any non-empty value counts. */
if (process.env.WIGOLO_SKIP_PREPARE) {
  console.log('prepare: no build — WIGOLO_SKIP_PREPARE is set; the caller builds explicitly.');
  process.exit(0);
}

/** `npm run build` is `tsup && tsc`; both halves must be resolvable or the build cannot run. */
const TOOLCHAIN = ['tsup', 'typescript'];

function resolvable(name) {
  // Some packages restrict `exports` and refuse `./package.json`, others have no default
  // entry a bare resolve can reach. Either answer proves the package is installed.
  for (const specifier of [name, `${name}/package.json`]) {
    try {
      require.resolve(specifier);
      return true;
    } catch {
      /* try the next form */
    }
  }
  return false;
}

const missing = TOOLCHAIN.filter((name) => !resolvable(name));

if (missing.length > 0) {
  console.log(
    `prepare: no build — toolchain unresolvable (${missing.join(', ')}). ` +
      'This is the expected path for a production install (`--omit=dev`).'
  );
  process.exit(0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`prepare: could not start the build: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
