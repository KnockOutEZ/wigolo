import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

/**
 * D-S10-3 — SUBSTRATE ACQUISITION. S10 owns acquisition; S16-alpha owns distribution; the seam
 * between them is `installedSubstrateExists()`, which this module makes real.
 *
 * ⚠ WHAT IS DELIBERATELY *NOT* HERE, and why it is not an omission.
 *
 * There is no published artifact to fetch. A version channel, a download URL and a checksum
 * manifest are all products of S16-alpha, which is the phase that decides what the substrate IS
 * (a signed, notarized application) as opposed to how it gets onto disk. Writing a downloader
 * now would mean choosing an artifact identity on S16-alpha's behalf and then rewriting it when
 * that phase disagrees — the program's own recorded wasted-work pattern ("S10/S16-alpha before
 * X1 = build twice"). D-S10-3's reverses-if makes the same point from the other side: whether an
 * npm-fetched substrate can run unsigned at all is pre-flight #4's question, and pre-flight #4
 * has NOT been run.
 *
 * So the fetch step is a named seam — {@link SubstrateSource} — and everything around it is
 * real and shipped: tier-conditional dispatch, install, VERIFY, RECORD, idempotent re-run,
 * D13 deferral, and a failure path that degrades to the browser rung with a stated reason
 * rather than leaving the machine with no rung and no message.
 *
 * `WIGOLO_SUBSTRATE_PATH` is a working source today. It is how the acquisition path is exercised
 * end to end — by this repo's tests, by CI's two forced-tier budget arms, and by anyone bringing
 * their own build — without inventing a distribution channel.
 */

const log = createLogger('studio');

/** Points the acquirer at an already-built substrate directory to install from. */
export const SUBSTRATE_PATH_ENV = 'WIGOLO_SUBSTRATE_PATH';

/** The manifest a substrate directory must carry, so the acquirer never guesses what to launch. */
export const SUBSTRATE_MANIFEST = 'substrate.json';

/** The record the acquirer writes, and the ONLY thing `installedSubstrateExists()` trusts. */
export const SUBSTRATE_RECORD = 'record.json';

export interface SubstrateManifest {
  version: string;
  /** Path, relative to the substrate directory, of the thing that gets launched. */
  executable: string;
}

export interface SubstrateRecord extends SubstrateManifest {
  /** Absolute path of the installed substrate directory. */
  path: string;
  platform: string;
  arch: string;
  acquiredAt: string;
  /** Which source produced it — `local-path` today, a published channel under S16-alpha. */
  source: string;
}

/**
 * The fetch half of acquisition. S16-alpha adds a published implementation; the local-path
 * source below is the one that exists now.
 */
export interface SubstrateSource {
  id: string;
  manifest: SubstrateManifest;
  /** Put the substrate's bytes into `destDir`. Throws on failure. */
  install(destDir: string): Promise<void>;
}

export type SubstrateOutcome =
  /** Installed, verified and recorded by this call. */
  | 'acquired'
  /** A valid record already covers this version — nothing downloaded, nothing to do. */
  | 'already_present'
  /** No source is available on this machine. The expected state until S16-alpha publishes one. */
  | 'no_source'
  /** A source was found and the attempt failed. */
  | 'failed';

export interface SubstrateAcquisition {
  outcome: SubstrateOutcome;
  /** One-line human explanation. Never empty — a silent decision is D-S10-9's whole complaint. */
  detail: string;
  version?: string;
  path?: string;
  error?: string;
}

/** Root of everything this module owns, under the data dir. */
export function substrateRoot(dataDir?: string): string {
  return join(dataDir ?? getConfig().dataDir, 'substrate');
}

function recordPath(dataDir?: string): string {
  return join(substrateRoot(dataDir), SUBSTRATE_RECORD);
}

