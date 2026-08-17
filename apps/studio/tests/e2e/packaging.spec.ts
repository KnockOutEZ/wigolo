import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OMIT_ENV } from '../../electron-builder.config';

/**
 * GATED (RUN_STUDIO_PACKAGE_E2E) — separately from RUN_STUDIO_E2E, because this file BUILDS two
 * complete Electron artifacts (~380 MB and several minutes each). It is the only place the packaged
 * code path is actually executed rather than reasoned about.
 *
 * What it proves, and why each half is needed:
 *
 *  - POSITIVE: every native module the studio depends on loads from INSIDE the packaged app. Not
 *    "the file is present" — an opened DB with a working FTS5 MATCH, a real KNN query through the
 *    loaded sqlite-vec extension, and both @rpath-linked bindings resolving their dylibs.
 *
 *  - NEGATIVE: the same probe against an artifact built with two asarUnpack entries removed must
 *    FAIL, with the @rpath signature, while the entries we kept still pass in that same artifact.
 *    Without this half the positive result is unfalsifiable — and it very nearly was: measured on
 *    2026-08-17, electron-builder's `smartUnpack` heuristic auto-unpacks any module root containing
 *    a binary, so simply deleting our globs changes nothing and a naive control passes for a reason
 *    that has nothing to do with the globs. The control therefore ALSO disables smartUnpack, which
 *    is what isolates the globs as the mechanism under test.
 *
 * Two runtimes, deliberately:
 *  - the packaged Electron binary (NODE_MODULE_VERSION 148) with `require` anchored inside app.asar,
 *    for the N-API modules;
 *  - plain Node (148's counterpart, 127) anchored at the packaged app's on-disk unpacked tree, for
 *    better-sqlite3 and sqlite-vec. That is not a convenience: the DB broker is a plain-Node child
 *    process (spec §13.7) and better-sqlite3 12.9.0 has no Electron-ABI build at all, so 127 is the
 *    ABI that genuinely has to load these files.
 */
const RUN = !!process.env.RUN_STUDIO_PACKAGE_E2E;

const APP_DIR = join(import.meta.dirname, '../..');
const PROBE = join(import.meta.dirname, '../native-probe.cjs');
const GOOD_OUT = 'release-e2e';
const CONTROL_OUT = 'release-e2e-control';

const appPath = (out: string) => join(APP_DIR, out, 'mac-arm64', 'Wigolo Studio.app');
const binary = (out: string) => join(appPath(out), 'Contents/MacOS/Wigolo Studio');
/** Anchor inside the sealed archive — this is the resolution root the packaged main process gets. */
const asarAnchor = (out: string) => join(appPath(out), 'Contents/Resources/app.asar/out/main/index.js');
/** Anchor in the on-disk unpacked tree — the resolution root a plain-Node child has to work from. */
const unpackedAnchor = (out: string) => join(appPath(out), 'Contents/Resources/app.asar.unpacked/out/main/index.js');

interface ProbeResult {
  modules: Record<string, { ok: boolean; detail: string }>;
}

function pack(out: string, env: NodeJS.ProcessEnv, extraArgs: string[] = []): void {
  rmSync(join(APP_DIR, out), { recursive: true, force: true });
  execFileSync(
    'npx',
    ['electron-builder', '--mac', '--arm64', '--config', 'electron-builder.config.ts', `-c.directories.output=${out}`, ...extraArgs],
    { cwd: APP_DIR, env: { ...process.env, ...env }, stdio: 'pipe', timeout: 15 * 60_000 },
  );
}

function probe(runtime: string, env: NodeJS.ProcessEnv, anchor: string, modules: string[]): ProbeResult {
  let stdout: string;
  try {
    stdout = execFileSync(runtime, [PROBE, anchor, ...modules], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 120_000,
    });
  } catch (err) {
    // A failing module makes the probe exit non-zero BY DESIGN; its JSON is still on stdout and is
    // the whole point. Only a probe that produced no JSON at all is a genuine harness failure.
    const e = err as { stdout?: string; message?: string };
    if (!e.stdout?.trim()) throw new Error(`probe produced no output: ${e.message}`);
    stdout = e.stdout;
  }
  return JSON.parse(stdout.trim().split('\n').pop() as string) as ProbeResult;
}

