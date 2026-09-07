/**
 * BIN-8 — the consumer-shaped smoke, from both ends.
 *
 * The live half of this slice is a release-tag job: three OS runners acquire the published
 * artifact through the public contract and put it through a battery. That half cannot run
 * here, so this file covers the two things it would otherwise be impossible to know until a
 * release was already cut.
 *
 * THE STATIC HALF asserts the job is wired to be an OUTSIDE signal rather than a second
 * inside one — it waits on the publish rather than on the build, brings no interpreter with
 * it, and reaches the artifact over the same URLs a reader could paste into a terminal. A
 * smoke that quietly downloaded the build job's own upload artifact would pass every arm it
 * has and prove nothing about the release page.
 *
 * THE EXECUTED HALF runs `consumer-smoke.sh` against a stand-in artifact — a shell script
 * wearing the §4 layout — and then breaks that stand-in in five different ways, one per
 * guarantee the battery claims to check. `verify.mjs` has a battery too; the question this
 * answers is whether THIS one can go red, which a green run against a healthy fixture cannot
 * tell anyone.
 *
 * Windows skips the executed half: these arms drive POSIX `sh`, `mkfifo` and symlink-free
 * relocation, and the Windows leg of the real job is `consumer-smoke.ps1`, a separate file
 * whose own acquisition path is asserted statically below.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

const WORKFLOW = new URL('../../.github/workflows/binary-release.yml', import.meta.url);
const SMOKE_SH = new URL('./binary/consumer-smoke.sh', import.meta.url);
const SMOKE_PS1 = new URL('./binary/consumer-smoke.ps1', import.meta.url);
const CLEAN_PATH = new URL('./binary/clean-path.sh', import.meta.url);

const workflowText = () => readFile(WORKFLOW, 'utf8');
const workflow = async () => parseYaml(await workflowText()) as Record<string, any>;
const smokeJob = async () => (await workflow()).jobs.smoke as Record<string, any>;

const SEMVER = '9.9.9';
const GATE_LINE = 'wigolo needs an account — run `wigolo register` to create one.';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bin8-'));
  scratch.push(dir);
  return dir;
}

/**
 * A §4-shaped install tree whose executable is a shell script. Every knob below corresponds
 * to one arm of the battery, so a mutant is a one-flag change rather than a rewritten stub.
 */
interface StubOptions {
  /** What `--version` prints. Default: the semver the battery is told to expect. */
  readonly version?: string;
  /** Bake the tree's original location in, so a relocated copy refuses to start. */
  readonly pinnedToItsOriginalPath?: boolean;
  /** Print a human banner on stdout before the JSON-RPC — the classic transport corruption. */
  readonly noisyMcpStdout?: boolean;
  /** `fetch` refuses the way the PX2 activation gate refuses. */
  readonly fetchGated?: boolean;
  /** `cache stats` fails for some reason that is not the gate. */
  readonly cacheBroken?: boolean;
}

