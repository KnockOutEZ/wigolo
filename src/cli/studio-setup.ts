/**
 * `wigolo studio setup` — install and pair the browser companion.
 *
 * This is spec seam 1 of the studio extraction: the ONLY thing public core knows how to do with
 * the companion application is put it on the machine and hand it its first run. Everything the
 * companion then does — sessions, flows, the whole domain layer — left this repo, so the verb
 * deliberately stops at the moment the application starts. Pairing itself is seam 2's handshake,
 * driven by the app writing its handle file; nothing here reaches into it.
 *
 * The shape is: detect the target → read the release manifest → download the artifact, resuming a
 * partial one → verify the digest the manifest claims → install → launch once. Every one of those
 * steps can fail in a way the user has to be able to act on, so every failure returns a TYPED
 * outcome and a manual fallback rather than a stack trace: a person who can be told "fetch this
 * disk image yourself and open it" is never blocked by our automation being unavailable (spec §9).
 *
 * CAPABILITY REGISTER: this file's copy names a "browser companion" and a "disk image". It never
 * names the engine, the runtime or the protocol underneath — `capability-language-copy.test.ts`
 * runs the verb and asserts it.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { studioStateDir } from '../companion/paths.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('studio');

/** Where the release host publishes what the current companion build is. */
export const COMPANION_MANIFEST_PATH = '/companion/latest.json';

/** The record a completed install writes, and the only thing an idempotent re-run trusts. */
export const COMPANION_RECORD = 'companion-install.json';

/**
 * Targets with a published artifact today.
 *
 * The companion is a desktop application and the disk-image install path below is macOS's. Naming
 * the other platforms UNSUPPORTED rather than attempting a download is the honest state: a user on
 * Linux gets one sentence telling them so, instead of a 404 from a URL we invented for them.
 */
const SUPPORTED_TARGET_KEYS: ReadonlySet<string> = new Set(['darwin-arm64', 'darwin-x64']);

export interface CompanionTarget {
  platform: string;
  arch: string;
  /** `${platform}-${arch}` — the key the release manifest indexes artifacts by. */
  key: string;
  supported: boolean;
}

export interface CompanionReleaseArtifact {
  url: string;
  /** Lowercase hex digest of the whole artifact. */
  sha256: string;
  size?: number;
}

export interface CompanionRelease {
  version: string;
  artifacts: Record<string, CompanionReleaseArtifact>;
}

export type CompanionSetupOutcome =
  /** Downloaded, verified, installed and handed its first run by this call. */
  | 'installed'
  /** A record already covers this version at a path that still exists — nothing was fetched. */
  | 'already_current'
  /** No artifact is published for this platform/architecture. */
  | 'platform_unsupported'
  /** No release host is configured, so there is nothing to ask. */
  | 'no_release_host'
  /** The host answered, but not with a manifest naming an artifact for this target. */
  | 'manifest_unreadable'
  /** The transfer itself failed — status, transport or a truncated body. */
  | 'download_failed'
  /** The bytes arrived and are not the bytes the manifest claims. Nothing is installed. */
  | 'checksum_mismatch'
  /** Verified bytes that could not be put in place. */
  | 'install_failed';

export interface CompanionSetupResult {
  outcome: CompanionSetupOutcome;
  /** One-line human explanation. Never empty — a silent decision is unactionable. */
  detail: string;
  version?: string;
  /** Where the artifact is (or, on a failure, was) on disk. */
  artifactPath?: string;
  installedPath?: string;
  launched?: boolean;
  /** Bytes already on disk that this run did NOT refetch. `0` means it started from scratch. */
  resumedFromBytes?: number;
  /** Whether a partial transfer was left in place for a later run to continue. */
  partialRetained?: boolean;
  error?: string;
  /** What to do by hand when the automated path could not finish. Present on every failure. */
  manualFallback?: string;
}

