import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * `install.sh` — mini-spec §5, the fronting half of the single-binary channel.
 *
 * WHY EVERY ARM HERE IS OFFLINE, AND WHY THAT IS THE POINT. The script's whole job is to
 * refuse: on a platform with no build, on a machine whose libc the build cannot use, and —
 * the one that matters — on bytes that do not match the published checksum. None of those
 * paths is reachable from a green run against a real release, and the live release path
 * (latest-version resolution, real download URLs) belongs to the matrix smoke, not here.
 * So the release is FAKED: a local HTTP server over a directory this file builds, holding a
 * §4-shaped artifact and a `sha256sum(1)`-format `SHA256SUMS` written from the real bytes.
 * Everything provable against a local artifact is proven here; nothing here depends on a
 * published release existing.
 *
 * The server also COUNTS requests, which is how two claims that would otherwise be prose
 * become assertions: an idempotent re-run downloads nothing, and a refusal that happens
 * before the download really does happen before the download.
 *
 * `uname` and `ldd` are stubbed on PATH rather than the script growing a test-only override.
 * A knob that forces the platform would mean the musl and unsupported-arch arms exercise the
 * knob instead of the detector — and the detector is the thing that has to be right on a
 * machine none of us will ever run on.
 */

const REPO_ROOT = process.cwd();
const INSTALLER = join(REPO_ROOT, 'install.sh');
const VERSION = '9.9.9-test';
const TAG = `v${VERSION}`;

/** The fallback line §5 requires on EVERY failure path. */
const NPM_FALLBACK = 'npm install -g wigolo';

/**
 * Library and toolchain names that must never reach a user's terminal (guardrail:
 * capability language). `curl`/`wget`/`tar` are deliberately absent from this list — they
 * are the USER's tools, named so an error is actionable, not wigolo's internals.
 */
const BANNED_IN_USER_TEXT = [
  'playwright',
  'patchright',
  'chromium',
  'searxng',
  'electron',
  'onnxruntime',
  'better-sqlite3',
  'sqlite-vec',
  'libvips',
  'esbuild',
  'postject',
  'transformers',
];

let work: string;
let serveDir: string;
let server: Server;
let baseUrl: string;
let requests: string[] = [];
/** The host's own target, so the happy path runs through the real `uname` detector. */
let hostTarget: { os: string; arch: string };
let artifactName: string;

const SCRIPT = readFileSync(INSTALLER, 'utf8');

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Build a §4-shaped archive: one top-level `wigolo/` dir holding `bin/wigolo`, an opaque
 * `libexec/`, `LICENSES/` and a key=value `VERSION`.
 *
 * `bin/wigolo` is a shell script that prints `wigolo <semver>`. This suite is about the
 * installer, not the binary: what has to be true after an install is that the symlink
 * resolves to something executable that answers `--version`.
 */
function buildArtifact(opts: { semver?: string; versionFileSemver?: string; target?: string } = {}): string {
  const semver = opts.semver ?? VERSION;
  const target = opts.target ?? `${hostTarget.os}-${hostTarget.arch}`;
  const src = mkdtempSync(join(work, 'artifact-src-'));
  const root = join(src, 'wigolo');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'libexec'), { recursive: true });
  mkdirSync(join(root, 'LICENSES'), { recursive: true });
  writeFileSync(join(root, 'bin', 'wigolo'), `#!/bin/sh\necho "wigolo ${semver}"\n`);
  chmodSync(join(root, 'bin', 'wigolo'), 0o755);
  writeFileSync(join(root, 'libexec', 'placeholder'), 'opaque to consumers\n');
  writeFileSync(join(root, 'LICENSES', 'LICENSE.txt'), 'third-party licenses\n');
  writeFileSync(
    join(root, 'VERSION'),
    `semver=${opts.versionFileSemver ?? semver}\ntarget=${target}\ntoolchain=node-sea\n`
  );

  const name = `wigolo-${semver}-${target}.tar.gz`;
  const out = join(src, name);
  execFileSync('tar', ['-czf', out, '-C', src, 'wigolo']);
  return out;
}