function stubArtifact(options: StubOptions = {}): string {
  const root = join(scratchDir(), 'wigolo');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'libexec'), { recursive: true });
  writeFileSync(join(root, 'libexec', 'marker'), 'native support files live here\n');
  writeFileSync(join(root, 'VERSION'), `semver=${SEMVER}\ntarget=stub\n`);

  const version = options.version ?? SEMVER;
  // `realpathSync`, because the stub compares against `pwd -P`: on macOS the scratch dir
  // lives under a symlink, and an unresolved literal would make the mutant fail EVERYWHERE
  // rather than only after relocation — a mutant that breaks every arm proves nothing about
  // the one it was built for.
  const pin = options.pinnedToItsOriginalPath
    ? `[ "$SELF_DIR" = "${realpathSync(join(root, 'bin'))}" ] || { echo "cannot find my support files" >&2; exit 1; }`
    : '[ -f "$SELF_DIR/../libexec/marker" ] || { echo "cannot find my support files" >&2; exit 1; }';
  const banner = options.noisyMcpStdout ? `    echo "wigolo MCP server ready"\n` : '';
  const fetchBody = options.fetchGated
    ? `    echo "${GATE_LINE}" >&2\n    exit 1`
    : `    echo "# Example Domain\\n\\nfetched $2"\n    exit 0`;
  const cacheBody = options.cacheBroken
    ? `    echo "database is locked" >&2\n    exit 1`
    : `    echo "pages: 1"\n    exit 0`;

  const exe = join(root, 'bin', 'wigolo');
  writeFileSync(
    exe,
    `#!/bin/sh
# Stand-in for the §4 executable. Answers exactly the surfaces the battery exercises.
set -u
SELF_DIR="$(cd "$(dirname "$0")" && pwd -P)"
${pin}

case "\${1:-}" in
  --version)
    echo "${version}"
    ;;
  mcp)
${banner}    while IFS= read -r line; do
      case "$line" in
        *'"initialize"'*)
          printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"wigolo","version":"${version}"}}}'
          ;;
        *'"tools/list"'*)
          printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"fetch"},{"name":"cache"}]}}'
          ;;
      esac
    done
    ;;
  fetch)
${fetchBody}
    ;;
  cache)
${cacheBody}
    ;;
  *)
    echo "unknown command \${1:-}" >&2
    exit 2
    ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(exe, 0o755);
  return exe;
}

/**
 * Run a script and hand back the exit code plus BOTH streams, merged the way a job log shows
 * them. The battery writes its human transcript to stderr and its `::error::` annotations to
 * stdout, so an arm reading one stream would be asserting over half the evidence.
 */
function runScript(args: string[]): { code: number; output: string } {
  const r = spawnSync('sh', args, { encoding: 'utf8', timeout: 180_000 });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const runBattery = (exe: string) => runScript([SMOKE_SH.pathname, exe, SEMVER]);
const runCleanPath = (base?: string) =>
  runScript([CLEAN_PATH.pathname, ...(base === undefined ? [] : [base])]);

const posix = process.platform !== 'win32';

describe('the smoke job is an OUTSIDE signal — mini-spec §4', () => {
  it('waits on the publish, not on the build — it consumes the release page', async () => {
    const job = await smokeJob();
    // `build` would be the inside signal wearing this job's name: the same upload the verify
    // lanes already tested, reachable without the release page existing at all.
    expect(job.needs).toEqual(['plan', 'release']);
  });

  it('runs on three operating systems, one job', async () => {
    const job = await smokeJob();
    const runners = (job.strategy.matrix.include as { runner: string }[]).map((e) => e.runner);
    expect(runners).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    expect(job.strategy['fail-fast']).toBe(false);
  });

  it('brings no interpreter with it — no setup-node anywhere in the job', async () => {
    const job = await smokeJob();
    const uses = (job.steps as { uses?: string }[]).map((s) => s.uses ?? '');
    expect(uses.filter((u) => u.includes('setup-node'))).toEqual([]);
    // And nothing downloads the build's own artifact either.
    expect(JSON.stringify(job.steps)).not.toContain('download-artifact');
  });

  it('acquires through install.sh on unix, over the raw URL pinned to this commit', async () => {
    const job = await smokeJob();
    const install = (job.steps as { name?: string; run?: string; if?: string }[]).find((s) =>
      s.name?.includes('install.sh'),
    );
    expect(install?.if).toBe("runner.os != 'Windows'");
    expect(install?.run).toContain('raw.githubusercontent.com/${{ github.repository }}/${{ github.sha }}/install.sh');
    // `curl | sh` — the published one-liner, not a checked-out copy run in place.
    expect(install?.run).toMatch(/curl -fsSL[^|]*\|\s*\\?\s*\n?\s*sh/);
  });

  it('proves the installer verified before it unpacked, from the transcript', async () => {
    const job = await smokeJob();
    const install = (job.steps as { name?: string; run?: string }[]).find((s) =>
      s.name?.includes('install.sh'),
    );
    expect(install?.run).toContain("grep -q 'Checksum OK.'");
  });

  it('strips the interpreter in every step that touches the artifact, in that step', async () => {
    const job = await smokeJob();
    const unix = (job.steps as { if?: string; run?: string }[]).filter(
      (s) => s.if === "runner.os != 'Windows'" && s.run,
    );
    expect(unix.length).toBeGreaterThanOrEqual(2);
    for (const step of unix) {
      expect(step.run).toContain('tests/integration/binary/clean-path.sh');
    }
    // A PATH exported once through GITHUB_ENV is a claim the later steps cannot check.
    expect(JSON.stringify(job.steps)).not.toContain('PATH=$PATH" >> "$GITHUB_ENV');
  });

  it('proves the Windows strip in the same step that runs the artifact', async () => {
    const job = await smokeJob();
    const win = (job.steps as { if?: string; run?: string }[]).find(
      (s) => s.if === "runner.os == 'Windows'",
    );
    // Order is the assertion: the probe has to be dead before the artifact is alive.
    const probeAt = win!.run!.indexOf('Get-Command node');
    const runAt = win!.run!.indexOf('consumer-smoke.ps1');
    expect(probeAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(probeAt);
  });

  it('names the tag as well as the version, because the binary channel differs in both', async () => {
    const job = await smokeJob();
    const install = (job.steps as { name?: string; env?: Record<string, string> }[]).find((s) =>
      s.name?.includes('install.sh'),
    );
    expect(install?.env?.WIGOLO_RELEASE_TAG).toBe('${{ github.ref_name }}');
    expect(install?.env?.WIGOLO_VERSION).toBe('${{ needs.plan.outputs.semver }}');
  });

  it('is the tag `install.sh` would otherwise be unable to address', async () => {
    // The gap this override closes: the artifact NAME carries the semver and the download
    // PATH carries the tag, and on `binary-v*` those are different strings.
    const script = await readFile(new URL('../../install.sh', import.meta.url), 'utf8');
    expect(script).toContain('TAG="${WIGOLO_RELEASE_TAG:-v$VERSION}"');
    expect(script).toContain('WIGOLO_RELEASE_TAG');
  });

  it('has the Windows leg verify the checksum BEFORE it unpacks', async () => {
    // Comment lines dropped first: the header explains why `Expand-Archive` is the unpacker,
    // and an index into prose would answer a question about ordering with a sentence.
    const ps1 = (await readFile(SMOKE_PS1, 'utf8'))
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    const hashAt = ps1.indexOf('Get-FileHash');
    const expandAt = ps1.indexOf('Expand-Archive');
    expect(hashAt).toBeGreaterThan(-1);
    expect(expandAt).toBeGreaterThan(hashAt);
    // And it reaches the real release download host, not an artifact hand-off.
    const job = await smokeJob();
    const win = (job.steps as { if?: string; run?: string }[]).find(
      (s) => s.if === "runner.os == 'Windows'",
    );
    expect(win?.run).toContain('https://github.com/${{ github.repository }}/releases/download');
  });
});

describe('clean-path.sh — the strip refuses rather than reporting a clean machine it did not make', () => {
  it.skipIf(!posix)('prints a PATH on which node does not resolve', () => {
    const { code, output } = runCleanPath();
    expect(code).toBe(0);
    expect(output).toContain('/usr/bin');
  });

  it.skipIf(!posix)('prunes the directory an interpreter actually resolves from', () => {
    const dir = scratchDir();
    writeFileSync(join(dir, 'node'), '#!/bin/sh\necho v22.0.0\n', { mode: 0o755 });
    chmodSync(join(dir, 'node'), 0o755);
    const { code, output } = runCleanPath(`${dir}:/usr/bin:/bin`);
    expect(code).toBe(0);
    expect(output).toContain(`pruning ${dir}`);
    expect(output.trim().split('\n').at(-1)).not.toContain(dir);
  });

  it.skipIf(!posix)('refuses when pruning would take the installer`s own tools with it', () => {
    // One directory holding both an interpreter and curl. Pruning is blind, so the refusal
    // has to come from checking what survived — otherwise install.sh fails later and reads
    // as a download problem.
    const dir = scratchDir();
    for (const tool of ['node', 'curl']) {
      writeFileSync(join(dir, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(join(dir, tool), 0o755);
    }
    const { code, output } = runCleanPath(dir);
    expect(code).toBe(1);
    expect(output).toContain('::error::');
    expect(output).toContain('curl');
  });
});

