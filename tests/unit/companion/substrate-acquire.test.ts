import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  type SubstrateManifest,
  type SubstrateSource,
} from '../../../src/companion/substrate-acquire.js';

/**
 * Real filesystem, real copies, real cleanup. These assertions are about what ends up ON DISK
 * after an acquisition — which directory grew, which record exists, what survived a failure —
 * and a mocked `node:fs` would let every one of them hold while the production path wrote
 * somewhere else entirely.
 */

/**
 * CAN THIS MACHINE PLANT THE LINKS THESE FIXTURES NEED? MEASURED, NOT GUESSED.
 *
 * The containment family used to be gated on `process.platform === 'win32'` with the rationale
 * "creating a symlink there needs elevation" — a rationale this same file contradicts, since the
 * linked-prefix arm plants a `'junction'` unskipped and the studio guard plants one on win32 too.
 * The accurate statement is narrower and is about link TYPE, not platform:
 *
 *   - A junction needs no elevation, and is a DIRECTORY link. Every arm whose plant this file
 *     makes itself can use one, so those arms run on all three shipped OSes unconditionally.
 *   - The arms below that drive `acquireSubstrate` cannot. `install()` copies with
 *     `cpSync(..., verbatimSymlinks: true)`, which re-creates each link as `symlinkSync(target,
 *     dest)` with NO type argument — Node never chooses a junction there, so a junction planted in
 *     the SOURCE comes out the other side as an ordinary link. Whether that succeeds is a property
 *     of the machine (Developer Mode, or an elevated token — GitHub's Windows runners generally
 *     have one), not of this repo.
 *
 * So the gate asks the machine instead of assuming the answer. Where Windows CAN make links, the
 * arms RUN there rather than being skipped on a guess; where it genuinely cannot, they skip for a
 * measured reason. Skipping on a guess is worse than either: four of these arms expect
 * `outcome: 'failed'`, and a `cpSync` that dies of EPERM produces exactly that — so un-skipping
 * them blindly would have bought four arms that pass without testing anything.
 */