/**
 * Publish an artifact into the fake release: copy it under `<serve>/<tag>/` and write a
 * `SHA256SUMS` in `sha256sum(1)` format — `<hex>  <name>`, two spaces — over the real bytes.
 *
 * `corrupt` flips one byte AFTER the sums file is written, which is exactly the shape a
 * consumer has to catch: a checksum file that is internally consistent with a different
 * download than the one that arrived.
 */
function publish(opts: { artifact: string; tag?: string; corrupt?: boolean; omitFromSums?: boolean }): string {
  const tag = opts.tag ?? TAG;
  const dir = join(serveDir, tag);
  mkdirSync(dir, { recursive: true });
  const name = opts.artifact.split('/').pop() as string;
  const dest = join(dir, name);
  writeFileSync(dest, readFileSync(opts.artifact));

  const sums = opts.omitFromSums ? '' : `${sha256(dest)}  ${name}\n`;
  writeFileSync(join(dir, 'SHA256SUMS'), sums);

  if (opts.corrupt) {
    const bytes = readFileSync(dest);
    // The last byte, not the first: a gzip header change could fail at unpack, which would
    // pass the test for the wrong reason. A tail flip stays a valid-looking archive whose
    // only defect is that its digest is not the published one.
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(dest, bytes);
  }
  return dest;
}

/** A PATH-shadowing `uname` (and optionally `ldd`), so the real detector runs on fake facts. */
function stubBin(opts: { unameS: string; unameM: string; ldd?: string }): string {
  const dir = mkdtempSync(join(work, 'stub-bin-'));
  writeFileSync(
    join(dir, 'uname'),
    `#!/bin/sh\ncase "\${1:-}" in\n  -s) echo '${opts.unameS}' ;;\n  -m) echo '${opts.unameM}' ;;\n  *) echo '${opts.unameS}' ;;\nesac\n`
  );
  chmodSync(join(dir, 'uname'), 0o755);
  if (opts.ldd !== undefined) {
    writeFileSync(join(dir, 'ldd'), `#!/bin/sh\necho '${opts.ldd}'\nexit 1\n`);
    chmodSync(join(dir, 'ldd'), 0o755);
  }
  return dir;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  home: string;
  installDir: string;
}

/**
 * Run the installer in an isolated HOME, against the fake release.
 *
 * ASYNC, AND THAT IS LOAD-BEARING. The fake release server lives in THIS process, so the
 * installer's download can only be answered while this process's event loop is free.
 * `spawnSync` blocks it: the child's `curl` waits on a server that cannot reply until the
 * child exits, and the arm hangs until something times out. Measured while writing this file.
 *
 * `WIGOLO_INSTALL_DIR` deliberately points somewhere that is NOT `$HOME/.wigolo`, so every
 * arm is also an assertion that the override is honoured: if it were ignored, the install
 * would land in the default and every layout assertion below would miss it.
 */
function runInstaller(
  opts: { home?: string; installDir?: string; stubPath?: string; version?: string | null } = {}
): Promise<RunResult> {
  const home = opts.home ?? mkdtempSync(join(work, 'home-'));
  const installDir = opts.installDir ?? join(home, 'custom-install-root');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    WIGOLO_INSTALL_DIR: installDir,
    WIGOLO_RELEASE_BASE: baseUrl,
    PATH: opts.stubPath ? `${opts.stubPath}:${process.env.PATH ?? ''}` : (process.env.PATH ?? ''),
  };
  if (opts.version === null) delete env.WIGOLO_VERSION;
  else env.WIGOLO_VERSION = opts.version ?? VERSION;

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn('sh', [INSTALLER], { env, timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, home, installDir }));
  });
}

