import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowNetworkInThisFile } from '../net-fence.js';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { buildTarget } from '../../scripts/binary/build.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { SIZE_BUDGET } from '../../scripts/binary/layout.mjs';
// @ts-expect-error — plain-JS build tooling, deliberately not part of the typed src/ graph.
import { HOST_TARGET, runBattery } from '../../scripts/binary/verify.mjs';

/*
 * THE SMOKE ARMS, RUN AGAINST THE REAL ARTIFACT — mini-spec §2 M1, M2 and M3, plus §4 G1
 * relocation, §6's darwin signature and the §7 size budget.
 *
 * WHY OPT-IN. This builds a ~120 MB binary: it downloads an official Node runtime, harvests six
 * natives from five registries and a GitHub release, and stages a ~180-package sidecar. On an
 * ordinary run it would report other people's outages as our red — the same reason
 * `tests/unit/binary/harvest-live.test.ts` is opt-in — and it takes minutes, not seconds. Set
 * `WIGOLO_BINARY_BUILD=1` to run it. Everything that can be decided WITHOUT the artifact is in
 * `tests/unit/binary/compile-pipeline.test.ts` and `tests/unit/binary/release-matrix.test.ts` and
 * runs on every suite.
 *
 * WHY THE ARMS LIVE IN `scripts/binary/verify.mjs` AND NOT HERE. BIN-4's release matrix runs this
 * same battery on five platform-native runners, with no repo install and no vitest, and §3 says an
 * artifact that never opened a DB on its own platform does not ship. If the suite carried its own
 * copy of the probe, the two would drift and a green suite would stop meaning the release is
 * verifiable. So the battery is a module, this file drives it on the host target, and the workflow
 * drives the identical arms on the other four.
 *
 * WHY THE ARMS ARE WHAT THEY ARE. M1 and M2 alone NEVER FORK. A broken process-model site — a
 * spawn that re-enters wigolo instead of running the script it was handed — passes both of them
 * and then fails the first time a user asks for a browser, months later, with a message that reads
 * like a network error. So there is one arm per M3 mechanism class, exercised from inside the
 * artifact.
 */

allowNetworkInThisFile(
  'builds the real single-binary artifact: downloads the official Node runtime from nodejs.org and ' +
    'harvests prebuilt natives from npm and a GitHub release, then runs an embedding through it. ' +
    'Opt-in via WIGOLO_BINARY_BUILD=1.'
);

const ENABLED = process.env.WIGOLO_BINARY_BUILD === '1';
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

let work: string | null = null;
let artifact: {
  archivePath: string;
  stageRoot: string;
  compressedBytes: number;
  unpackedBytes: number;
  semver: string;
} | null = null;
let battery: {
  target: string;
  semver: string;
  checks: Array<{ name: string; ok: boolean; detail?: unknown; error?: string }>;
  failed: Array<{ name: string; error?: string }>;
} | null = null;

