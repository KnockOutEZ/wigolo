import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { artifactName } from '../../../scripts/binary/layout.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { readManifest } from '../../../scripts/binary/manifest.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { ALL_TARGETS, assertShipMatrix, BUILD_RUNNER, emitMatrices, GITHUB_RUNNERS, shipMatrix, verifyLane } from '../../../scripts/binary/ship-matrix.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { collectAssets, parseSha256sums, reconcile, sha256sumsText } from '../../../scripts/binary/checksums.mjs';

/*
 * THE OFFLINE HALF OF BIN-4 — everything about the five-target release matrix that can be decided
 * without spending 40 minutes of CI on five real builds.
 *
 * The one sentence these arms exist to defend is mini-spec §3's: "an artifact that never opened a
 * DB on its own platform does not ship — and a target with no platform-native verify lane drops
 * from the ship matrix by spec amendment rather than shipping on a build-host smoke". Every way
 * that sentence can be violated is cheap and silent: a matrix spelled twice in YAML so a target
 * is built and not verified; a verify runner re-pointed at the build host (an arm64 mac runs an
 * x64 Mach-O under Rosetta, so nothing fails); a digest mismatch between the bytes that were
 * tested and the bytes that were uploaded. None of those makes a job red on its own, so each one
 * gets an arm here.
 *
 * The battery that runs ON the artifact is `scripts/binary/verify.mjs`, exercised for real by
 * `tests/integration/binary-artifact.test.ts` (opt-in) and by the verify lanes themselves.
 */

const WORKFLOW = new URL('../../../.github/workflows/binary-release.yml', import.meta.url);
const NPM_RELEASE_WORKFLOW = new URL('../../../.github/workflows/release.yml', import.meta.url);

const workflowText = () => readFile(WORKFLOW, 'utf8');
const workflow = async () => parseYaml(await workflowText()) as Record<string, any>;

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wigolo-release-matrix-'));
  scratch.push(dir);
  return dir;
}

