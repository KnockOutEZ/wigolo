/*
 * The ship matrix: which targets get built, which runner verifies each one, and which targets
 * DROP — mini-spec §2 M6 + §3's load-bearing sentence:
 *
 *   "An artifact that never opened a DB on its own platform does not ship — and a target with
 *    no platform-native verify lane drops from the ship matrix by spec amendment rather than
 *    shipping on a build-host smoke."
 *
 * WHY THE VERIFY RUNNER IS DERIVED AND NOT ASSIGNED. The obvious shape is a table mapping each
 * target to a runner label, plus an assertion that the label is platform-native. That shape has
 * two ways to go wrong that this one cannot: an edit can point `darwin-x64` at `macos-14` (an
 * arm64 host that runs an x64 Mach-O perfectly well under Rosetta, so nothing fails and the
 * verify becomes the build-host smoke §3 forbids), and a newly added target can be given the
 * nearest available runner because a `null` in a table looks like an omission to fix.
 *
 * So the direction is inverted: `GITHUB_RUNNERS` says what each runner image IS, and a target's
 * verify lane is the runner whose (platform, arch) EQUALS the target's. Platform-nativeness is
 * then true by construction — there is no expressible way to name a foreign runner — and a
 * target with no matching image has no lane at all and drops. Adding `win32-arm64` to
 * `runtime.json` tomorrow drops it automatically, with a reason, until a runner image for it
 * exists.
 *
 * THE DROP IS NOT SILENT AND NOT FREE. `assertShipMatrix` refuses unless every dropped target
 * appears in `AMENDED_DROPS` with the amendment that dropped it. Today that object is empty, so
 * any drop is a red plan job naming the target — which is exactly what "by spec amendment"
 * means when it is code instead of prose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_TARGETS, readManifest } from './manifest.mjs';
import { artifactName, splitTarget } from './layout.mjs';

/**
 * The GitHub-hosted runner images this pipeline uses, and what hardware each one IS.
 *
 * Names, not aliases, wherever the alias would hide the arch: `ubuntu-24.04-arm` and
 * `macos-15-intel` are the only images for linux-arm64 and darwin-x64 respectively, and
 * `macos-latest` moving to a newer arm64 image must never silently become darwin-x64's verifier.
 *
 * `ubuntu-latest` and `windows-latest` are deliberately the floating aliases: both are x64 today
 * and their next image is x64 too, and pinning them would mean a version bump chore on a lane
 * whose whole job is to be the ordinary platform a user is on.
 *
 * `macos-15-intel` REPLACES the spike's `macos-13`, which GitHub retired on 2025-12-04. That was
 * a dry-run entry in the M6 table and the first live matrix is what executed it: the darwin-x64
 * verify job sat `queued` with an empty `runner_name` while every other lane finished, because a
 * label no image answers does not fail — it waits. `macos-15-intel` is the last x86_64 image
 * Actions will offer (announced through August 2027), so darwin-x64's lane has an end date and
 * the drop machinery below is what will notice when it arrives.
 */
export const GITHUB_RUNNERS = Object.freeze({
  'macos-14': Object.freeze({ platform: 'darwin', arch: 'arm64' }),
  'macos-15-intel': Object.freeze({ platform: 'darwin', arch: 'x64' }),
  'ubuntu-latest': Object.freeze({ platform: 'linux', arch: 'x64' }),
  'ubuntu-24.04-arm': Object.freeze({ platform: 'linux', arch: 'arm64' }),
  'windows-latest': Object.freeze({ platform: 'win32', arch: 'x64' }),
});

/**
 * The single build host for all five targets.
 *
 * TWO REASONS, both measured. (1) The SEA blob is platform-agnostic and `postject` is pure JS:
 * the spike sealed all five targets from one darwin host (§2a M6), so per-target build runners
 * would buy nothing but four more `npm ci` installs. (2) `codesign` exists only on macOS and the
 * darwin arm64 signature is MANDATORY (§6 — postject invalidates the stock signature and an
 * arm64 Mach-O with an invalid one will not execute at all), so the build host has to be macOS
 * regardless. A linux build host would have to either skip the signature or ship a broken
 * primary target.
 *
 * `useCodeCache` stays off in `build.mjs`, which is what keeps this legal: a code-cache blob is
 * silently rejected when the building arch differs from the running one, and turning it on would
 * force one build host per target (§2a build-fact 5).
 */
export const BUILD_RUNNER = 'macos-14';

/**
 * Targets dropped from the ship matrix, keyed to the amendment that dropped them.
 *
 * EMPTY IS THE CORRECT STATE. The spike gave all five targets a platform-native verify lane, so
 * a drop today means either a runner image disappeared or someone edited `GITHUB_RUNNERS`. Both
 * are things a release must refuse to do quietly.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const AMENDED_DROPS = Object.freeze({});

/**
 * The verify lane for one target: the runner image that IS that platform and arch.
 *
 * Returns `null` when no image matches (the target has no lane and must drop) and throws when
 * two do (an ambiguous table is a table nobody can reason about — better a red than a coin
 * flip).
 */