export interface CompanionSetupDeps {
  /** Defaults to the configured release host; `null` means none is configured. */
  releaseHost?: string | null;
  dataDir?: string;
  platform?: string;
  arch?: string;
  /** Directory the application bundle is copied into. */
  installRoot?: string;
  /** Re-download and re-install over an intact record. */
  force?: boolean;
  /** Skip the first-run launch. The install still happens; pairing waits for the user. */
  noLaunch?: boolean;
  fetchImpl?: typeof globalThis.fetch;
  /** Puts the downloaded artifact in place and returns the installed bundle path. */
  install?: (artifactPath: string, target: CompanionTarget, installRoot: string) => Promise<string>;
  /** Starts the installed application once, for its first-run pairing. */
  launch?: (appPath: string) => Promise<boolean>;
  /** Shells out; injected so the disk-image path is testable without a real image. */
  run?: (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;
  stdout?: Writable;
  stderr?: Writable;
}

interface CompanionRecord {
  version: string;
  path: string;
  target: string;
  installedAt: string;
}

const USAGE = `Usage: wigolo studio setup [--force] [--no-launch]

  setup                Install the browser companion and pair it with this machine

  --force              Download and install again even if this version is already installed
  --no-launch          Install without starting the application for its first run

The browser companion is a separate application. \`setup\` is the only \`wigolo studio\`
subcommand: session and flow verbs moved into the companion itself.`;

/** The platform/architecture pair, and whether a build is published for it. */
export function detectCompanionTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): CompanionTarget {
  const key = `${platform}-${arch}`;
  return { platform, arch, key, supported: SUPPORTED_TARGET_KEYS.has(key) };
}

/**
 * Where a bundle goes when the caller did not say.
 *
 * `/Applications` is where a macOS user expects to find it, but it is not writable for every
 * account and an `EACCES` two minutes into a download is the worst possible moment to discover
 * that. The per-user directory is the fallback, and the outcome names which one was used so the
 * user is never left hunting for what we installed.
 */
function defaultInstallRoot(platform: string): string {
  if (platform !== 'darwin') return join(homedir(), 'Applications');
  try {
    accessSync('/Applications', fsConstants.W_OK);
    return '/Applications';
  } catch {
    return join(homedir(), 'Applications');
  }
}

function manualFallbackText(host: string | null): string {
  const where = host ? `from ${host}` : 'from the wigolo downloads page';
  return (
    `To finish manually: download the browser companion disk image ${where}, open it, ` +
    'drag the application into your Applications folder, then launch it once so it can pair ' +
    'with this machine.'
  );
}

function recordPath(dataDir: string): string {
  return studioStateDir(dataDir, COMPANION_RECORD);
}