beforeAll(async () => {
  // Never inside the repo: the tool's hard guards stop dead on a delete under the working
  // tree, and an unattended session cannot answer a confirmation.
  work = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-install-sh-')));
  serveDir = join(work, 'serve');
  mkdirSync(serveDir, { recursive: true });

  const unameS = execFileSync('uname', ['-s'], { encoding: 'utf8' }).trim();
  const unameM = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim();
  hostTarget = {
    os: unameS === 'Darwin' ? 'darwin' : 'linux',
    arch: unameM === 'x86_64' || unameM === 'amd64' ? 'x64' : 'arm64',
  };
  artifactName = `wigolo-${VERSION}-${hostTarget.os}-${hostTarget.arch}.tar.gz`;

  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    requests.push(path);
    const file = join(serveDir, path);
    if (!file.startsWith(serveDir) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('the fake release server did not bind a port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
});

const hasShellcheck = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status === 0;

describe('install.sh — static shape', () => {
  it.skipIf(!hasShellcheck)('is shellcheck-clean as POSIX sh', () => {
    const proc = spawnSync('shellcheck', ['-s', 'sh', INSTALLER], { encoding: 'utf8' });
    expect(`${proc.stdout}${proc.stderr}`.trim()).toBe('');
    expect(proc.status).toBe(0);
  });

  it('never escalates privileges', () => {
    // Not "does not currently call sudo" — the guarantee is that it CANNOT, and a grep is
    // the only check a shell script affords. §5: "never sudo".
    expect(SCRIPT).not.toMatch(/\bsudo\b/);
    expect(SCRIPT).not.toMatch(/\bdoas\b/);
    expect(SCRIPT).not.toMatch(/\bpkexec\b/);
  });

  it('routes every non-zero exit through fail(), which prints the package fallback', () => {
    // §5: "every failure mode prints the npm fallback". That holds structurally only while
    // `fail` is the single non-zero exit — a second `exit 1` anywhere else is a failure path
    // that prints nothing, and the dynamic arms below could not see it because they would
    // have to guess which one to trigger.
    const nonZeroExits = SCRIPT.split('\n').filter((line) => /^\s*exit\s+[1-9]/.test(line));
    expect(nonZeroExits).toHaveLength(1);

    const failBody = /^fail\(\) \{$([\s\S]*?)^\}$/m.exec(SCRIPT);
    expect(failBody, 'fail() should be defined at column 0 so this guard can find it').not.toBeNull();
    expect(failBody?.[1]).toContain('exit 1');
    expect(failBody?.[1]).toContain('$NPM_FALLBACK');
    expect(SCRIPT).toContain(`NPM_FALLBACK="${NPM_FALLBACK}"`);
  });

  it('speaks in capabilities, never in library or toolchain names', () => {
    const lower = SCRIPT.toLowerCase();
    for (const banned of BANNED_IN_USER_TEXT) {
      expect(lower, `install.sh must not name "${banned}"`).not.toContain(banned);
    }
  });
});

describe('install.sh — local-artifact smoke', () => {
  it('installs, links, and answers --version from a fresh shell', async () => {
    publish({ artifact: buildArtifact() });
    requests = [];

    const run = await runInstaller();
    expect(run.status, run.stderr).toBe(0);

    const dist = join(run.installDir, 'dist', VERSION);
    expect(existsSync(join(dist, 'bin', 'wigolo'))).toBe(true);
    expect(existsSync(join(dist, 'libexec'))).toBe(true);
    expect(existsSync(join(dist, 'LICENSES'))).toBe(true);
    expect(readFileSync(join(dist, 'VERSION'), 'utf8')).toContain(`semver=${VERSION}`);

    // WIGOLO_INSTALL_DIR was honoured — the default root was never created.
    expect(existsSync(join(run.home, '.wigolo'))).toBe(false);

    const link = join(run.home, '.local', 'bin', 'wigolo');
    expect(realpathSync(link)).toBe(realpathSync(join(dist, 'bin', 'wigolo')));

    // The acceptance criterion: a shell that knows nothing but HOME and a minimal PATH
    // resolves `wigolo` THROUGH the symlink.
    const fresh = spawnSync('sh', ['-c', 'command -v wigolo && wigolo --version'], {
      env: { HOME: run.home, PATH: `${join(run.home, '.local', 'bin')}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.stdout).toContain(link);
    expect(fresh.stdout).toContain(`wigolo ${VERSION}`);

    expect(requests).toContain(`/${TAG}/SHA256SUMS`);
    expect(requests).toContain(`/${TAG}/${artifactName}`);
  });

  it('refuses a download whose checksum does not match, and unpacks nothing', async () => {
    publish({ artifact: buildArtifact(), corrupt: true });
    requests = [];

    const run = await runInstaller();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`checksum mismatch for ${artifactName}`);
    expect(run.stderr).toMatch(/expected: [0-9a-f]{64}/);
    expect(run.stderr).toMatch(/actual: {3}[0-9a-f]{64}/);
    expect(run.stderr).toContain('Nothing was unpacked.');
    expect(run.stderr).toContain(NPM_FALLBACK);

    // The refusal has to be BEFORE the unpack, not merely reported: the version directory
    // must not exist, and neither must the link.
    expect(existsSync(join(run.installDir, 'dist', VERSION))).toBe(false);
    expect(existsSync(join(run.home, '.local', 'bin', 'wigolo'))).toBe(false);

    // It did download the artifact — the mismatch is caught on the bytes, not guessed from
    // the name — which is what makes the assertion above a real ordering claim.
    expect(requests).toContain(`/${TAG}/${artifactName}`);
  });

  it('refuses when SHA256SUMS has no entry for the artifact', async () => {
    publish({ artifact: buildArtifact(), omitFromSums: true });

    const run = await runInstaller();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(`has no entry for ${artifactName}`);
    expect(run.stderr).toContain(NPM_FALLBACK);
    expect(existsSync(join(run.installDir, 'dist', VERSION))).toBe(false);
  });

  it('refuses an artifact whose VERSION disagrees with the version it was published as', async () => {
    // §4 G5. The archive is named and published as 9.9.9-test but says it is something else.
    publish({ artifact: buildArtifact({ versionFileSemver: '0.0.0-wrong' }) });

    const run = await runInstaller();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('says it is version 0.0.0-wrong');
    expect(run.stderr).toContain(NPM_FALLBACK);
    expect(existsSync(join(run.installDir, 'dist', VERSION))).toBe(false);
  });

  it('re-runs idempotently without downloading again', async () => {
    publish({ artifact: buildArtifact() });

    const first = await runInstaller();
    expect(first.status, first.stderr).toBe(0);

    requests = [];
    const second = await runInstaller({ home: first.home, installDir: first.installDir });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toContain('already installed');
    // Nothing was fetched: not the artifact, not even the checksum file.
    expect(requests).toEqual([]);

    const link = join(first.home, '.local', 'bin', 'wigolo');
    expect(realpathSync(link)).toBe(realpathSync(join(first.installDir, 'dist', VERSION, 'bin', 'wigolo')));
  });

  it('refuses on musl before it downloads anything', async () => {
    publish({ artifact: buildArtifact() });
    requests = [];

    const stub = stubBin({ unameS: 'Linux', unameM: 'x86_64', ldd: 'musl libc (x86_64)\nVersion 1.2.5' });
    const run = await runInstaller({ stubPath: stub });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('musl');
    expect(run.stderr).toContain('glibc');
    expect(run.stderr).toContain(NPM_FALLBACK);
    expect(requests).toEqual([]);
    expect(existsSync(join(run.installDir, 'dist'))).toBe(false);
  });

  it('refuses a processor architecture with no build, before it downloads anything', async () => {
    publish({ artifact: buildArtifact() });
    requests = [];

    const run = await runInstaller({ stubPath: stubBin({ unameS: 'Linux', unameM: 'ppc64le' }) });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('ppc64le');
    expect(run.stderr).toContain(NPM_FALLBACK);
    expect(requests).toEqual([]);
  });

  it('sends Windows to the archive it can actually use', async () => {
    const run = await runInstaller({ stubPath: stubBin({ unameS: 'MINGW64_NT-10.0', unameM: 'x86_64' }) });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('.zip');
    expect(run.stderr).toContain(NPM_FALLBACK);
  });

  it('refuses when the requested version has no assets', async () => {
    publish({ artifact: buildArtifact() });

    const run = await runInstaller({ version: '0.0.0-absent' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('could not download the checksum file for v0.0.0-absent');
    expect(run.stderr).toContain(NPM_FALLBACK);
  });
});