let linkCapability: boolean | null = null;
function canPlantSymlinks(): boolean {
  if (linkCapability !== null) return linkCapability;
  const probe = mkdtempSync(join(tmpdir(), 'wigolo-link-probe-'));
  try {
    mkdirSync(join(probe, 'target'));
    writeFileSync(join(probe, 'target', 'file'), 'x');
    symlinkSync(join(probe, 'target'), join(probe, 'dir-link'));
    symlinkSync(join(probe, 'target', 'file'), join(probe, 'file-link'));
    linkCapability =
      lstatSync(join(probe, 'dir-link')).isSymbolicLink() && lstatSync(join(probe, 'file-link')).isSymbolicLink();
  } catch {
    linkCapability = false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  return linkCapability;
}

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

describe('the link-capability gate answers about the machine, not about a guess', () => {
  it('is TRUE on every platform with POSIX symlinks', () => {
    // THE OUTSIDE SIGNAL. A probe that answered `false` everywhere — a typo in the plant, a
    // `tmpdir()` that stopped being writable — would skip the whole containment family and report
    // green, which is the exact failure mode replacing `skipIf(win32)` exists to remove. On win32
    // the answer is a property of the runner (Developer Mode, or an elevated token) rather than of
    // this repo, so there is nothing here to assert; the junction-based arms run there regardless.
    if (process.platform !== 'win32') expect(canPlantSymlinks()).toBe(true);
    expect(typeof canPlantSymlinks()).toBe('boolean');
  });
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
 * These arms are gated on {@link canPlantSymlinks}, not on the platform. The fixture's links are
 * RELATIVE by construction and the assertions read their target strings back verbatim, so a
 * junction — which Node normalises to an absolute target — would be asserting something else.
 * Where a machine can make ordinary links, including a Windows one with Developer Mode, these run.
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

  it.skipIf(!canPlantSymlinks())('leaves the installed links relative instead of pointing them back at the source', async () => {
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

  it.skipIf(!canPlantSymlinks())('still resolves once the install source is deleted', async () => {
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
 * Gated on {@link canPlantSymlinks} for the same reason as the arms above: the plant has to
 * survive `cpSync`, which re-creates it without a type hint, so a junction does not help. Note
 * what un-skipping these blindly would have bought — they expect `outcome: 'failed'`, and a
 * `cpSync` that dies of EPERM produces exactly that, so on a machine that cannot make links they
 * would pass while testing nothing.
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

  it.skipIf(!canPlantSymlinks())('refuses a bundle whose executable is an absolute link out of the tree', async () => {
    const src = makeLinkedSourceDir('3.3.3', payload);
    try {
      // CONTROL: the escape is real, and every string-only check passes on it. The manifest
      // string is `bin/run`; the link resolves to a file outside anything being installed.
      expect(realpathSync(join(src, 'bin', 'run'))).toBe(realpathSync(payload));
      const r = await acquireSubstrate({ dataDir, source: localPathSource(src) });
      expect(r.outcome).toBe('failed');
      // The refusal names the offending entry via `relative()`, so the separator is the HOST's:
      // `bin/run` on POSIX, `bin\run` on win32. Pinning one spelling made this arm red on both
      // Windows jobs while the refusal it exists to pin had fired correctly. Match either
      // separator — the arm still requires the message to name `bin`+`run`, so nothing is lost.
      expect(r.error).toMatch(/bin[\\/]run/);
      // Nothing launchable is left behind: no record, and no half-installed tree to be re-found.
      expect(readSubstrateRecord(dataDir)).toBeNull();
      expect(existsSync(join(substrateRoot(dataDir), '3.3.3'))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it.skipIf(!canPlantSymlinks())('refuses an escaping link even when the executable itself is a real file', async () => {
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

  it.skipIf(!canPlantSymlinks())('refuses a DANGLING absolute link even when it is spelt inside the root', async () => {
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

  it.skipIf(!canPlantSymlinks())('refuses a RELATIVE link that climbs out of the installed tree', async () => {
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
 * Gated on {@link canPlantSymlinks} for the same reason as the arms above: `self -> .` is relative
 * by construction, it has to survive `cpSync`, and the arm reads its target back verbatim — none
 * of which a junction does. The per-test timeout is deliberate — if the rule is ever lost, this arm must report
 * as a failing test rather than as a runner that stopped making progress.
 */
describe('the walk terminates on a link cycle that is contained', () => {
  it.skipIf(!canPlantSymlinks())(
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

  // ⚠ THESE TWO RUN EVERYWHERE. The plants are DIRECTORY links made with `'junction'` — ignored on
  // POSIX, and on Windows the one directory link that needs no elevation — and nothing here goes
  // through `cpSync`, so there is no second link for the copy to re-create with the wrong type.
  // That is the difference between them and the `canPlantSymlinks()` family above.
  it('reads as absent when the directory the record names is a link out of the root', () => {
    // The record's `path` string is exactly what the acquirer writes — `<root>/1.2.3` — so string
    // containment is satisfied, `join(root, version)` and `path` are the same spelling so the
    // acquirer-path equality is satisfied too, and the executable is on disk because `existsSync`
    // follows links. Only resolving what gets SPAWNED shows it is not in the root at all.
    mkdirSync(substrateRoot(dataDir), { recursive: true });
    const dir = join(substrateRoot(dataDir), '1.2.3');
    symlinkSync(outside, dir, 'junction');
    writeFileSync(
      join(substrateRoot(dataDir), 'record.json'),
      JSON.stringify({ version: '1.2.3', path: dir, executable: 'bin/run' }),
    );
    expect(existsSync(join(dir, 'bin', 'run'))).toBe(true);
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('reads as absent when the executable it names resolves outside the root', () => {
    // The last line of defence, for a tree that was not installed by this process — a link swapped
    // in after acquisition, or a record hand-edited beside one.
    //
    // The link is on `bin/` rather than on `bin/run` so it can be a junction and the arm can run on
    // win32. It is the same defect either way: the record names `bin/run`, that path exists, and
    // the bytes the OS would execute live outside the substrate root.
    const dir = join(substrateRoot(dataDir), '1.2.3');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(outside, 'bin'), join(dir, 'bin'), 'junction');
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

/**
 * CONTAINMENT IS RELATIVE TO A ROOT, AND THE ROOT IS ITSELF A PATH ON DISK.
 *
 * Everything above answers "is this inside the root" by resolving both sides. That is the right
 * question and it has a blind spot the size of the feature: NOTHING required the root to be a real
 * directory. `substrateRoot()` is `<dataDir>/substrate`, and if that entry is a LINK to somewhere
 * else, both sides resolve into the link's target, the prefix comparison agrees, and every
 * containment check passes for a spawn target that lives entirely outside the data dir — and that
 * therefore also survives the `rm -rf ~/.wigolo` the release checklist prescribes.
 *
 * The second shape is narrower and independent: `readSubstrateRecord` asked only whether `path` was
 * SOMEWHERE under the root. The docstring above it states the actual rule — the acquirer writes
 * `path` as `substrateRoot()/<version>` and nothing else, which is the entire reason a record can
 * be treated as this product's own installation rather than as a launch instruction from whoever
 * last edited the file. A nested path under the root satisfies containment and could not have been
 * written by the acquirer, so reading it as PRESENT is the docstring's premise being false in the
 * one place the no-consent spawn depends on it.
 *
 * Both were reproduced against the built `dist/` at core `019f160c` with control arms. They are
 * independent: pinning `path` to `join(root, version)` does not close the symlinked root, and
 * refusing a symlinked root does not close the nested path.
 *
 * ⚠ THESE ARMS RUN ON EVERY PLATFORM. The plants are DIRECTORY links, made with `'junction'` —
 * ignored on POSIX, and on Windows the one directory link that needs no elevation. Nothing here
 * goes through `cpSync`, so there is no second link for the copy to re-create.
 */
describe('the substrate root is a real directory, and a record names exactly root/<version>', () => {
  let attacker: string;

  beforeEach(() => {
    attacker = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-attacker-')));
  });

  afterEach(() => {
    rmSync(attacker, { recursive: true, force: true });
  });

  /** The canonical shape, planted at the root this call is asked about. */
  function plantCanonical(root: string, version = '1.2.3'): void {
    const dir = join(root, version);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'run'), '#!/bin/sh\n');
    writeFileSync(join(root, SUBSTRATE_RECORD), JSON.stringify({ version, path: dir, executable: 'bin/run' }));
  }

  it('ACCEPTS the canonical shape — a real root holding exactly root/<version>', () => {
    // ANTI-VACUITY, local to this block. Every arm below is a refusal, and a `readSubstrateRecord`
    // hardwired to `return null` would satisfy all of them while having removed the feature.
    mkdirSync(substrateRoot(dataDir), { recursive: true });
    plantCanonical(substrateRoot(dataDir));
    expect(readSubstrateRecord(dataDir)?.version).toBe('1.2.3');
  });

  it('SEC-1: reads as absent when the substrate root is itself a link to somewhere else', () => {
    const root = substrateRoot(dataDir);
    // The root is never created — it IS the link. Everything the "acquirer" then writes lands in
    // the attacker's directory while being spelt as `<dataDir>/substrate/1.2.3`.
    symlinkSync(attacker, root, 'junction');
    plantCanonical(root);

    // CONTROL — THE ESCAPE IS REAL AND EVERY EXISTING CHECK PASSES ON IT.
    const dir = join(root, '1.2.3');
    // (a) the record's own containment rule agrees, because both sides resolve through the link;
    expect(realpathSync(dir).startsWith(realpathSync(root) + sep)).toBe(true);
    // (b) the executable `defaultLaunch` would spawn is on disk;
    expect(existsSync(join(dir, 'bin', 'run'))).toBe(true);
    // (c) and the bytes it would run live OUTSIDE the data dir entirely — so they are not what
    //     this product installed, and `rm -rf ~/.wigolo` does not remove them.
    expect(realpathSync(dir).startsWith(realpathSync(dataDir) + sep)).toBe(false);
    expect(realpathSync(join(dir, 'bin', 'run')).startsWith(attacker + sep)).toBe(true);

    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('SEC-1: the refusal is about the ROOT, not about any link on the way to it', () => {
    // ANTI-OVERREACH, and the arm that fails a fix written as "refuse if anything in the path is a
    // link". On macOS the data dir routinely sits under `/var -> /private/var`, so a rule that
    // walked the ancestors would decline every legitimate record on the platform the desktop
    // component targets. Only the root ENTRY ITSELF is required to be real.
    const realBase = realpathSync(mkdtempSync(join(tmpdir(), 'wigolo-linked-data-')));
    const linkedBase = join(dirname(realBase), `${basename(realBase)}-via-link`);
    symlinkSync(realBase, linkedBase, 'junction');
    try {
      expect(realpathSync(linkedBase)).toBe(realBase);
      mkdirSync(substrateRoot(linkedBase), { recursive: true });
      // The root is a real directory REACHED THROUGH a link, which is the shape that must keep
      // working.
      expect(lstatSync(substrateRoot(linkedBase)).isSymbolicLink()).toBe(false);
      plantCanonical(substrateRoot(linkedBase));
      expect(readSubstrateRecord(linkedBase)?.version).toBe('1.2.3');
    } finally {
      rmSync(linkedBase, { recursive: true, force: true });
      rmSync(realBase, { recursive: true, force: true });
    }
  });

  it('SEC-2: reads as absent when the path is nested under the root but is not root/<version>', () => {
    const root = substrateRoot(dataDir);
    // ⚠ THE LEGITIMATE INSTALL IS PLANTED TOO, AND THAT IS WHAT MAKES THIS ARM SHARP. Without it
    // `join(root, version)` resolves to nothing and the refusal comes from "the acquirer's path is
    // not on disk" — a real rule, but the WEAK half: it leaves the arm green against a fix that
    // dropped the equality entirely. Measured, 2026-08-29: that mutant survived. With a real
    // `<root>/1.2.3` present, both sides resolve and only `named !== expected` refuses this record.
    // It is also the realistic shape — an installed component, and a record edited beside it to
    // name a payload dropped somewhere else under the same root.
    plantCanonical(root);
    const nested = join(root, 'tmp', 'deep');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'helper'), '#!/bin/sh\n');
    writeFileSync(join(root, SUBSTRATE_RECORD), JSON.stringify({ version: '1.2.3', path: nested, executable: 'helper' }));

    // CONTROL: containment is genuinely satisfied — this really is inside the root, so the arm is
    // not the pre-existing "path escapes the root" rule wearing a new name. What it is not is the
    // one path the acquirer writes.
    expect(realpathSync(nested).startsWith(realpathSync(root) + sep)).toBe(true);
    expect(existsSync(join(nested, 'helper'))).toBe(true);
    // CONTROL: and the path the acquirer WOULD have written is on disk, so the refusal cannot be
    // the "expected location is absent" arm.
    expect(existsSync(join(root, '1.2.3', 'bin', 'run'))).toBe(true);

    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('SEC-2: reads as absent when root/<version> is absent, even though the path it names is real', () => {
    // The other half of the same rule, kept as its own arm now that the one above deliberately
    // plants a real `<root>/<version>`: a record naming a location that exists, filed under a
    // version that was never installed, is still not something the acquirer wrote.
    const root = substrateRoot(dataDir);
    const nested = join(root, 'tmp', 'deep');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'helper'), '#!/bin/sh\n');
    writeFileSync(join(root, SUBSTRATE_RECORD), JSON.stringify({ version: '9.9.9', path: nested, executable: 'helper' }));
    expect(existsSync(join(root, '9.9.9'))).toBe(false);
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('SEC-2: reads as absent when the version is not one directory name', () => {
    // THE ARM THAT MAKES `join(root, version)` A RULE RATHER THAN A COINCIDENCE. Pinning `path` to
    // `join(root, raw.version)` is only worth anything while `version` is a directory NAME: with
    // `version: '.'` the join is the root itself, the equality holds, containment holds, and a
    // payload dropped beside `record.json` reads back as an installed component. That is the same
    // "not written by the acquirer" class, one level up, and it survives the equality fix alone.
    const root = substrateRoot(dataDir);
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin', 'run'), '#!/bin/sh\n');
    writeFileSync(join(root, SUBSTRATE_RECORD), JSON.stringify({ version: '.', path: root, executable: 'bin/run' }));

    // CONTROL: the equality this fix is built on is SATISFIED by this shape.
    expect(realpathSync(root)).toBe(realpathSync(join(root, '.')));
    expect(existsSync(join(root, 'bin', 'run'))).toBe(true);

    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('SEC-1: does not INSTALL into a linked root either, rather than acquiring what it then refuses', async () => {
    // THE WRITE SIDE OF THE SAME RULE, and not the read arm wearing a second hat. `mkdirSync`
    // succeeds on an existing link and `isInside(destDir, root)` agrees because both sides resolve
    // through it, so acquisition would report `acquired`, copy the component into a directory
    // OUTSIDE the data dir, and then read back as absent on every subsequent run — the permanent
    // acquire/read disagreement this module's version guard exists to prevent.
    const root = substrateRoot(dataDir);
    symlinkSync(attacker, root, 'junction');
    const r = await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/symlink/);
    // And it refused BEFORE copying anything into the attacker's directory.
    expect(existsSync(join(attacker, '1.2.3'))).toBe(false);
    expect(readSubstrateRecord(dataDir)).toBeNull();
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

describe('a manifest field that is not a string never reaches a path join', () => {
  /**
   * THIS IS NOT PEDANTRY ABOUT JSON TYPES. `substrate.json` is a file this process does not
   * write, and the manifest was validated by TRUTHINESS — so `"version": 1.0` produced a manifest
   * whose `version` was a number. `isSingleDirectoryName(1)` is truthy-true, and `join(root, 1)`
   * then threw `ERR_INVALID_ARG_TYPE` from a statement that sat OUTSIDE the try. `warmup` awaits
   * this call with no try/catch on the strength of the documented NEVER THROWS, so the entire
   * warmup run — browser engine, models, search — died on the one path whose stated job is to
   * degrade loudly to the rung that works.
   */
  const NON_STRING: Array<[string, unknown]> = [
    ['a number', 1.0],
    ['an array', ['1.0']],
    ['a boolean', true],
  ];

  for (const [shape, value] of NON_STRING) {
    it(`refuses a version that is ${shape}, and acquisition resolves instead of rejecting`, async () => {
      const dir = makeSourceDir({ version: value, executable: 'bin/run' });
      try {
        expect(readSubstrateManifest(dir)).toBeNull();
        expect(localPathSource(dir)).toBeNull();
        const r = await acquireSubstrate({ dataDir, env: { [SUBSTRATE_PATH_ENV]: dir } });
        expect(r.outcome).toBe('no_source');
        expect(readSubstrateRecord(dataDir)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`refuses an executable that is ${shape}, and acquisition resolves instead of rejecting`, async () => {
      // The executable takes a different route to the same crash: `isAbsolute(1)` throws before
      // the join does, from the guard one line above it — also outside the try.
      const dir = makeSourceDir({ version: '1.2.3', executable: value });
      try {
        expect(readSubstrateManifest(dir)).toBeNull();
        expect(localPathSource(dir)).toBeNull();
        const r = await acquireSubstrate({ dataDir, env: { [SUBSTRATE_PATH_ENV]: dir } });
        expect(r.outcome).toBe('no_source');
        expect(readSubstrateRecord(dataDir)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('still reads a version that merely LOOKS numeric — the rule is typeof, not spelling', () => {
    // ANTI-VACUITY: a guard that declined anything numeric-looking would pass every arm above
    // while refusing `"1.0"`, which is an ordinary version string a real build would ship.
    const dir = makeSourceDir({ version: '1.0', executable: 'bin/run' });
    try {
      expect(readSubstrateManifest(dir)).toEqual({ version: '1.0', executable: 'bin/run' });
      expect(localPathSource(dir)?.manifest.version).toBe('1.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves rather than rejecting when a source hands it a non-string version directly', async () => {
    // The manifest guard closes the shapes we thought of; this closes the CLASS. `destDir` is
    // computed INSIDE the try, so anything that throws on the way to it becomes a `failed`
    // outcome rather than an escaping rejection — which is what NEVER THROWS has to mean
    // structurally for `warmup`'s unguarded await to be safe.
    const source: SubstrateSource = {
      id: 'bad-manifest',
      manifest: { version: 1.0, executable: 'bin/run' } as unknown as SubstrateManifest,
      async install() {
        throw new Error('never reached');
      },
    };
    const r = await acquireSubstrate({ dataDir, source });
    expect(r.outcome).toBe('failed');
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });
});

describe('the injected-source seam carries the same never-throws contract as the manifest reader', () => {
  /**
   * THE MANIFEST READER IS NOT THE ONLY DOOR. `readSubstrateManifest` establishes `typeof ===
   * 'string'` for the two path fields, so a `substrate.json` on disk can no longer produce a
   * source whose manifest is mistyped. A source handed in through `deps.source` never passes
   * that reader — and that seam is the one a published channel re-enters with a manifest of its
   * own. The pre-flight guards then answered from OUTSIDE the try: `staysInsideItsDirectory`
   * calls `isAbsolute()`, which throws `ERR_INVALID_ARG_TYPE` on a non-string, straight past a
   * documented NEVER THROWS and into `warmup`'s unguarded await.
   *
   * So the discriminator below is deliberately settle-vs-reject rather than any particular
   * outcome string: the contract is about the promise's shape, and an assertion on `outcome`
   * alone cannot tell a refusal apart from a crash.
   */
  const NON_STRING: Array<[string, unknown]> = [
    ['a number', 1],
    ['an array', ['bin/run']],
    ['a boolean', true],
    ['null', null],
  ];

  async function settle(manifest: unknown): Promise<{ status: 'resolved' | 'rejected'; value?: unknown }> {
    return acquireSubstrate({
      dataDir,
      source: {
        id: 'injected',
        manifest: manifest as SubstrateManifest,
        async install() {
          throw new Error('never reached');
        },
      },
    }).then(
      (value) => ({ status: 'resolved' as const, value }),
      () => ({ status: 'rejected' as const }),
    );
  }

  for (const [shape, value] of NON_STRING) {
    it(`settles rather than rejecting when an injected manifest's executable is ${shape}`, async () => {
      const settled = await settle({ version: '1.0', executable: value });
      expect(settled.status).toBe('resolved');
      expect((settled.value as { outcome: string }).outcome).toBe('failed');
      expect(readSubstrateRecord(dataDir)).toBeNull();
    });

    it(`settles rather than rejecting when an injected manifest's version is ${shape}`, async () => {
      const settled = await settle({ version: value, executable: 'bin/run' });
      expect(settled.status).toBe('resolved');
      expect((settled.value as { outcome: string }).outcome).toBe('failed');
      expect(readSubstrateRecord(dataDir)).toBeNull();
    });
  }

  it('still acquires a well-formed injected source — the seam guard refuses shapes, not everything', async () => {
    // ANTI-VACUITY: a guard that declined every injected manifest would satisfy every arm above
    // while breaking the seam S16-alpha's published channel is going to arrive through.
    const settled = await acquireSubstrate({
      dataDir,
      source: {
        id: 'injected',
        manifest: { version: '4.5.6', executable: 'bin/run' },
        async install(destDir: string) {
          mkdirSync(join(destDir, 'bin'), { recursive: true });
          writeFileSync(join(destDir, 'bin', 'run'), '#!/bin/sh\n');
        },
      },
    });
    expect(settled.outcome).toBe('acquired');
    expect(readSubstrateRecord(dataDir)?.version).toBe('4.5.6');
  });
});

describe('a record field that is not a string reads back as absent', () => {
  /**
   * THE SIBLING ASYMMETRY. `readSubstrateManifest` establishes `typeof === 'string'`;
   * `readSubstrateRecord` checked truthiness only — and `record.json` is a file this process
   * wrote but any process can edit. A numeric `version` is truthy, so the record read back as
   * PRESENT and `installedSubstrateExists()` reported a rung whose version is a number: it flows
   * into `already_present`'s detail text and into every log line and doctor row downstream.
   * Every throw the other two fields can raise is absorbed by this function's own try/catch
   * today, so this arm is about the ONE shape that gets through, plus the consistency that stops
   * the next reader having to re-derive which of the two functions to trust.
   */
  /** A real installed substrate, so every arm below fails on the TYPE and nothing else. */
  function installTree(): string {
    const installed = join(substrateRoot(dataDir), '1.2.3');
    mkdirSync(join(installed, 'bin'), { recursive: true });
    writeFileSync(join(installed, 'bin', 'run'), '#!/bin/sh\n');
    return installed;
  }

  function putRecord(record: unknown): void {
    writeFileSync(join(substrateRoot(dataDir), SUBSTRATE_RECORD), JSON.stringify(record));
  }

  it('refuses a record whose version is a number, even though the substrate is really there', () => {
    putRecord({ version: 1.0, executable: 'bin/run', path: installTree() });
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('refuses a record whose executable is a number', () => {
    putRecord({ version: '1.2.3', executable: 1, path: installTree() });
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('refuses a record whose path is a number', () => {
    installTree();
    putRecord({ version: '1.2.3', executable: 'bin/run', path: 7 });
    expect(readSubstrateRecord(dataDir)).toBeNull();
  });

  it('still reads a well-formed record back — the type check is not a blanket refusal', () => {
    putRecord({ version: '1.2.3', executable: 'bin/run', path: installTree() });
    expect(readSubstrateRecord(dataDir)?.version).toBe('1.2.3');
  });
});

describe('an install source that is itself a symlink to a directory', () => {
  let linkRoot: string;
  let linkPath: string;

  beforeEach(() => {
    linkRoot = mkdtempSync(join(tmpdir(), 'wigolo-substrate-link-'));
    linkPath = join(linkRoot, 'current');
    symlinkSync(sourceDir, linkPath, 'dir');
  });

  afterEach(() => {
    rmSync(linkRoot, { recursive: true, force: true });
  });

  it('installs the bytes rather than recording a link that reads back as absent', async () => {
    // WHY: `verbatimSymlinks` copies a link's target string unchanged — INCLUDING when the source
    // itself is a link, in which case `destDir` becomes a link out of the substrate root.
    // `findEscapingLink` anchors on `realpathSync(destDir)`, so it found nothing to complain
    // about; the acquisition reported `acquired` and `readSubstrateRecord` then correctly refused
    // the record it had just written. Every later run re-acquired and re-failed identically —
    // the exact state the version guard's own comment says it exists to prevent.
    const r = await acquireSubstrate({ dataDir, source: localPathSource(linkPath) });
    expect(r.outcome).toBe('acquired');
    expect(readSubstrateRecord(dataDir)?.version).toBe('1.2.3');
    const destDir = join(substrateRoot(dataDir), '1.2.3');
    expect(lstatSync(destDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(destDir, 'bin', 'run'))).toBe(true);
  });

  it('copies rather than adopting — the source directory is left intact', async () => {
    // The whole reason acquisition copies instead of pointing at the source is that the source
    // may move or be deleted. Resolving the link must not turn cleanup into a delete of it.
    await acquireSubstrate({ dataDir, source: localPathSource(linkPath) });
    expect(existsSync(join(sourceDir, 'bin', 'run'))).toBe(true);
  });
});

describe('an install that lands outside the substrate root is failed, never acquired', () => {
  it('refuses when install() makes destDir itself a link out of the root', async () => {
    // The generalisation of the symlinked-source bug: whatever `install()` does, the directory
    // the record is about to name must be inside the root the record is later checked against.
    // Asserting it here is what makes "acquired" and "readable" the same answer instead of two
    // answers that can disagree forever.
    const outside = mkdtempSync(join(tmpdir(), 'wigolo-substrate-outside-'));
    mkdirSync(join(outside, 'bin'), { recursive: true });
    writeFileSync(join(outside, 'bin', 'run'), '#!/bin/sh\n');
    const sneaky: SubstrateSource = {
      id: 'sneaky',
      manifest: { version: '9.9.9', executable: 'bin/run' },
      async install(destDir: string) {
        symlinkSync(outside, destDir, 'dir');
      },
    };
    try {
      const r = await acquireSubstrate({ dataDir, source: sneaky });
      expect(r.outcome).toBe('failed');
      expect(readSubstrateRecord(dataDir)).toBeNull();
      // And the cleanup unlinks the link rather than following it into somebody's directory.
      expect(existsSync(join(outside, 'bin', 'run'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('still acquires an ordinary install — the assertion is not a blanket refusal', async () => {
    const r = await acquireSubstrate({ dataDir, source: localPathSource(sourceDir) });
    expect(r.outcome).toBe('acquired');
    expect(realpathSync(join(substrateRoot(dataDir), '1.2.3')).startsWith(realpathSync(substrateRoot(dataDir)))).toBe(
      true,
    );
  });
});
