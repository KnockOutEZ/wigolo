import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../../src/config.js';
import {
  acquireSubstrate,
  localPathSource,
  readSubstrateManifest,
  readSubstrateRecord,
  resetSubstratePresenceCache,
  resolveSubstrateSource,
  substratePresent,
  substrateRoot,
  SUBSTRATE_PATH_ENV,
  type SubstrateSource,
} from '../../../src/studio/substrate-acquire.js';

/**
 * Real filesystem, real copies, real cleanup. These assertions are about what ends up ON DISK
 * after an acquisition — which directory grew, which record exists, what survived a failure —
 * and a mocked `node:fs` would let every one of them hold while the production path wrote
 * somewhere else entirely.
 */

let dataDir: string;
let sourceDir: string;

function makeSourceDir(manifest: unknown, opts: { withExecutable?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'wigolo-substrate-src-'));
  writeFileSync(join(dir, 'substrate.json'), JSON.stringify(manifest));
  if (opts.withExecutable !== false) {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'run'), '#!/bin/sh\n');
  }
  return dir;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-substrate-data-'));
  sourceDir = makeSourceDir({ version: '1.2.3', executable: 'bin/run' });
  delete process.env[SUBSTRATE_PATH_ENV];
  process.env.WIGOLO_DATA_DIR = dataDir;
  resetConfig();
  resetSubstratePresenceCache();
});

afterEach(() => {
  delete process.env.WIGOLO_DATA_DIR;
  resetConfig();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
  delete process.env[SUBSTRATE_PATH_ENV];
});

describe('acquireSubstrate — install, verify, record (D-S10-3)', () => {
  it('installs the component and records it', async () => {
    const r = await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    expect(r.outcome).toBe('acquired');
    expect(existsSync(join(substrateRoot(dataDir), '1.2.3', 'bin', 'run'))).toBe(true);
    expect(readSubstrateRecord(dataDir)?.version).toBe('1.2.3');
  });

  it('records the platform, the arch and which source produced it', async () => {
    // WHY: the record is what a later run, `doctor`, and S16-alpha's update path all read. A
    // record that cannot say which machine and which channel it came from cannot be checked for
    // staleness after an OS or arch migration — it would just be silently wrong.
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    const record = readSubstrateRecord(dataDir);
    expect(record?.platform).toBe(process.platform);
    expect(record?.arch).toBe(process.arch);
    expect(record?.source).toBe('local-path');
  });

  it('reports already_present on a second run and downloads nothing', async () => {
    // WHY: this is D13's deferral doing its job at the acquisition seam. `warmup` calls this
    // unconditionally on the desktop tier, so an idempotent second run is what stops a re-warmup
    // from re-fetching a component that is already installed.
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    let installs = 0;
    const counting: SubstrateSource = {
      id: 'counting',
      manifest: { version: '1.2.3', executable: 'bin/run' },
      async install() { installs++; },
    };
    const r = await acquireSubstrate({ dataDir, source: counting });
    expect(r.outcome).toBe('already_present');
    expect(installs).toBe(0);
  });

  it('reports no_source when nothing is available to install from', async () => {
    // WHY: the expected state until S16-alpha publishes an artifact, and it must be a NAMED
    // outcome rather than a failure — warmup degrades on it, and a machine that simply has no
    // component published for it is not a broken machine.
    const r = await acquireSubstrate({ dataDir, source: null });
    expect(r.outcome).toBe('no_source');
    expect(r.detail).toBeTruthy();
    expect(existsSync(substrateRoot(dataDir))).toBe(false);
  });
});