function readRecord(dataDir: string): CompanionRecord | null {
  try {
    const raw = JSON.parse(readFileSync(recordPath(dataDir), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Partial<CompanionRecord>;
    if (typeof r.version !== 'string' || typeof r.path !== 'string') return null;
    return {
      version: r.version,
      path: r.path,
      target: typeof r.target === 'string' ? r.target : '',
      installedAt: typeof r.installedAt === 'string' ? r.installedAt : '',
    };
  } catch {
    return null;
  }
}

function writeRecord(dataDir: string, record: CompanionRecord): void {
  const p = recordPath(dataDir);
  mkdirSync(studioStateDir(dataDir), { recursive: true });
  writeFileSync(p, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The artifact's local name.
 *
 * Derived from the VERSION AND TARGET rather than the URL's basename, so two releases never share
 * a partial file: a `.part` left by 1.3.0 must not become the prefix a 1.4.0 download resumes,
 * which is exactly what a host-chosen constant filename would produce. The extension still comes
 * from the URL, because the host owns the artifact's format.
 */
function artifactFileName(version: string, targetKey: string, url: string): string {
  let ext = '';
  try {
    ext = extname(new URL(url).pathname);
  } catch {
    ext = '';
  }
  return `wigolo-studio-${version}-${targetKey}${ext || '.bin'}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve());
    rs.on('error', reject);
  });
  return hash.digest('hex');
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

interface TransferResult {
  ok: boolean;
  resumedFromBytes: number;
  status?: number;
  error?: string;
}

/**
 * Fetches `url` into `partPath`, continuing whatever is already there.
 *
 * ⚠ THE APPEND MODE AND THE STATUS CODE ARE ONE DECISION. Asking for `bytes=N-` does not oblige a
 * host to honour it — a range-blind static host answers `200` with the WHOLE body, and appending
 * that onto the prefix produces a file that is longer than the artifact and can never verify. So
 * the response's own status picks the mode: `206` appends, anything else truncates first. That is
 * the difference between a resume and a silent corruption, and it is why the tests assert on what
 * crossed the wire rather than only on the final digest.
 */
async function transfer(
  url: string,
  partPath: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<TransferResult> {
  const existing = sizeOf(partPath);
  const headers: Record<string, string> = {};
  if (existing > 0) headers.Range = `bytes=${existing}-`;

  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch (e) {
    return { ok: false, resumedFromBytes: 0, error: e instanceof Error ? e.message : String(e) };
  }

  // The prefix already covers the whole artifact (or is longer than it). Either it is the finished
  // file under a `.part` name, in which case the digest check downstream accepts it, or it is
  // garbage — in which case that same check drops it, so the NEXT run starts from zero rather than
  // asking for a range this host will refuse again.
  if (res.status === 416) {
    return { ok: true, resumedFromBytes: existing, status: 416 };
  }
  if (res.status !== 200 && res.status !== 206) {
    return { ok: false, resumedFromBytes: 0, status: res.status, error: `release host answered ${res.status}` };
  }
  if (!res.body) {
    return { ok: false, resumedFromBytes: 0, status: res.status, error: 'release host sent an empty body' };
  }

  const append = res.status === 206 && existing > 0;
  mkdirSync(dirname(partPath), { recursive: true });
  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(partPath, { flags: append ? 'a' : 'w' }),
    );
  } catch (e) {
    // The bytes written so far stay: a dropped connection is precisely the case resume exists for.
    return { ok: false, resumedFromBytes: append ? existing : 0, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, resumedFromBytes: append ? existing : 0, status: res.status };
}

/**
 * macOS disk-image install: attach, copy the bundle out, detach.
 *
 * The detach is in a `finally` because an attached image that outlives a failed copy is a mounted
 * volume the user has to clean up by hand — a failure that leaves debris is worse than the failure.
 */
async function installDiskImage(
  artifactPath: string,
  dataDir: string,
  installRoot: string,
  run: NonNullable<CompanionSetupDeps['run']>,
): Promise<string> {
  const mountPoint = studioStateDir(dataDir, 'mount');
  rmSync(mountPoint, { recursive: true, force: true });
  mkdirSync(mountPoint, { recursive: true });

  const attach = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, artifactPath]);
  if (attach.code !== 0) throw new Error(`could not open the disk image: ${attach.stderr.trim() || `exit ${attach.code}`}`);

  try {
    const bundle = readdirSync(mountPoint).find((e) => e.endsWith('.app'));
    if (!bundle) throw new Error('the disk image contains no application bundle');
    mkdirSync(installRoot, { recursive: true });
    const dest = join(installRoot, bundle);
    rmSync(dest, { recursive: true, force: true });
    // `verbatimSymlinks` keeps the bundle's internal relative links as links. Dereferencing them
    // copies each framework once per link and produces a bundle that no longer launches.
    cpSync(join(mountPoint, bundle), dest, { recursive: true, verbatimSymlinks: true });
    return dest;
  } finally {
    await run('hdiutil', ['detach', mountPoint]).catch(() => undefined);
  }
}

function defaultRun(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (c) => {
      stderr += String(c);
    });
    child.on('error', (e) => resolve({ code: 127, stderr: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

async function defaultLaunch(appPath: string): Promise<boolean> {
  const child = spawn('open', [appPath], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

function fail(
  outcome: CompanionSetupOutcome,
  detail: string,
  host: string | null,
  extra: Partial<CompanionSetupResult> = {},
): CompanionSetupResult {
  return { outcome, detail, manualFallback: manualFallbackText(host), ...extra };
}

/** Detect → manifest → download (resumable) → verify → install → first-run launch. */
export async function setupCompanion(deps: CompanionSetupDeps = {}): Promise<CompanionSetupResult> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const target = detectCompanionTarget(platform, arch);
  const host = deps.releaseHost !== undefined ? deps.releaseHost : getConfig().companionReleaseHost;

  if (!target.supported) {
    return fail(
      'platform_unsupported',
      `No browser companion build is published for ${target.key} yet.`,
      host,
    );
  }
  if (!host) {
    return fail(
      'no_release_host',
      'No companion release host is configured, so there is nothing to download from.',
      host,
    );
  }

  const dataDir = deps.dataDir ?? getConfig().dataDir;
  const installRoot = deps.installRoot ?? defaultInstallRoot(platform);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  let release: CompanionRelease;
  try {
    const res = await fetchImpl(`${host.replace(/\/+$/, '')}${COMPANION_MANIFEST_PATH}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return fail('manifest_unreadable', `The release host answered ${res.status}.`, host);
    }
    release = (await res.json()) as CompanionRelease;
  } catch (e) {
    return fail('manifest_unreadable', 'Could not read the companion release manifest.', host, {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const artifact = release?.artifacts?.[target.key];
  if (typeof release?.version !== 'string' || !artifact || typeof artifact.url !== 'string' || typeof artifact.sha256 !== 'string') {
    return fail(
      'manifest_unreadable',
      `The release manifest names no verified artifact for ${target.key}.`,
      host,
    );
  }

  const record = readRecord(dataDir);
  if (!deps.force && record && record.version === release.version && existsSync(record.path)) {
    return {
      outcome: 'already_current',
      detail: `The browser companion ${record.version} is already installed at ${record.path}.`,
      version: record.version,
      installedPath: record.path,
    };
  }

  const downloadDir = studioStateDir(dataDir, 'downloads');
  mkdirSync(downloadDir, { recursive: true });
  const fileName = artifactFileName(release.version, target.key, artifact.url);
  const partPath = join(downloadDir, `${fileName}.part`);
  const finalPath = join(downloadDir, fileName);

  const moved = await transfer(artifact.url, partPath, fetchImpl);
  if (!moved.ok) {
    return fail('download_failed', `The download did not finish: ${moved.error ?? 'unknown transport error'}`, host, {
      version: release.version,
      artifactPath: partPath,
      resumedFromBytes: moved.resumedFromBytes,
      partialRetained: existsSync(partPath),
      error: moved.error,
    });
  }

  const digest = await sha256File(partPath).catch(() => '');
  if (digest !== artifact.sha256.toLowerCase()) {
    // ⚠ THE PARTIAL IS DROPPED, DELIBERATELY. Bytes that failed verification are the prefix a
    // later run would resume onto, and a poisoned prefix can never verify — resume would turn a
    // one-off bad transfer into a permanent one. Nothing is installed from unverified bytes.
    rmSync(partPath, { force: true });
    log.warn('companion artifact failed verification', { version: release.version, target: target.key });
    return fail(
      'checksum_mismatch',
      'The downloaded browser companion does not match the digest the release host published, so nothing was installed.',
      host,
      {
        version: release.version,
        artifactPath: partPath,
        resumedFromBytes: moved.resumedFromBytes,
        partialRetained: false,
      },
    );
  }

  rmSync(finalPath, { force: true });
  renameSync(partPath, finalPath);

  const install =
    deps.install ??
    ((a: string, _t: CompanionTarget, root: string) => installDiskImage(a, dataDir, root, deps.run ?? defaultRun));

  let installedPath: string;
  try {
    installedPath = await install(finalPath, target, installRoot);
  } catch (e) {
    return fail('install_failed', 'The browser companion could not be installed.', host, {
      version: release.version,
      artifactPath: finalPath,
      resumedFromBytes: moved.resumedFromBytes,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  writeRecord(dataDir, {
    version: release.version,
    path: installedPath,
    target: target.key,
    installedAt: new Date().toISOString(),
  });

  let launched = false;
  if (!deps.noLaunch) {
    const launch = deps.launch ?? defaultLaunch;
    launched = await launch(installedPath).catch(() => false);
  }

  return {
    outcome: 'installed',
    detail: `Installed the browser companion ${release.version} at ${installedPath}.`,
    version: release.version,
    artifactPath: finalPath,
    installedPath,
    launched,
    resumedFromBytes: moved.resumedFromBytes,
    partialRetained: false,
  };
}

/** `argv` is the post-verb tail the CLI parser hands every command: `['setup']` for `studio setup`. */
export async function runStudioSetup(argv: string[], deps: CompanionSetupDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const out = (text: string): void => {
    stdout.write(`${text}\n`);
  };
  const err = (text: string): void => {
    stderr.write(`${text}\n`);
  };

  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    out(USAGE);
    return sub ? 0 : 1;
  }
  if (sub !== 'setup') {
    err(`Unknown subcommand: wigolo studio ${sub}`);
    err(USAGE);
    return 1;
  }

  const flags = argv.slice(1);
  const unknown = flags.find((f) => f !== '--force' && f !== '--no-launch');
  if (unknown) {
    err(`Unknown option: ${unknown}`);
    err(USAGE);
    return 1;
  }

  const result = await setupCompanion({
    ...deps,
    force: deps.force ?? flags.includes('--force'),
    noLaunch: deps.noLaunch ?? flags.includes('--no-launch'),
  });

  if (result.outcome === 'installed' || result.outcome === 'already_current') {
    out(result.detail);
    if (result.outcome === 'installed') {
      out(
        result.launched
          ? 'Started it once so it can pair with this machine.'
          : 'Launch it once to pair it with this machine.',
      );
    }
    return 0;
  }

  err(result.detail);
  if (result.error) err(`  ${result.error}`);
  if (result.manualFallback) err(result.manualFallback);
  return 1;
}