/** Is `candidate` the substrate root itself, or somewhere inside it? */
function isInside(candidate: string, root: string): boolean {
  const c = resolvePath(candidate);
  const r = resolvePath(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Is this a path that stays inside the directory it is relative to?
 *
 * `executable` is a path RELATIVE to the substrate directory, and nesting is normal — `bin/run`
 * is the shape every substrate the acquirer has installed uses, so a blanket ban on separators
 * would decline every record the product has ever written. What must not survive is anything
 * that leaves the directory: a `..` segment, or an absolute path (which is not an escape under
 * `join` on POSIX, but is a shape the acquirer never writes and therefore evidence the record
 * did not come from it).
 */
function staysInsideItsDirectory(relativePath: string): boolean {
  if (!relativePath || isAbsolute(relativePath)) return false;
  return relativePath.split(/[\\/]/).every((segment) => segment !== '..');
}

/** Is this usable as ONE directory name — no separators, no traversal? */
function isSingleDirectoryName(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

/**
 * Read the acquisition record, if there is a valid one.
 *
 * "Valid" means the record parses, the paths it names stay inside the substrate root, AND the
 * executable it names is still on disk. A record whose substrate has been deleted must read as
 * absent, or `installedSubstrateExists()` reports a rung that cannot start and the router
 * escalates into nothing. Never throws: a corrupt record is indistinguishable from no record for
 * every caller's purposes.
 *
 * ⚠ CONTAINMENT IS NOT DECORATION HERE. `defaultLaunch` spawns `join(path, executable)`
 * unattended on the fetch path, with no prompt — S9's amended-D4 ruling that starting a process
 * is not a consent event. That ruling holds because the only thing ever started is what this
 * product installed, and `acquireSubstrate` writes `path` as `substrateRoot()/<version>` and
 * nothing else. So a record naming anywhere else was not written by the acquirer, and reading it
 * as absent removes the decision rather than hardening it: there is no shape of `record.json` a
 * caller can edit into a program that gets executed from elsewhere on the machine.
 */
export function readSubstrateRecord(dataDir?: string): SubstrateRecord | null {
  try {
    const raw = JSON.parse(readFileSync(recordPath(dataDir), 'utf-8')) as Partial<SubstrateRecord>;
    if (!raw.version || !raw.executable || !raw.path) return null;
    if (!staysInsideItsDirectory(raw.executable)) return null;
    if (!isInside(raw.path, substrateRoot(dataDir))) return null;
    const exec = join(raw.path, raw.executable);
    if (!existsSync(exec)) return null;
    return raw as SubstrateRecord;
  } catch {
    return null;
  }
}

/**
 * ⚠ HOT-PATH CACHE, and the reason it is needed rather than merely nice.
 *
 * `installedSubstrateExists()` is read by `resolveBrowserTier()`, and the tier resolver is
 * consulted at the single exit of `SmartRouter.fetch` — i.e. ONCE PER FETCHED PAGE. While the
 * probe was a hardcoded `false` that was free. Answering it from a record makes it a `readFileSync`
 * plus a `stat` on every page, and `crawl` fans out through the same seam, so one crawl of a
 * static docs site would add several hundred synchronous filesystem calls to the fetch path.
 *
 * A short TTL is the whole fix: the answer changes at most once per install, so a few seconds of
 * staleness costs nothing, while an acquisition INSIDE this process invalidates the cache
 * explicitly and is therefore visible immediately.
 */
const PRESENCE_TTL_MS = 5000;
let presence: { value: boolean; at: number } | null = null;

/** Drop the memoized presence answer. Called after any acquisition, and by tests that transition it. */
export function resetSubstratePresenceCache(): void {
  presence = null;
}

/**
 * Is a substrate installed? The cached form of {@link readSubstrateRecord}, for callers on the
 * fetch path. Anything that needs the record ITSELF (doctor, status, warmup) reads it directly
 * and uncached — they run once per invocation, so there is nothing to amortize and a stale answer
 * there would be a reporting bug.
 */
export function substratePresent(now: () => number = Date.now): boolean {
  const t = now();
  if (presence && t - presence.at < PRESENCE_TTL_MS) return presence.value;
  presence = { value: readSubstrateRecord() !== null, at: t };
  return presence.value;
}

/** Read a substrate directory's manifest. Null when absent or malformed. */
export function readSubstrateManifest(dir: string): SubstrateManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, SUBSTRATE_MANIFEST), 'utf-8')) as Partial<SubstrateManifest>;
    if (!raw.version || !raw.executable) return null;
    return { version: raw.version, executable: raw.executable };
  } catch {
    return null;
  }
}

/**
 * A substrate directory already built somewhere on this machine, named by
 * `WIGOLO_SUBSTRATE_PATH`. Installing COPIES it into the data dir rather than adopting it in
 * place, so the substrate keeps working when the source directory moves — and so the acquired
 * bytes actually land in the directory the budget gates measure.
 */
export function localPathSource(dir: string): SubstrateSource | null {
  const manifest = readSubstrateManifest(dir);
  if (!manifest) return null;
  return {
    id: 'local-path',
    manifest,
    async install(destDir: string): Promise<void> {
      cpSync(dir, destDir, { recursive: true });
    },
  };
}

