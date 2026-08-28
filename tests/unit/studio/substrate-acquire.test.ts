import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
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
  SUBSTRATE_RECORD,
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

  /**
   * THE TWO VERSIONS THAT CARRY NO SEPARATOR AND STILL NAME SOMEWHERE ELSE.
   *
   * The arm above plants `../escape`, so it stays green against a predicate narrowed to
   * `!/[\\/]/` — and that narrowing looks like a simplification, because "one directory name" and
   * "contains no separator" read as the same rule. They are not. `destDir` is `join(root, version)`
   * and the NEXT statement is `rmSync(destDir, { recursive: true, force: true })`, so:
   *
   *   `.`  → destDir IS the substrate root  → deletes every installed version and the record
   *   `..` → destDir IS the data dir        → deletes the cache DB, the keys and the profiles
   *
   * Neither spelling contains a separator, so neither is caught by the narrowed form, and both
   * reach a recursive delete before anything is verified.
   *
   * WHY THE FIXTURE HALF-UNINSTALLS FIRST. With a valid record on disk `acquireSubstrate` returns
   * `already_present` before it ever computes `destDir`, so a fully-healthy machine cannot reach
   * the delete at all. The state that CAN is the one this file already names elsewhere — the
   * record is still there and the executable it points at is gone — which is what an interrupted
   * uninstall, a partial upgrade, or a first run against a populated root all look like.
   *
   * The assertions are about what survived, not about the outcome word, because `..` under the
   * narrowed predicate still ends in `failed`: it destroys the data dir, then fails writing the
   * record into the `substrate/` directory it just deleted. An outcome-only arm would go green on
   * the very shape that wiped the machine.
   */
  it.each(['.', '..'])('refuses version %j rather than making it the directory it deletes', async (version) => {
    await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    const root = substrateRoot(dataDir);
    const installed = join(root, '1.2.3');
    const exec = join(installed, 'bin', 'run');
    expect(readSubstrateRecord(dataDir)?.version).toBe('1.2.3');

    // A data-dir neighbour that only `..` reaches — the cache DB stands in for everything the
    // substrate root's PARENT holds and that acquisition has no business touching.
    const neighbour = join(dataDir, 'cache.db');
    writeFileSync(neighbour, 'not-a-substrate');

    // Half-uninstalled: the record survives, its executable does not, so the record reads as
    // absent and the acquisition proceeds past the `already_present` gate.
    rmSync(exec);
    expect(readSubstrateRecord(dataDir)).toBeNull();

    const evil: SubstrateSource = {
      id: 'evil',
      manifest: { version, executable: 'bin/run' },
      async install(destDir: string) {
        mkdirSync(join(destDir, 'bin'), { recursive: true });
        writeFileSync(join(destDir, 'bin', 'run'), '#!/bin/sh\n');
      },
    };
    const r = await acquireSubstrate({ dataDir, source: evil });

    expect(r.outcome).toBe('failed');
    // Nothing was deleted: the earlier install's directory, the record filed beside it, and the
    // rest of the data dir are all still where they were.
    expect(existsSync(installed)).toBe(true);
    expect(existsSync(join(root, SUBSTRATE_RECORD))).toBe(true);
    expect(existsSync(neighbour)).toBe(true);
    expect(readFileSync(neighbour, 'utf-8')).toBe('not-a-substrate');
    // And the earlier record reads back the moment its executable returns — only possible because
    // neither the record nor the directory it names was removed.
    writeFileSync(exec, '#!/bin/sh\n');
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
    // Stated the other way round too. NOTE WHAT THIS ARM DOES AND DOES NOT ESTABLISH: every link
    // in this fixture is relative BY CONSTRUCTION, so these two lines confirm the copy did not
    // REWRITE them — they are not evidence that an escaping link would be refused. That claim is
    // only true because of the containment walk, and it is the negative arms below that hold it up.
    expect(isAbsolute(readlinkSync(join(installed, 'Resources')))).toBe(false);
    expect(readlinkSync(join(installed, 'Resources'))).not.toContain(frameworkDir);
    // The positive half of the containment rule: the thing `defaultLaunch` would spawn resolves
    // INSIDE the substrate root even though reaching it traverses two links.
    const spawnTarget = realpathSync(join(substrateRoot(dataDir), '7.7.7', EXECUTABLE));
    expect(spawnTarget.startsWith(realpathSync(substrateRoot(dataDir)) + sep)).toBe(true);
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

/**
 * VERBATIM IS NOT THE SAME AS CONTAINED, and everything above is blind to the difference.
 *
 * `verbatimSymlinks` copies a link's target STRING unchanged, which is what keeps a framework
 * bundle's relative links working — and equally what carries a SOURCE-AUTHORED ABSOLUTE link
 * across intact. Every check the module had was a string check on a path that never touched the
 * filesystem: the manifest says `bin/run` (no `..`, not absolute) so the manifest rule passes;
 * `isInside` compared `resolve()` output so the record rule passes; the acquire-time probe used
 * `existsSync`, which FOLLOWS the link, so verification passes. `defaultLaunch` then spawns
 * `join(path, executable)`, the OS follows the link, and the bytes that run live somewhere else
 * on the machine entirely.
 *
 * Reproduced end to end on 2026-08-28 through the real `acquireSubstrate` / `readSubstrateRecord`
 * / `defaultLaunch`: outcome `acquired`, spawn target resolving to `<elsewhere>/payload.sh`, and
 * the payload executing. These arms are that reproduction, refused.
 *
 * Relative escapes are included even though the issue's working vector was absolute: the rule is
 * "where does this RESOLVE", not "does this start with a slash", and an arm that only plants
 * absolute links would stay green against a fix that merely banned the leading separator.
 *
 * Windows is skipped for the same reason the arms above are: creating a symlink there needs
 * elevation.
 */
describe('the install refuses a tree whose links leave it', () => {
  let outside: string;
  let payload: string;

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'wigolo-outside-'));
    payload = join(outside, 'payload.sh');
    writeFileSync(payload, '#!/bin/sh\necho pwned\n');
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  /** A bundle whose manifest names `bin/run` — the canonical, always-accepted string. */
  function makeLinkedSourceDir(version: string, linkTarget: string, opts: { realExecutable?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'wigolo-substrate-link-'));
    mkdirSync(join(dir, 'bin'), { recursive: true });
    if (opts.realExecutable) {
      writeFileSync(join(dir, 'bin', 'run'), '#!/bin/sh\n');
      symlinkSync(linkTarget, join(dir, 'lib'));
    } else {
      symlinkSync(linkTarget, join(dir, 'bin', 'run'));
    }
    writeFileSync(join(dir, 'substrate.json'), JSON.stringify({ version, executable: 'bin/run' }));
    return dir;
  }

  it.skipIf(process.platform === 'win32')('refuses a bundle whose executable is an absolute link out of the tree', async () => {
    const src = makeLinkedSourceDir('3.3.3', payload);
    try {
      // CONTROL: the escape is real, and every string-only check passes on it. The manifest
      // string is `bin/run`; the link resolves to a file outside anything being installed.
      expect(realpathSync(join(src, 'bin', 'run'))).toBe(realpathSync(payload));
      const r = await acquireSubstrate({ dataDir, source: localPathSource(src) });
      expect(r.outcome).toBe('failed');
      expect(r.error).toMatch(/bin\/run/);
      // Nothing launchable is left behind: no record, and no half-installed tree to be re-found.
      expect(readSubstrateRecord(dataDir)).toBeNull();
      expect(existsSync(join(substrateRoot(dataDir), '3.3.3'))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses an escaping link even when the executable itself is a real file', async () => {
    // The acquire-time probe is satisfied here — `bin/run` is genuine bytes — so this arm is what
    // distinguishes a containment WALK from a second existence check on the one named path. A
    // bundle's dynamic libraries and resources are reached through links the manifest never names.
    const src = makeLinkedSourceDir('3.3.4', outside, { realExecutable: true });
    try {
      const r = await acquireSubstrate({ dataDir, source: localPathSource(src) });
      expect(r.outcome).toBe('failed');
      expect(readSubstrateRecord(dataDir)).toBeNull();
      expect(existsSync(join(substrateRoot(dataDir), '3.3.4'))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a DANGLING absolute link even when it is spelt inside the root', async () => {
    // THE ARM THAT MAKES THE ABSOLUTE RULE ITS OWN MECHANISM. For a link that resolves, the
    // absolute rule and the resolve rule agree and either alone would do. They part exactly here:
    // this link resolves to nothing, so a walk that judged only by resolution would fall back to
    // judging it lexically, find it spelt inside today's substrate root, and admit it — leaving an
    // absolute path baked into the installed tree that the substrate follows the moment anything
    // appears there, and that points somewhere else entirely the moment the data dir moves.
    // Without the absolute rule this arm goes green with the hole open.
    mkdirSync(substrateRoot(dataDir), { recursive: true });
    const inside = join(realpathSync(substrateRoot(dataDir)), '3.3.6', 'lib', 'not-here-yet');
    expect(isAbsolute(inside)).toBe(true);
    const src = makeLinkedSourceDir('3.3.6', inside, { realExecutable: true });
    try {
      const r = await acquireSubstrate({ dataDir, source: localPathSource(src) });
      expect(r.outcome).toBe('failed');
      expect(readSubstrateRecord(dataDir)).toBeNull();
      expect(existsSync(join(substrateRoot(dataDir), '3.3.6'))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a RELATIVE link that climbs out of the installed tree', async () => {
    // Not the reported vector — a relative link re-anchors at the destination and usually dangles.
    // It is here because the rule is "where does this resolve", and a fix that only banned a
    // leading separator would leave this one green while the hole stayed open.
    const destDir = join(substrateRoot(dataDir), '3.3.5');
    const climb = relative(join(destDir, 'bin'), payload);
    const src = makeLinkedSourceDir('3.3.5', climb);
    try {
      expect(isAbsolute(climb)).toBe(false);
      const r = await acquireSubstrate({ dataDir, source: localPathSource(src) });
      expect(r.outcome).toBe('failed');
      expect(readSubstrateRecord(dataDir)).toBeNull();
      expect(existsSync(destDir)).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});

/**
 * THE WALK TERMINATES, AND ONLY ONE LINE MAKES THAT TRUE.
 *
 * `findEscapingLink` walks the installed tree with `readdirSync(withFileTypes)`, which stats
 * WITHOUT following, so a link to a directory reports `isSymbolicLink()` and never
 * `isDirectory()` — it is judged as a link and is not pushed onto the queue. That single fact is
 * the whole termination argument, and the arms above do not test it: the framework fixture has
 * contained directory links, but none of them points at an ancestor, so the walk finishes for
 * reasons that have nothing to do with the rule.
 *
 * `self -> .` is a LEGAL tree. It is contained, so it must install; a bundle can legitimately
 * carry one (`Versions/Current -> .` shapes appear in the wild). Following directory links —
 * swapping `entry.isDirectory()` for a `statSync(child).isDirectory()`, which reads as making the
 * walk "more thorough" — turns it into `self/self/self/…` forever. The caller is `acquireSubstrate`
 * on the warmup path, unattended and with no timeout of its own, so the failure is a warmup that
 * never returns rather than a component that fails to install.
 *
 * Windows is skipped for the same reason as the arms above: creating a symlink there needs
 * elevation. The per-test timeout is deliberate — if the rule is ever lost, this arm must report
 * as a failing test rather than as a runner that stopped making progress.
 */
describe('the walk terminates on a link cycle that is contained', () => {
  it.skipIf(process.platform === 'win32')(
    'installs a tree whose directory link points at its own parent',
    async () => {
      const src = mkdtempSync(join(tmpdir(), 'wigolo-substrate-cycle-'));
      try {
        mkdirSync(join(src, 'bin'), { recursive: true });
        writeFileSync(join(src, 'bin', 'run'), '#!/bin/sh\n');
        // The cycle: a directory link back to the directory that holds it.
        symlinkSync('.', join(src, 'self'));
        writeFileSync(join(src, 'substrate.json'), JSON.stringify({ version: '3.3.7', executable: 'bin/run' }));

        // CONTROL: the cycle is real — the link resolves to the directory it sits in, so a walk
        // that descended into it would be re-reading its own parent.
        expect(realpathSync(join(src, 'self'))).toBe(realpathSync(src));

        const r = await acquireSubstrate({ dataDir, source: localPathSource(src) });

        // Contained is contained: this is an ACCEPT, not a refusal that happens to terminate.
        expect(r.outcome).toBe('acquired');
        expect(readSubstrateRecord(dataDir)?.version).toBe('3.3.7');
        // The link survived the copy as a link, so the installed tree still carries the cycle the
        // walk had to survive — not a resolved directory that quietly removed it.
        expect(readlinkSync(join(substrateRoot(dataDir), '3.3.7', 'self'))).toBe('.');
      } finally {
        rmSync(src, { recursive: true, force: true });
      }
    },
    10_000,
  );
});

describe('containment is answered by the filesystem, not by string comparison', () => {
  let outside: string;

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'wigolo-outside-'));
    mkdirSync(join(outside, 'bin'), { recursive: true });
    writeFileSync(join(outside, 'bin', 'run'), '#!/bin/sh\n');
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('reads as absent when the directory the record names is a link out of the root', () => {
    // The record's `path` string is exactly what the acquirer writes — `<root>/1.2.3` — so string
    // containment is satisfied, and the executable is on disk because `existsSync` follows links.
    // Only resolving the directory shows it is not in the root at all.
    mkdirSync(substrateRoot(dataDir), { recursive: true });
    const dir = join(substrateRoot(dataDir), '1.2.3');
    symlinkSync(outside, dir);
    writeFileSync(
      join(substrateRoot(dataDir), 'record.json'),
      JSON.stringify({ version: '1.2.3', path: dir, executable: 'bin/run' }),
    );
    expect(existsSync(join(dir, 'bin', 'run'))).toBe(true);
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('reads as absent when the executable it names resolves outside the root', () => {
    // The last line of defence, for a tree that was not installed by this process — a link swapped
    // in after acquisition, or a record hand-edited beside one.
    const dir = join(substrateRoot(dataDir), '1.2.3');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    symlinkSync(join(outside, 'bin', 'run'), join(dir, 'bin', 'run'));
    writeFileSync(
      join(substrateRoot(dataDir), 'record.json'),
      JSON.stringify({ version: '1.2.3', path: dir, executable: 'bin/run' }),
    );
    expect(existsSync(join(dir, 'bin', 'run'))).toBe(true);
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('still accepts a record whose paths cross a legitimately-linked prefix', () => {
    // ANTI-FALSE-DECLINE, and the reason the comparison realpaths BOTH sides. On macOS the data
    // dir routinely lives under `/var/...`, which is itself a link to `/private/var/...`, so a
    // rule that resolved only one side would decline every real record on the platform the
    // desktop component targets.
    //
    // ⚠ THE LINKED PREFIX IS CONSTRUCTED, NOT BORROWED FROM `tmpdir()`. This arm used to run
    // against the ambient `dataDir`, and that made it a macOS-only test wearing no label: there
    // `/var/folders/...` resolves to `/private/var/...` and the one-sided mutant reds, but on
    // ubuntu `/tmp` is already real, both spellings agree, and the arm passes against the very
    // mutant it exists to kill — proving nothing, silently, on the platform CI runs. So the base
    // is built here: a real directory (`realpathSync` forces that, even where `tmpdir()` is
    // itself linked) plus a link to it, and everything below goes through the LINK.
    //
    // `'junction'` is what makes that platform-independent rather than trading one skip for
    // another: POSIX ignores the type argument, and on Windows a junction is the one directory
    // link that does not need elevation — which is why this arm is absent from the win32 skip
    // family its siblings belong to.
    const realBase = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-linked-base-')));
    const linkedBase = join(dirname(realBase), `${basename(realBase)}-via-link`);
    symlinkSync(realBase, linkedBase, 'junction');
    try {
      // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED. Without this line a future environment —
      // a filesystem that collapses the link, a Windows runner where the junction did not take —
      // would vacate the whole arm and still report green.
      expect(realpathSync(linkedBase)).not.toBe(linkedBase);
      expect(realpathSync(linkedBase)).toBe(realBase);

      const dir = join(substrateRoot(linkedBase), '1.2.3');
      mkdirSync(join(dir, 'bin'), { recursive: true });
      writeFileSync(join(dir, 'bin', 'run'), '#!/bin/sh\n');
      writeFileSync(
        join(substrateRoot(linkedBase), 'record.json'),
        JSON.stringify({ version: '1.2.3', path: dir, executable: 'bin/run' }),
      );
      expect(readSubstrateRecord(linkedBase)?.version).toBe('1.2.3');
    } finally {
      rmSync(linkedBase, { recursive: true, force: true });
      rmSync(realBase, { recursive: true, force: true });
    }
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