describe('the ship matrix — mini-spec §2 M6 + §3', () => {
  const plan = () => shipMatrix({ semver: '9.9.9' });

  it('ships all five §1 targets, because the spike gave all five a verify lane', () => {
    expect(plan().ship.map((s: { target: string }) => s.target)).toEqual([...ALL_TARGETS]);
    expect(plan().dropped).toEqual([]);
  });

  it('gives every shipped target a runner that IS its platform and arch', () => {
    for (const entry of plan().ship) {
      const image = GITHUB_RUNNERS[entry.verifyRunner as keyof typeof GITHUB_RUNNERS];
      expect({ target: entry.target, runner: `${image.platform}-${image.arch}` }).toEqual({
        target: entry.target,
        runner: entry.target,
      });
    }
  });

  it('names the M6 table`s runners, so an image swap is a diff on this line', () => {
    const lanes = Object.fromEntries(plan().ship.map((s: { target: string; verifyRunner: string }) => [s.target, s.verifyRunner]));
    expect(lanes).toEqual({
      'darwin-arm64': 'macos-14',
      'darwin-x64': 'macos-13',
      'linux-x64': 'ubuntu-latest',
      'linux-arm64': 'ubuntu-24.04-arm',
      'win32-x64': 'windows-latest',
    });
  });

  it('builds every target on one macOS host — codesign lives there and the blob is portable', () => {
    expect(BUILD_RUNNER).toBe('macos-14');
    expect(GITHUB_RUNNERS[BUILD_RUNNER as keyof typeof GITHUB_RUNNERS].platform).toBe('darwin');
    for (const entry of plan().ship) expect(entry.buildRunner).toBe(BUILD_RUNNER);
  });

  it('spells each artifact exactly as layout.mjs will — zip on win32', () => {
    for (const entry of plan().ship) {
      expect(entry.artifact).toBe(artifactName('9.9.9', entry.target));
    }
    expect(plan().ship.find((s: { target: string }) => s.target === 'win32-x64').artifact).toBe(
      'wigolo-9.9.9-win32-x64.zip'
    );
  });

  it('has no lane for a target no runner image matches — and says so instead of inventing one', () => {
    expect(verifyLane('win32-arm64')).toBeNull();
    expect(verifyLane('linux-riscv64')).toBeNull();
  });

  it('refuses an ambiguous runner table rather than picking one of two lanes', () => {
    expect(() =>
      verifyLane('linux-x64', {
        'ubuntu-latest': { platform: 'linux', arch: 'x64' },
        'ubuntu-22.04': { platform: 'linux', arch: 'x64' },
      })
    ).toThrow(/matches 2 runner images/);
  });

  /*
   * THE GATE ITSELF. A target whose verify lane disappears must drop AND make the release red,
   * because "drops by spec amendment" is only a policy if the amendment is a thing that has to
   * exist. The arm drives it by REMOVING an image from the runner table — the real-world shape of
   * this failure (an image is retired, or someone edits the table) — rather than by removing the
   * target, which would just make a smaller matrix.
   */
  it('drops a target whose runner image is gone, and REFUSES to release without an amendment', () => {
    const runners = { ...GITHUB_RUNNERS };
    delete (runners as Record<string, unknown>)['ubuntu-24.04-arm'];
    const degraded = shipMatrix({ semver: '9.9.9', runners });

    expect(degraded.ship.map((s: { target: string }) => s.target)).not.toContain('linux-arm64');
    expect(degraded.dropped).toEqual([
      {
        target: 'linux-arm64',
        reason: expect.stringContaining('no platform-native verify runner image for linux-arm64'),
        amendment: null,
      },
    ]);
    expect(() => assertShipMatrix(degraded)).toThrow(/REFUSED[\s\S]*linux-arm64/);
  });

  it('lets the same drop through once an amendment records it', () => {
    const runners = { ...GITHUB_RUNNERS };
    delete (runners as Record<string, unknown>)['ubuntu-24.04-arm'];
    const amended = shipMatrix({
      semver: '9.9.9',
      runners,
      amendedDrops: { 'linux-arm64': 'mini-spec §3 amendment 2026-09-08: no arm64 linux image' },
    });
    expect(() => assertShipMatrix(amended)).not.toThrow();
    expect(amended.ship).toHaveLength(4);
  });

  it('refuses a plan that ships nothing — a release with no assets looks green in every log', () => {
    const empty = shipMatrix({ semver: '9.9.9', runners: {} , amendedDrops: Object.fromEntries(ALL_TARGETS.map((t: string) => [t, 'amended'])) });
    expect(() => assertShipMatrix(empty)).toThrow(/ship matrix is empty/);
  });

  it('reads its targets from runtime.json, so the pin file stays the one source', () => {
    expect(readManifest().targets).toEqual(plan().ship.map((s: { target: string }) => s.target));
  });

  /*
   * The build list and the verify list are ONE list projected twice. This is the property that
   * makes "built but never verified" unexpressible; two YAML matrices could differ by one entry
   * and every job in the run would still be green.
   */
  it('projects build and verify from one list — same targets, same order, same artifacts', () => {
    const m = emitMatrices(plan());
    expect(m.build.include.map((e: { target: string }) => e.target)).toEqual(
      m.verify.include.map((e: { target: string }) => e.target)
    );
    expect(m.build.include.map((e: { artifact: string }) => e.artifact)).toEqual(
      m.verify.include.map((e: { artifact: string }) => e.artifact)
    );
    expect(new Set(m.build.include.map((e: { runner: string }) => e.runner))).toEqual(new Set([BUILD_RUNNER]));
  });
});