export function verifyLane(target, runners = GITHUB_RUNNERS) {
  const { platform, arch } = splitTarget(target);
  const matches = Object.entries(runners).filter(
    ([, image]) => image.platform === platform && image.arch === arch
  );
  if (matches.length > 1) {
    throw new Error(
      `ship matrix: ${target} matches ${matches.length} runner images (${matches
        .map(([label]) => label)
        .join(', ')}) — one target, one lane; narrow the table`
    );
  }
  return matches.length === 1 ? matches[0][0] : null;
}

/**
 * The whole plan for one release: what ships, what drops, and why.
 *
 * `semver` is passed in rather than read here so the plan stays pure and the artifact names it
 * reports are the ones `layout.mjs` will produce — the workflow never spells an artifact name in
 * shell, which is how the §4 naming stays a single source.
 *
 * `amendedDrops` is injectable for the same reason `runners` is: the amendment table is the gate's
 * whole subject, and a gate that can only be exercised by editing the table it guards is a gate
 * nobody has run.
 *
 * @param {{ semver: string, manifest?: object, runners?: Record<string, {platform: string, arch: string}>, amendedDrops?: Record<string, string> }} input
 */
export function shipMatrix({
  semver,
  manifest = readManifest(),
  runners = GITHUB_RUNNERS,
  amendedDrops = AMENDED_DROPS,
}) {
  const ship = [];
  const dropped = [];

  for (const target of manifest.targets) {
    const verifyRunner = verifyLane(target, runners);
    if (verifyRunner === null) {
      dropped.push({
        target,
        reason:
          `no platform-native verify runner image for ${target} — mini-spec §3 drops it from the ` +
          'ship matrix rather than verifying it on the build host',
        amendment: amendedDrops[target] ?? null,
      });
      continue;
    }
    ship.push({
      target,
      buildRunner: BUILD_RUNNER,
      verifyRunner,
      artifact: artifactName(semver, target),
    });
  }

  return { semver, ship, dropped };
}

/**
 * The gate. A dropped target is legal ONLY with a recorded amendment naming it.
 *
 * Also refuses a plan that ships nothing: an empty matrix uploads an empty `SHA256SUMS` and a
 * release with no assets, which is the one failure mode that looks like success in every log.
 */
export function assertShipMatrix(plan) {
  const unamended = plan.dropped.filter((d) => !d.amendment);
  if (unamended.length > 0) {
    throw new Error(
      `REFUSED — ${unamended.length} target(s) would drop from the ship matrix with no recorded ` +
        'spec amendment (mini-spec §3):\n' +
        unamended.map((d) => `  ${d.target}: ${d.reason}`).join('\n') +
        '\n  Record the amendment in the mini-spec and add the target to AMENDED_DROPS, or restore ' +
        'its verify lane. Shipping it unverified is not an option.'
    );
  }
  if (plan.ship.length === 0) {
    throw new Error('REFUSED — the ship matrix is empty; a release with no assets is not a release');
  }
  return plan;
}

/**
 * The two `strategy.matrix` values the workflow consumes through `fromJSON`.
 *
 * BUILD AND VERIFY COME OUT OF ONE LIST, deliberately. Two matrices spelled separately in YAML
 * is how a target ends up built and unverified — the exact outcome §3 forbids — and no assertion
 * anywhere else in the pipeline would notice, because both jobs would be green.
 */
export function emitMatrices(plan) {
  return {
    build: { include: plan.ship.map((s) => ({ target: s.target, runner: s.buildRunner, artifact: s.artifact })) },
    verify: { include: plan.ship.map((s) => ({ target: s.target, runner: s.verifyRunner, artifact: s.artifact })) },
  };
}

/** Every target the tooling knows about, whether or not it currently ships. Test-facing. */
export const ALL_TARGETS = KNOWN_TARGETS;

function main() {
  const semverArg = process.argv.slice(2).find((a) => a.startsWith('--semver='));
  const emit = process.argv.includes('--emit');
  const semver =
    semverArg?.slice('--semver='.length) ??
    // Read only here: the module itself stays pure so tests can drive it with literals instead
    // of with whatever package.json happens to say.
    JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

  const plan = assertShipMatrix(shipMatrix({ semver }));
  const matrices = emitMatrices(plan);

  for (const entry of plan.ship) {
    process.stdout.write(
      `SHIP  ${entry.target.padEnd(13)} build=${entry.buildRunner.padEnd(17)} verify=${entry.verifyRunner.padEnd(17)} ${entry.artifact}\n`
    );
  }
  for (const entry of plan.dropped) {
    process.stdout.write(`DROP  ${entry.target} — ${entry.reason} (amendment: ${entry.amendment})\n`);
  }

  if (emit) {
    const out = process.env.GITHUB_OUTPUT;
    const lines = [
      `build=${JSON.stringify(matrices.build)}`,
      `verify=${JSON.stringify(matrices.verify)}`,
      `semver=${plan.semver}`,
      `count=${plan.ship.length}`,
    ];
    if (out) fs.appendFileSync(out, `${lines.join('\n')}\n`);
    else process.stdout.write(`${lines.join('\n')}\n`);
  }
}

// `fileURLToPath`, never `new URL(url).pathname`: the pathname is URL-encoded, so a checkout
// under a directory with a space never compares equal and `main()` silently does not run. Same
// guard, same reason, as `harvest.mjs` and `build.mjs`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