describe('consumer-smoke.sh can actually go red — one mutant per guarantee', () => {
  it.skipIf(!posix)('passes a healthy §4-shaped artifact', () => {
    const { code, output } = runBattery(stubArtifact());
    expect(output).toContain('ok   G5');
    expect(output).toContain('ok   G1');
    expect(output).toContain('ok   RUN');
    expect(output).toContain('consumer smoke green');
    expect(code).toBe(0);
  }, 200_000);

  it.skipIf(!posix)('G5 — reds when the executable disagrees with the release', () => {
    const { code, output } = runBattery(stubArtifact({ version: '0.0.1' }));
    expect(code).toBe(1);
    expect(output).toContain('::error::guarantee G5 (versioned) broke');
    expect(output).toContain("says '0.0.1'");
  }, 200_000);

  it.skipIf(!posix)('G1 — reds when the tree only works from where it was unpacked', () => {
    const { code, output } = runBattery(stubArtifact({ pinnedToItsOriginalPath: true }));
    expect(code).toBe(1);
    expect(output).toContain('::error::guarantee G1 (relocatable) broke');
  }, 200_000);

  it.skipIf(!posix)('RUN — reds on a banner that a key-grep would never notice', () => {
    // The mutant answers the handshake correctly AND corrupts the transport. An arm that
    // only looked for `"serverInfo"` would call this green.
    const { code, output } = runBattery(stubArtifact({ noisyMcpStdout: true }));
    expect(code).toBe(1);
    expect(output).toContain('::error::guarantee RUN (MCP stdio) broke');
    expect(output).toContain('not JSON-RPC');
  }, 200_000);

  it.skipIf(!posix)('OPS — a non-gate failure is red, and says which op', () => {
    const { code, output } = runBattery(stubArtifact({ cacheBroken: true }));
    expect(code).toBe(1);
    expect(output).toContain('::error::guarantee OPS (run surface) broke');
    expect(output).toContain('cache stats');
    expect(output).toContain('database is locked');
  }, 200_000);

  it.skipIf(!posix)('OPS — the activation refusal defers, warns, and names the issue', () => {
    // PX brief §0a.1 makes the gate Studio-only; the tip does not yet (#336). The tolerance
    // is that exact line and nothing else, which the arm above is the control for.
    const { code, output } = runBattery(stubArtifact({ fetchGated: true }));
    expect(code).toBe(0);
    expect(output).toContain('gate fetch');
    expect(output).toContain('::warning::');
    expect(output).toContain('336');
    expect(output).toContain('consumer smoke green (1 deferred)');
  }, 200_000);
});