/**
 * Resolve the source for this machine, or null when there is none.
 *
 * Exported so a test drives the real resolution rather than a stub of it, and so S16-alpha has
 * one place to add a published channel beneath the explicit override.
 */
export function resolveSubstrateSource(env: NodeJS.ProcessEnv = process.env): SubstrateSource | null {
  const explicit = env[SUBSTRATE_PATH_ENV];
  if (explicit) return localPathSource(resolvePath(explicit));
  // S16-alpha adds the published channel here. Until then there is genuinely no source, and
  // saying so is more useful than a download that 404s.
  return null;
}

export interface AcquireSubstrateDeps {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable so tests drive the outcome branches without a filesystem source. */
  source?: SubstrateSource | null;
}

/**
 * Acquire the desktop substrate: install, verify, record.
 *
 * NEVER THROWS. Every failure becomes a `failed` outcome carrying its reason, because the
 * caller is `warmup`, and a warmup that dies on an optional component is worse than one that
 * reports the component missing and carries on to the rung that does work. That degradation is
 * assertion 14, and D-S10-9 is why it is loud rather than silent.
 *
 * VERIFY IS NOT DECORATION. A copy or an extract can exit clean and still leave a tree that has
 * no launchable executable in it — a half-written archive, a partial copy, a manifest naming a
 * path the build stopped producing. Recording that as a usable substrate is worse than
 * recording nothing: `installedSubstrateExists()` would return true, the tier resolver would
 * defer acquisition on the strength of it (D13), and the machine ends up with a rung it can
 * never start. So the executable is probed on disk BEFORE the record is written, and a failed
 * probe cleans up the half-installed directory rather than leaving it to be re-found.
 */
export async function acquireSubstrate(deps: AcquireSubstrateDeps = {}): Promise<SubstrateAcquisition> {
  const dataDir = deps.dataDir;
  const existing = readSubstrateRecord(dataDir);
  if (existing) {
    return {
      outcome: 'already_present',
      detail: `a desktop component (version ${existing.version}) is already installed here`,
      version: existing.version,
      path: existing.path,
    };
  }

  const source = deps.source !== undefined ? deps.source : resolveSubstrateSource(deps.env ?? process.env);
  if (!source) {
    return {
      outcome: 'no_source',
      detail: 'no desktop component is published for this platform yet, so none was downloaded',
    };
  }

  // THE WRITE-TIME HALF OF CONTAINMENT, and the reason `readSubstrateRecord`'s check is not the
  // whole story. `destDir` is `join(root, version)`, so a version carrying a separator installs
  // the bytes outside the root — outside the directory the budget gates measure, and outside
  // what the record is later allowed to name. Refusing here is what stops the machine reporting
  // `acquired` for a component that then reads back as absent on every subsequent run.
  if (!isSingleDirectoryName(source.manifest.version)) {
    return {
      outcome: 'failed',
      detail: 'the desktop component names a version that cannot be used as a directory name',
      error: `unusable version: ${source.manifest.version}`,
    };
  }
  if (!staysInsideItsDirectory(source.manifest.executable)) {
    return {
      outcome: 'failed',
      detail: 'the desktop component names a program outside the directory it installs into',
      error: `executable escapes its directory: ${source.manifest.executable}`,
    };
  }

  const root = substrateRoot(dataDir);
  const destDir = join(root, source.manifest.version);
  try {
    mkdirSync(root, { recursive: true });
    rmSync(destDir, { recursive: true, force: true });
    await source.install(destDir);

    const exec = join(destDir, source.manifest.executable);
    if (!existsSync(exec)) {
      rmSync(destDir, { recursive: true, force: true });
      return {
        outcome: 'failed',
        detail: 'the desktop component installed but is missing the program it is supposed to start',
        error: `expected executable not found at ${source.manifest.executable}`,
      };
    }

    const record: SubstrateRecord = {
      ...source.manifest,
      path: destDir,
      platform: process.platform,
      arch: process.arch,
      acquiredAt: new Date().toISOString(),
      source: source.id,
    };
    writeFileSync(recordPath(dataDir), `${JSON.stringify(record, null, 2)}\n`);
    resetSubstratePresenceCache();
    log.info('desktop component acquired', { version: record.version, source: record.source });
    return {
      outcome: 'acquired',
      detail: `desktop component ${record.version} installed`,
      version: record.version,
      path: destDir,
    };
  } catch (err) {
    rmSync(destDir, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : String(err);
    return {
      outcome: 'failed',
      detail: 'the desktop component could not be installed on this machine',
      error: message,
    };
  }
}