describe('the workflow consumes the matrix instead of restating it', () => {
  it('takes both matrices from the plan job, with no target spelled in YAML', async () => {
    const wf = await workflow();
    expect(wf.jobs.build.strategy.matrix).toBe('${{ fromJSON(needs.plan.outputs.build) }}');
    expect(wf.jobs.verify.strategy.matrix).toBe('${{ fromJSON(needs.plan.outputs.verify) }}');
    expect(wf.jobs.build['runs-on']).toBe('${{ matrix.runner }}');
    expect(wf.jobs.verify['runs-on']).toBe('${{ matrix.runner }}');

    // No target spelled anywhere in the file, and no runner image bound to the two per-target
    // jobs. The moment either appears, the workflow has a second opinion about the matrix — and
    // the two opinions can differ by one entry with every job still green. (`plan` and `release`
    // are single jobs on a fixed runner; the sweep is deliberately about the matrix jobs only.)
    const yamlText = await workflowText();
    for (const target of ALL_TARGETS) expect(yamlText).not.toContain(`- target: ${target}`);
    for (const image of Object.keys(GITHUB_RUNNERS)) {
      expect(wf.jobs.build['runs-on']).not.toBe(image);
      expect(wf.jobs.verify['runs-on']).not.toBe(image);
    }
  });

  it('gates publication on the verify jobs — the §3 sentence as a dependency', async () => {
    const wf = await workflow();
    expect(wf.jobs.release.needs).toContain('verify');
    expect(wf.jobs.release.needs).toContain('build');
    // `needs` is what makes a red verify lane skip the upload. An `if:` in its place would let a
    // failure be waved through by a condition edit, and `always()` in the wrong spot would ship
    // the unverified artifact with a green run.
    expect(JSON.stringify(wf.jobs.release.if ?? '')).not.toContain('always()');
  });

  it('runs the verify lane with NO dependency tree installed', async () => {
    const wf = await workflow();
    const steps = JSON.stringify(wf.jobs.verify.steps);
    // An `npm ci` here would put a full node_modules beside the artifact, and a native that failed
    // to stage inside `libexec/` could then resolve from the host instead — the verify lane would
    // answer a question the artifact was supposed to.
    expect(steps).not.toContain('npm ci');
    expect(steps).not.toContain('npm install');
    expect(steps).toContain('scripts/binary/verify.mjs');
  });

  it('is triggered by tags only, and by a binary channel outside the npm tag namespace', async () => {
    const wf = await workflow();
    expect(wf.on.push.tags).toEqual(['v*.*.*', 'v*.*.*-*', 'binary-v*']);
    expect(wf.on.push.branches).toBeUndefined();
    expect(wf.on.pull_request).toBeUndefined();
    // No dispatch: GitHub only offers it for files already on the default branch, and a dispatch
    // that uploads release assets publishes from an arbitrary ref.
    expect(wf.on.workflow_dispatch).toBeUndefined();

    const npmWorkflow = parseYaml(await readFile(NPM_RELEASE_WORKFLOW, 'utf8')) as Record<string, any>;
    // The binary channel must not be able to start an npm publish. `release.yml` matches `v*.*.*`
    // and `v*.*.*-*`; `binary-v*` matches neither, which is the whole reason for its shape.
    for (const pattern of npmWorkflow.on.push.tags) {
      expect('binary-v0.2.1-rc.1').not.toMatch(
        new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`)
      );
    }
  });

  it('touches nothing npm — no publish, no registry auth, no reuse of the release workflow', async () => {
    const yamlText = await workflowText();
    expect(yamlText).not.toContain('npm publish');
    expect(yamlText).not.toContain('registry-url');
    expect(yamlText).not.toContain('NODE_AUTH_TOKEN');
    // A reuse of the npm workflow would make this file able to publish a package; a mention of it
    // in a comment is just prose about why it is not touched.
    expect(yamlText).not.toContain('uses: ./.github/workflows/release.yml');

    // And the npm side is independent in the other direction too: it neither calls nor knows
    // about this workflow, so the binary matrix is additive (mini-spec §5, §10).
    const npmText = await readFile(NPM_RELEASE_WORKFLOW, 'utf8');
    expect(npmText).not.toContain('binary-release');
    expect(npmText).not.toContain('scripts/binary/');
  });

  it('asks for exactly the permission it needs to upload assets', async () => {
    const wf = await workflow();
    expect(wf.permissions).toEqual({ contents: 'write' });
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  it('builds the artifact outside the checkout', async () => {
    const wf = await workflow();
    const build = wf.jobs.build.steps.find((s: { name?: string }) => s.name?.includes('artifact'));
    // ~400 MB unpacked. Inside the workspace it becomes a later step's input by accident.
    expect(build.run).toContain('--out "$RUNNER_TEMP/binary-${{ matrix.target }}"');
    expect(build.run).toContain('--target "${{ matrix.target }}"');
    // And the built artifact's presence is asserted, not assumed: a build.mjs that exits 0 having
    // produced nothing would otherwise reach `upload-artifact`, which is the step that reports it.
    expect(build.run).toContain('test -f');
  });
});

describe('SHA256SUMS — mini-spec §4 G4', () => {
  it('is `<hex>  <name>`, sorted by name, and reads back with sha256sum`s own grammar', () => {
    const text = sha256sumsText([
      { name: 'wigolo-1.0.0-win32-x64.zip', sha256: 'b'.repeat(64) },
      { name: 'wigolo-1.0.0-darwin-arm64.tar.gz', sha256: 'a'.repeat(64) },
    ]);
    expect(text).toBe(
      `${'a'.repeat(64)}  wigolo-1.0.0-darwin-arm64.tar.gz\n${'b'.repeat(64)}  wigolo-1.0.0-win32-x64.zip\n`
    );
    expect(parseSha256sums(text)).toEqual([
      { name: 'wigolo-1.0.0-darwin-arm64.tar.gz', sha256: 'a'.repeat(64) },
      { name: 'wigolo-1.0.0-win32-x64.zip', sha256: 'b'.repeat(64) },
    ]);
  });

  it('carries basenames only — a path makes `-c` fail in every directory but one', () => {
    const text = sha256sumsText([{ name: 'wigolo-1.0.0-linux-x64.tar.gz', sha256: 'c'.repeat(64) }]);
    expect(text).not.toContain('/');
  });

  it('refuses a line it cannot parse instead of silently returning fewer entries', () => {
    expect(() => parseSha256sums('deadbeef wigolo.tar.gz\n')).toThrow(/not `<hex>  <name>`/);
  });
});

describe('reconcile — the bytes that ship are the bytes that were verified', () => {
  function fixture(files: Record<string, string>) {
    const dir = scratchDir();
    mkdirSync(join(dir, 'assets'), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), body);
    return dir;
  }
  const sha = (body: string) => createHash('sha256').update(Buffer.from(body)).digest('hex');

  const expected = [
    { target: 'linux-x64', artifact: 'wigolo-1.0.0-linux-x64.tar.gz' },
    { target: 'win32-x64', artifact: 'wigolo-1.0.0-win32-x64.zip' },
  ];

  it('passes when every planned asset matches its verify record', () => {
    const dir = fixture({ 'wigolo-1.0.0-linux-x64.tar.gz': 'linux', 'wigolo-1.0.0-win32-x64.zip': 'win' });
    const assets = collectAssets(join(dir, 'assets'), expected.map((e) => e.artifact));
    const { entries, problems } = reconcile({
      expected,
      assets,
      verified: {
        'linux-x64': { target: 'linux-x64', sha256: sha('linux') },
        'win32-x64': { target: 'win32-x64', sha256: sha('win') },
      },
    });
    expect(problems).toEqual([]);
    expect(entries.map((e: { name: string }) => e.name)).toEqual(expected.map((e) => e.artifact));
  });

  /*
   * The failure this whole reconciliation exists for: a re-run of one build job produces a new
   * artifact, the verify job's record is from the old one, and every job in the run is green.
   */
  it('refuses an asset whose bytes differ from the ones the verify lane tested', () => {
    const dir = fixture({ 'wigolo-1.0.0-linux-x64.tar.gz': 'rebuilt', 'wigolo-1.0.0-win32-x64.zip': 'win' });
    const { problems } = reconcile({
      expected,
      assets: collectAssets(join(dir, 'assets'), expected.map((e) => e.artifact)),
      verified: {
        'linux-x64': { target: 'linux-x64', sha256: sha('linux') },
        'win32-x64': { target: 'win32-x64', sha256: sha('win') },
      },
    });
    expect(problems).toEqual([
      expect.stringContaining('only one of them was tested'),
    ]);
    expect(problems[0]).toContain(sha('rebuilt'));
    expect(problems[0]).toContain(sha('linux'));
  });

  it('refuses an asset with no verify record at all', () => {
    const dir = fixture({ 'wigolo-1.0.0-linux-x64.tar.gz': 'linux', 'wigolo-1.0.0-win32-x64.zip': 'win' });
    const { entries, problems } = reconcile({
      expected,
      assets: collectAssets(join(dir, 'assets'), expected.map((e) => e.artifact)),
      verified: { 'linux-x64': { target: 'linux-x64', sha256: sha('linux') } },
    });
    expect(problems).toEqual([expect.stringContaining('win32-x64: wigolo-1.0.0-win32-x64.zip has no verify record')]);
    expect(entries).toHaveLength(1);
  });

  it('refuses a missing asset, naming the target rather than uploading four of five', () => {
    const dir = fixture({ 'wigolo-1.0.0-win32-x64.zip': 'win' });
    const { problems } = reconcile({
      expected,
      assets: collectAssets(join(dir, 'assets'), expected.map((e) => e.artifact)),
      verified: { 'win32-x64': { target: 'win32-x64', sha256: sha('win') } },
    });
    expect(problems).toEqual([expect.stringContaining('linux-x64: no asset named wigolo-1.0.0-linux-x64.tar.gz')]);
  });

  it('refuses an asset nothing planned, rather than publishing it unverified', () => {
    const dir = fixture({
      'wigolo-1.0.0-linux-x64.tar.gz': 'linux',
      'wigolo-1.0.0-win32-x64.zip': 'win',
      'wigolo-1.0.0-darwin-arm64.tar.gz': 'stray',
    });
    const assets = collectAssets(join(dir, 'assets'), [
      ...expected.map((e) => e.artifact),
      'wigolo-1.0.0-darwin-arm64.tar.gz',
    ]);
    const { problems } = reconcile({
      expected,
      assets,
      verified: {
        'linux-x64': { target: 'linux-x64', sha256: sha('linux') },
        'win32-x64': { target: 'win32-x64', sha256: sha('win') },
      },
    });
    expect(problems).toEqual([expect.stringContaining('not in the ship matrix')]);
  });

  it('refuses two downloads of the same name instead of guessing which was tested', () => {
    const dir = scratchDir();
    mkdirSync(join(dir, 'a'), { recursive: true });
    mkdirSync(join(dir, 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'wigolo-1.0.0-linux-x64.tar.gz'), 'one');
    writeFileSync(join(dir, 'b', 'wigolo-1.0.0-linux-x64.tar.gz'), 'two');
    expect(() => collectAssets(dir, ['wigolo-1.0.0-linux-x64.tar.gz'])).toThrow(/two files named/);
  });
});