describe('verification runs BEFORE the record is written', () => {
  it('fails, and writes no record, when the installed tree has no executable', async () => {
    // WHY: an install can exit clean and still leave a tree with nothing launchable in it — a
    // partial copy, a truncated archive, a manifest naming a path the build stopped producing.
    // Recording that as installed is WORSE than recording nothing: `installedSubstrateExists()`
    // would return true, the resolver would defer acquisition on the strength of it, and the
    // machine ends up holding a rung it can never start.
    const broken = makeSourceDir({ version: '9.9.9', executable: 'bin/run' }, { withExecutable: false });
    try {
      const r = await acquireSubstrate({ dataDir, source: localPathSource(broken) });
      expect(r.outcome).toBe('failed');
      expect(readSubstrateRecord(dataDir)).toBeNull();
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('cleans up the half-installed directory rather than leaving it to be re-found', async () => {
    const broken = makeSourceDir({ version: '9.9.9', executable: 'bin/run' }, { withExecutable: false });
    try {
      await acquireSubstrate({ dataDir, source: localPathSource(broken) });
      expect(existsSync(join(substrateRoot(dataDir), '9.9.9'))).toBe(false);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('never throws when the install step throws, and leaves no record', async () => {
    // WHY: the caller is `warmup`. A warmup that dies on an optional component is worse than one
    // that reports it missing and carries on to the rung that works (assertion 14).
    const exploding: SubstrateSource = {
      id: 'exploding',
      manifest: { version: '4.5.6', executable: 'bin/run' },
      async install() { throw new Error('network unreachable'); },
    };
    const r = await acquireSubstrate({ dataDir, source: exploding });
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/network unreachable/);
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });
});

describe('readSubstrateRecord trusts the record only while its executable is on disk', () => {
  it('reads back a valid record', async () => {
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    expect(readSubstrateRecord(dataDir)).not.toBeNull();
  });

  it('returns null once the executable the record names has gone', async () => {
    // WHY: a record whose component has been deleted must read as ABSENT. Otherwise
    // `installedSubstrateExists()` reports a rung that cannot start, the resolver defers
    // acquisition in its favour, and the router escalates into nothing.
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    rmSync(join(substrateRoot(dataDir), '1.2.3', 'bin', 'run'), { force: true });
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('returns null rather than throwing on a corrupt record', async () => {
    mkdirSync(substrateRoot(dataDir), { recursive: true });
    writeFileSync(join(substrateRoot(dataDir), 'record.json'), '{not json');
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('returns null when no record has ever been written', () => {
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });
});

/**
 * THE RECORD IS NOT A LAUNCH INSTRUCTION FROM AN UNTRUSTED PARTY, and this is what keeps it
 * from becoming one.
 *
 * `defaultLaunch` spawns `join(record.path, record.executable)` unattended on the fetch path —
 * no prompt, no permission check, by design (S9's amended-D4 ruling that starting a process is
 * not a consent event). That ruling holds precisely because the only thing that ever gets
 * started is the substrate this product installed: `acquireSubstrate` writes `path` as
 * `substrateRoot()/<version>` and nothing else. A record naming somewhere else was not written
 * by the acquirer, so treating it as absent costs the product nothing and removes the decision
 * rather than hardening it.
 *
 * WHY A SEPARATOR IN `executable` IS NOT ITSELF THE PROBLEM: `bin/run` is the canonical
 * manifest shape — every fixture in this file and every substrate the acquirer has ever
 * installed uses it. What must not survive is anything that ESCAPES the substrate directory, so
 * the rule is stated as containment (`..` segments and absolute paths are refused) rather than
 * as a ban on nesting. See DECISIONS-AUTO.md.
 */
describe('a record must name something inside the substrate root', () => {
  /** Write a record verbatim, with a real file at the executable it names. */
  function plantRecord(record: Record<string, unknown>, execAt: string): void {
    mkdirSync(dirname(execAt), { recursive: true });
    writeFileSync(execAt, '#!/bin/sh\n');
    mkdirSync(substrateRoot(dataDir), { recursive: true });
    writeFileSync(join(substrateRoot(dataDir), 'record.json'), JSON.stringify(record));
  }

  it('ACCEPTS the canonical shape the acquirer writes', () => {
    // ANTI-VACUITY. Without this arm a `readSubstrateRecord` hardwired to `return null` would
    // satisfy every rejection below forever, and the containment rule would be indistinguishable
    // from having broken the feature.
    const dir = join(substrateRoot(dataDir), '1.2.3');
    plantRecord({ version: '1.2.3', path: dir, executable: 'bin/run' }, join(dir, 'bin', 'run'));
    expect(readSubstrateRecord(dataDir)?.version).toBe('1.2.3');
  });

  it('rejects a path outside the substrate root, however real the file it names is', () => {
    const outside = mkdtempSync(join(tmpdir(), 'wigolo-elsewhere-'));
    try {
      plantRecord({ version: '1.2.3', path: outside, executable: 'run' }, join(outside, 'run'));
      expect(readSubstrateRecord(dataDir)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects an executable that climbs out with ..', () => {
    const outside = mkdtempSync(join(tmpdir(), 'wigolo-elsewhere-'));
    try {
      const dir = join(substrateRoot(dataDir), '1.2.3');
      const climb = relative(dir, join(outside, 'run'));
      plantRecord({ version: '1.2.3', path: dir, executable: climb }, join(outside, 'run'));
      // The escape is REAL, not merely refused on a technicality: the joined path resolves to a
      // file that exists, so without the rule this record would have launched it.
      expect(existsSync(join(dir, climb))).toBe(true);
      expect(readSubstrateRecord(dataDir)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects an absolute executable even where the joined path happens to exist', () => {
    // `join` does not honour an absolute second argument the way `resolve` would, so this shape
    // does not escape on POSIX — it produces a nonsense location under the substrate directory.
    // It is refused anyway, and the file is planted at exactly that nonsense location so the
    // refusal cannot be the pre-existing "the executable is not on disk" arm wearing a new name.
    const dir = join(substrateRoot(dataDir), '1.2.3');
    // Root-relative rather than drive-qualified, so `join` produces a real path on win32 too and
    // the arm is asserting the RULE on every platform instead of an EINVAL from mkdir.
    const absolute = `${sep}wigolo-elsewhere${sep}run`;
    plantRecord({ version: '1.2.3', path: dir, executable: absolute }, join(dir, absolute));
    expect(existsSync(join(dir, absolute))).toBe(true);
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });
});

describe('the version a record is filed under must be one directory name', () => {
  it('refuses to install under a version carrying a path separator', async () => {
    // `destDir` is `join(root, version)`. A version of `../../elsewhere` would put the installed
    // bytes outside the directory the budget gates measure and outside the containment rule
    // above — so the record would be written and then read back as absent, which is a machine
    // that installs a component it can never start.
    const evil: SubstrateSource = {
      id: 'evil',
      manifest: { version: '../escape', executable: 'bin/run' },
      async install(destDir: string) { mkdirSync(join(destDir, 'bin'), { recursive: true }); writeFileSync(join(destDir, 'bin', 'run'), '#!/bin/sh\n'); },
    };
    const r = await acquireSubstrate({ dataDir, source: evil });
    expect(r.outcome).toBe('failed');
    expect(readSubstrateRecord(dataDir)).toBeNull();
    expect(existsSync(join(substrateRoot(dataDir), '..', 'escape'))).toBe(false);
  });

  it('refuses a manifest whose executable escapes the directory it installs into', async () => {
    // The install genuinely PRODUCES the escaping file, so the verify step that already exists
    // would find it and write the record. Without the rule this acquisition reports `acquired`
    // for a record that the containment check above then reads back as absent — a machine that
    // installed a component it can never start.
    const evil: SubstrateSource = {
      id: 'evil',
      manifest: { version: '1.2.3', executable: join('..', 'peer', 'run') },
      async install(destDir: string) {
        mkdirSync(join(destDir, '..', 'peer'), { recursive: true });
        writeFileSync(join(destDir, '..', 'peer', 'run'), '#!/bin/sh\n');
      },
    };
    const r = await acquireSubstrate({ dataDir, source: evil });
    expect(r.outcome).toBe('failed');
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('still installs an ordinary version — the rule is not a blanket refusal', async () => {
    const r = await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    expect(r.outcome).toBe('acquired');
    expect(readSubstrateRecord(dataDir)?.version).toBe('1.2.3');
  });
});

/**
 * A COPY THAT REWRITES SYMLINKS IS NOT A COPY OF THE SUBSTRATE.
 *
 * `cpSync`'s default behaviour resolves each symlink it finds and writes an ABSOLUTE link back
 * into the SOURCE directory. A real desktop substrate is a macOS application bundle, and its
 * frameworks are built entirely on relative links (`Resources -> Versions/Current/Resources`,
 * `Current -> A`). Reproduced live on 2026-08-28, an install without `verbatimSymlinks` produced a
 * bundle that (a) crashed at launch — `icudtl.dat not found in bundle` → `GPU process isn't
 * usable. Goodbye.` — (b) executed bytes from OUTSIDE the substrate root, which is precisely what
 * the record's containment rule above claims cannot happen, and (c) dangled entirely once the
 * install source was deleted.
 *
 * The acquire-time VERIFY cannot catch this: the top-level executable is a real file, so the probe
 * passes while every framework link underneath it points somewhere else.
 *
 * Windows is skipped because creating a symlink there needs elevation, and this corruption class
 * is a POSIX-symlinked bundle shape.
 */
describe('the install copies symlinks verbatim rather than resolving them', () => {
  /**
   * A source shaped like a real framework bundle: the executable the manifest names is reachable
   * ONLY by traversing two relative symlinks.
   */
  function makeFrameworkSourceDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-substrate-fw-'));
    const framework = join(dir, 'Frameworks', 'E.framework');
    mkdirSync(join(framework, 'Versions', 'A', 'Resources'), { recursive: true });
    writeFileSync(join(framework, 'Versions', 'A', 'Resources', 'run'), '#!/bin/sh\n');
    symlinkSync('A', join(framework, 'Versions', 'Current'));
    symlinkSync(join('Versions', 'Current', 'Resources'), join(framework, 'Resources'));
    writeFileSync(
      join(dir, 'substrate.json'),
      JSON.stringify({ version: '7.7.7', executable: join('Frameworks', 'E.framework', 'Resources', 'run') }),
    );
    return dir;
  }

  const EXECUTABLE = join('Frameworks', 'E.framework', 'Resources', 'run');
  let frameworkDir: string;

  beforeEach(() => {
    frameworkDir = makeFrameworkSourceDir();
  });

  afterEach(() => {
    rmSync(frameworkDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('leaves the installed links relative instead of pointing them back at the source', async () => {
    const r = await acquireSubstrate({ dataDir, source: localPathSource(frameworkDir) });
    expect(r.outcome).toBe('acquired');
    const installed = join(substrateRoot(dataDir), '7.7.7', 'Frameworks', 'E.framework');
    expect(readlinkSync(join(installed, 'Versions', 'Current'))).toBe('A');
    expect(readlinkSync(join(installed, 'Resources'))).toBe(join('Versions', 'Current', 'Resources'));
    // Stated the other way round too, because THIS is the containment claim: no link in the
    // installed tree may address anything outside the directory it was installed into.
    expect(isAbsolute(readlinkSync(join(installed, 'Resources')))).toBe(false);
    expect(readlinkSync(join(installed, 'Resources'))).not.toContain(frameworkDir);
  });

  it.skipIf(process.platform === 'win32')('still resolves once the install source is deleted', async () => {
    // ANTI-VACUITY, and the arm that a rewritten-link copy cannot pass. An absolute link into the
    // source satisfies every existence check above for as long as the source survives — the
    // corruption only becomes visible when the thing it secretly depends on goes away. The install
    // COPIES rather than adopting in place precisely so the substrate keeps working when the source
    // moves, so this is the behaviour that was actually being promised.
    const r = await acquireSubstrate({ dataDir, source: localPathSource(frameworkDir) });
    expect(r.outcome).toBe('acquired');
    rmSync(frameworkDir, { recursive: true, force: true });
    const exec = join(substrateRoot(dataDir), '7.7.7', EXECUTABLE);
    expect(existsSync(exec)).toBe(true);
    expect(readFileSync(exec, 'utf-8')).toBe('#!/bin/sh\n');
    // And the record must still read as present: `readSubstrateRecord` follows the same chain.
    expect(readSubstrateRecord(dataDir)?.version).toBe('7.7.7');
  });
});

describe('source resolution', () => {
  it('reads a manifest from a substrate directory', () => {
    expect(readSubstrateManifest(sourceDir)).toEqual({ version: '1.2.3', executable: 'bin/run' });
  });

  it('returns no manifest for a directory that carries none', () => {
    const bare = mkdtempSync(join(tmpdir(), 'wigolo-bare-'));
    try {
      expect(readSubstrateManifest(bare)).toBeNull();
      expect(localPathSource(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('rejects a manifest missing the executable it is supposed to name', () => {
    // WHY: the executable is the one field verification depends on. A manifest without it would
    // otherwise produce a source whose install can never be verified.
    const partial = makeSourceDir({ version: '1.0.0' });
    try {
      expect(readSubstrateManifest(partial)).toBeNull();
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  });

  it('resolves no source when the environment names none', () => {
    // WHY: today's honest answer, and the reason `no_source` is a first-class outcome. S16-alpha
    // adds a published channel beneath this; until it does, a download that 404s would be worse
    // than saying there is nothing to download.
    expect(resolveSubstrateSource({})).toBeNull();
  });

  it('resolves the source named by the environment', () => {
    const source = resolveSubstrateSource({ [SUBSTRATE_PATH_ENV]: sourceDir });
    expect(source?.id).toBe('local-path');
    expect(source?.manifest.version).toBe('1.2.3');
  });
});

describe('the presence answer is memoized for the fetch path', () => {
  it('holds its answer across calls inside the window instead of re-reading the record', async () => {
    // WHY THIS CACHE EXISTS: `installedSubstrateExists()` is read by `resolveBrowserTier()`, and
    // that resolver is consulted at the single exit of `SmartRouter.fetch` — once per fetched
    // page. While the probe was a hardcoded `false` this was free; answering it from a record
    // makes it a readFileSync plus a stat on every page, and `crawl` fans out through the same
    // seam, so one crawl of a static docs site would add several hundred synchronous filesystem
    // calls to the fetch path.
    //
    // Observed through an OUTSIDE SIGNAL rather than a spy: the record is deleted underneath a
    // warm cache, and the answer must not change. A test that counted mock calls would be
    // asserting on the mock; this asserts that the filesystem was genuinely not consulted.
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    expect(substratePresent()).toBe(true);
    rmSync(join(substrateRoot(dataDir), 'record.json'), { force: true });
    expect(substratePresent()).toBe(true);
    // Control: the deletion was real, and the cache is the only reason the answer held.
    resetSubstratePresenceCache();
    expect(substratePresent()).toBe(false);
  });

  it('re-reads once the window has elapsed, so a stale answer cannot outlive it', async () => {
    // The clock is injected rather than waited on: a test that sleeps 5 s to prove a TTL is a
    // test that gets deleted the first time the suite gets slow.
    let t = 1_000_000;
    const clock = () => t;
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    expect(substratePresent(clock)).toBe(true);
    rmSync(join(substrateRoot(dataDir), 'record.json'), { force: true });
    expect(substratePresent(clock)).toBe(true);
    t += 6000;
    expect(substratePresent(clock)).toBe(false);
  });

  it('is invalidated immediately by an acquisition in this process', async () => {
    // WHY: the one transition that must NOT wait out the TTL. `warmup` acquires and then reports
    // the tier in the same process, so a cached "absent" would make it announce a rung it had
    // just stopped being on.
    expect(substratePresent()).toBe(false);
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    expect(substratePresent()).toBe(true);
  });
});
