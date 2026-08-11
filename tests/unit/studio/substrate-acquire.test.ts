import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireSubstrate,
  localPathSource,
  readSubstrateManifest,
  readSubstrateRecord,
  resolveSubstrateSource,
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
});

afterEach(() => {
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