/** One arm out of the battery, by the prefix of its name. */
function arm(prefix: string) {
  const found = battery!.checks.filter((c) => c.name.startsWith(prefix));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one battery arm starting with ${JSON.stringify(prefix)}, found ${found.length}: ` +
        battery!.checks.map((c) => c.name).join(' | ')
    );
  }
  return found[0];
}

/** The arm's detail, as a plain record — what it measured, for the spot-checks below. */
function detail(prefix: string): Record<string, unknown> {
  const found = arm(prefix);
  if (!found.ok) throw new Error(`${found.name} failed: ${found.error}`);
  return (found.detail ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  if (!ENABLED) return;
  work = mkdtempSync(join(tmpdir(), 'wigolo-binary-smoke-'));
  const dataDir = join(work, 'data');
  mkdirSync(dataDir, { recursive: true });
  artifact = await buildTarget({ target: HOST_TARGET, outDir: work });
  // ONE battery run for every arm below. The probe and the embedding warmup are the two expensive
  // steps in it, and running them per-`it` would triple a 20-minute job for no extra coverage.
  battery = await runBattery({
    root: artifact!.stageRoot,
    target: HOST_TARGET,
    expectSemver: artifact!.semver,
    dataDir,
    archive: artifact!.archivePath,
  });
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe.runIf(ENABLED)('the built artifact', () => {
  it('passes every arm of the battery the release matrix runs', () => {
    // The whole list, not the first failure: "sqlite-vec is missing" and "the binary never
    // started" are different incidents and a red release job has to say which.
    expect(battery!.failed.map((f) => `${f.name}: ${f.error?.split('\n')[0]}`)).toEqual([]);
  });

  it('has exactly the four top-level entries §4 promises', () => {
    expect(detail('§4 layout')).toEqual({ entries: 4 });
  });

  it('VERSION says the same semver and target — §4 G5', () => {
    expect(detail('§4 G5')).toMatchObject({ semver: artifact!.semver, target: HOST_TARGET });
  });

  it('§6 — the darwin binary carries a valid ad-hoc signature', () => {
    const d = detail('§6');
    // postject invalidates the stock signature and an arm64 Mach-O with an INVALID one does not
    // execute at all, so on darwin this arm is upstream of every other arm in the file.
    if (process.platform === 'darwin') expect(d.codesign).toBeTruthy();
    else expect(d.skipped).toContain(process.platform);
  });

  it('M1a — `--version` is byte-exact on stdout', () => {
    expect(detail('M1a')).toEqual({ bytes: `wigolo ${artifact!.semver}\n`.length });
  });

  it('M1b — the MCP handshake is byte-clean and reports the real version', () => {
    // `0.0.0` for the version is the spike's silent defect: a raw readFileSync inside a catch,
    // unreachable by any require shim, answering a default to every client while `--version` was
    // right. The byte equality is the M1 gate itself — one stray byte corrupts framing for every
    // MCP client — and the battery asserts it before it reports a detail at all.
    expect(detail('M1b')).toMatchObject({ tools: 10, serverVersion: artifact!.semver });
    expect(detail('M1b').stdoutBytes as number).toBeGreaterThan(30_000);
  });

  it('M2 — every native loads and WORKS from inside the artifact', () => {
    expect(detail('M2 · every native')).toMatchObject({
      vec: 'v0.1.9',
      sharpBytes: 102,
      wreq: true,
    });
    expect(detail('M2 · every native').sqlite).toMatch(/^3\./);
    expect(detail('M2 · every native').keyring as number).toBeGreaterThan(0);
    expect(detail('M2 · every native').transformers).toBe(3);
  });

  it('M3 — one arm per mechanism class, all from inside the artifact', () => {
    // SPAWN-REENTRY: the probe reaching this assertion at all IS that arm — unfixed, the child
    // reads the script path as an unknown subcommand and prints the help text.
    expect(detail('M3')).toMatchObject({ spawnReentry: 'ok', evalWorker: 'eval-worker', isSea: true });
    expect(detail('M3').externalSpawn).toBeTruthy();
  });

  it('M2 — the embedding model runs through the real CLI route', () => {
    // The only route that drives onnxruntime-node end to end, and the one that caught the
    // sidecar's flattened-dependency defect: a nested tar@7 shadowing the hoisted tar@6 killed
    // this deep inside a dependency while every other native stayed green.
    expect(detail('M2 · embedding')).toEqual({ route: 'warmup --embeddings' });
  });

  it('§4 G1 — relocatable: works from a second unpack path and through a symlink', () => {
    // The symlink half separates `realpathSync(process.execPath)` from `dirname(process.execPath)`.
    // install.sh puts exactly that shape on PATH, and its parent directory contains no `libexec`.
    expect(detail('§4 G1')).toEqual({
      relocated: true,
      symlink: process.platform === 'win32' ? 'skipped on win32' : true,
    });
  });

  it('§7 — the artifact is inside both halves of the size budget', () => {
    expect(artifact!.compressedBytes).toBeLessThanOrEqual(SIZE_BUDGET.compressedBytes);
    expect(artifact!.unpackedBytes).toBeLessThanOrEqual(SIZE_BUDGET.unpackedBytes);
    expect(detail('§7')).toMatchObject({ limits: '200.0 MB / 500.0 MB' });
  });
});