describe.skipIf(!RUN)('packaged darwin-arm64 artifact', () => {
  beforeAll(() => {
    if (!existsSync(binary(GOOD_OUT))) pack(GOOD_OUT, {});
  }, 20 * 60_000);

  it('produces an app.asar with a sibling app.asar.unpacked tree', () => {
    // If nothing was unpacked at all, every later assertion in this file would be measuring the
    // wrong artifact.
    expect(existsSync(join(appPath(GOOD_OUT), 'Contents/Resources/app.asar'))).toBe(true);
    expect(existsSync(join(appPath(GOOD_OUT), 'Contents/Resources/app.asar.unpacked/node_modules'))).toBe(true);
  });

  it('loads the @rpath-linked N-API modules under the packaged Electron binary', () => {
    const { modules } = probe(binary(GOOD_OUT), { ELECTRON_RUN_AS_NODE: '1' }, asarAnchor(GOOD_OUT), [
      'onnxruntime-node',
      'sharp',
    ]);
    expect(modules['onnxruntime-node']).toMatchObject({ ok: true });
    // sharp reports the libvips version it actually loaded, so this cannot pass on a stub.
    expect(modules.sharp.ok, modules.sharp.detail).toBe(true);
    expect(modules.sharp.detail).toMatch(/libvips=\d+\.\d+/);
  });

  it('opens a DB with working FTS5 and answers a KNN query from the packaged tree', () => {
    const { modules } = probe('node', {}, unpackedAnchor(GOOD_OUT), ['better-sqlite3', 'sqlite-vec']);
    expect(modules['better-sqlite3'].ok, modules['better-sqlite3'].detail).toBe(true);
    expect(modules['sqlite-vec'].ok, modules['sqlite-vec'].detail).toBe(true);
    // Assert the files came from the ARTIFACT, not from the developer's workspace node_modules — the
    // probe would otherwise happily pass against a loose install and prove nothing about packaging.
    expect(modules['better-sqlite3'].detail).toContain('app.asar.unpacked');
    expect(modules['sqlite-vec'].detail).toContain('app.asar.unpacked');
  });

  it('rejects better-sqlite3 in the Electron process for an ABI reason, not an asar one', () => {
    // Encodes the boundary of what packaging can fix. If this ever starts passing, better-sqlite3
    // gained an Electron build and the asarUnpack half of broker retirement is fully clear; if it
    // starts failing with a "Library not loaded" message instead, packaging regressed and the ABI
    // story is masking it.
    const { modules } = probe(binary(GOOD_OUT), { ELECTRON_RUN_AS_NODE: '1' }, asarAnchor(GOOD_OUT), ['better-sqlite3']);
    expect(modules['better-sqlite3'].ok).toBe(false);
    expect(modules['better-sqlite3'].detail).toMatch(/NODE_MODULE_VERSION/);
    expect(modules['better-sqlite3'].detail).toContain('app.asar.unpacked');
  });
});

describe.skipIf(!RUN)('negative control: asarUnpack entries removed', () => {
  beforeAll(() => {
    // smartUnpack off is what makes this a control at all — see the file header.
    pack(CONTROL_OUT, { [OMIT_ENV]: 'onnxruntime-node,sharp' }, ['-c.asar.smartUnpack=false']);
  }, 20 * 60_000);

  it('breaks onnxruntime-node on its @rpath dylib', () => {
    const { modules } = probe(binary(CONTROL_OUT), { ELECTRON_RUN_AS_NODE: '1' }, asarAnchor(CONTROL_OUT), [
      'onnxruntime-node',
    ]);
    expect(modules['onnxruntime-node'].ok).toBe(false);
    expect(modules['onnxruntime-node'].detail).toContain('@rpath/libonnxruntime');
  });

  it('breaks sharp on its @rpath libvips', () => {
    const { modules } = probe(binary(CONTROL_OUT), { ELECTRON_RUN_AS_NODE: '1' }, asarAnchor(CONTROL_OUT), ['sharp']);
    expect(modules.sharp.ok).toBe(false);
    expect(modules.sharp.detail).toContain('@rpath/libvips-cpp');
  });

  it('leaves the entries it kept working in that same artifact', () => {
    // The discriminating half. Without it, "everything broke" and "the right thing broke" look
    // identical, and a control that cannot tell them apart is not a control.
    const { modules } = probe('node', {}, unpackedAnchor(CONTROL_OUT), ['better-sqlite3', 'sqlite-vec']);
    expect(modules['better-sqlite3'].ok, modules['better-sqlite3'].detail).toBe(true);
    expect(modules['sqlite-vec'].ok, modules['sqlite-vec'].detail).toBe(true);
  });
});
