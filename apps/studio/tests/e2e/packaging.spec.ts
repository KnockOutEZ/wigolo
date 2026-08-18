import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { get } from 'node:http';
import { OMIT_ENV } from '../../electron-builder.config';

/**
 * GATED (RUN_STUDIO_PACKAGE_E2E) — separately from RUN_STUDIO_E2E, because this file BUILDS three
 * complete Electron artifacts (~380 MB and several minutes each). It is the only place the packaged
 * code path is actually executed rather than reasoned about.
 *
 * BE HONEST ABOUT WHAT THE GATE COSTS: nothing in ordinary CI runs any of this, so a packaged-only
 * regression reaches a launch before it reaches a failing test. That is exactly how the DB-broker
 * defect shipped. The cheap half of that lesson lives in `tests/unit/broker-asar-path.test.ts`, which
 * simulates the two packaged trees with ordinary directories and DOES run on every push.
 *
 * What it proves, and why each half is needed:
 *
 *  - POSITIVE: every native module the studio depends on loads from INSIDE the packaged app. Not
 *    "the file is present" — an opened DB with a working FTS5 MATCH, a real KNN query through the
 *    loaded sqlite-vec extension, and both @rpath-linked bindings resolving their dylibs.
 *
 *  - BROKER: the studio DB broker actually STARTS from the packaged tree and data goes through it and
 *    comes back — resolve, boot, ping, a persisted capture read back, an FTS5 MATCH on the row the
 *    broker wrote, and a vec0 table only a broker with a loaded extension could have created. Two
 *    controls sit under it: the pre-fix in-archive anchor (hosted on the packaged Electron binary, so
 *    the asar layer is really in play) and an artifact built without the broker's unpack glob.
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
const BROKER_PROBE = join(import.meta.dirname, '../broker-probe.cjs');
const GOOD_OUT = 'release-e2e';
const CONTROL_OUT = 'release-e2e-control';
const BROKER_CONTROL_OUT = 'release-e2e-broker-control';

const appPath = (out: string) => join(APP_DIR, out, 'mac-arm64', 'Wigolo Studio.app');
const binary = (out: string) => join(appPath(out), 'Contents/MacOS/Wigolo Studio');
/** Anchor inside the sealed archive — this is the resolution root the packaged main process gets. */
const asarAnchor = (out: string) => join(appPath(out), 'Contents/Resources/app.asar/out/main/index.js');
/**
 * Anchor in the on-disk unpacked tree — the resolution root a plain-Node child has to work from, and
 * what `toUnpackedPath()` in `src/main/broker-client.ts` rewrites the real anchor into.
 *
 * This path is SYNTHETIC and that is deliberate: only `node_modules/**` is unpacked, so
 * `app.asar.unpacked/out/main/index.js` does not exist on disk and is not supposed to. `createRequire`
 * never stats its anchor — it only walks `node_modules` upward from the anchor's directory — so this
 * is purely a resolution base. Do NOT "correct" it to a file that exists; pointing it back at the
 * archive is the bug this file now guards.
 */
const unpackedAnchor = (out: string) => join(appPath(out), 'Contents/Resources/app.asar.unpacked/out/main/index.js');

interface ProbeResult {
  modules: Record<string, { ok: boolean; detail: string }>;
}

interface BrokerProbeResult {
  brokerPath?: string;
  stages: Record<string, { ok: boolean; detail: string }>;
  brokerStderrTail: string;
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

/**
 * Boot the DB broker exactly the way the packaged Electron main does — plain Node, resolving from
 * `anchor` — and drive a real round trip through it. Always plain `node`: the broker's whole reason to
 * exist is that better-sqlite3 12.9.0 has no Electron build (see the ABI test below).
 */
function brokerProbe(anchor: string, out: string, host?: { runtime: string; env: NodeJS.ProcessEnv }): BrokerProbeResult {
  const dataDir = mkdtempSync(join(tmpdir(), `wigolo-broker-${out}-`));
  // An Electron-hosted run cannot open the broker's DB itself (engine is Node-ABI 127, Electron is
  // 148), so it stops after the round trip.
  const args = host ? [BROKER_PROBE, anchor, dataDir, '--skip-db-inspect'] : [BROKER_PROBE, anchor, dataDir];
  let stdout: string;
  try {
    stdout = execFileSync(host?.runtime ?? 'node', args, {
      encoding: 'utf8',
      env: { ...process.env, ...host?.env },
      timeout: 5 * 60_000,
      // The broker boots the full core subsystem stack; a cold run is not fast.
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // A failing stage exits non-zero BY DESIGN — its JSON is the result, not an error.
    const e = err as { stdout?: string; message?: string };
    if (!e.stdout?.trim()) throw new Error(`broker probe produced no output: ${e.message}`);
    stdout = e.stdout;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  return JSON.parse(stdout.trim().split('\n').pop() as string) as BrokerProbeResult;
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

describe.skipIf(!RUN)('the DB broker boots from the packaged tree', () => {
  beforeAll(() => {
    if (!existsSync(binary(GOOD_OUT))) pack(GOOD_OUT, {});
  }, 20 * 60_000);

  it('starts the broker and round-trips a capture through it', () => {
    // The defect this covers was invisible to every gate and was found by launching the app: the
    // gateway came up, the broker did not. Nothing short of executing the child process can see it.
    const { stages, brokerPath, brokerStderrTail } = brokerProbe(unpackedAnchor(GOOD_OUT), GOOD_OUT);
    expect(stages.resolve?.ok, stages.resolve?.detail).toBe(true);
    // Resolution succeeding is NOT the property that matters — the pre-fix path resolved too, and so
    // does a path in the developer's own workspace. `containment` is the assertion with teeth: the
    // broker has to come out of the ARTIFACT. See the note on it in broker-probe.cjs.
    expect(stages.containment?.ok, stages.containment?.detail).toBe(true);
    expect(brokerPath).toContain('app.asar.unpacked');
    expect(stages.ready?.ok, `${stages.ready?.detail}\n${brokerStderrTail}`).toBe(true);
    expect(stages.ping?.ok, stages.ping?.detail).toBe(true);
    expect(stages.roundTrip?.ok, stages.roundTrip?.detail).toBe(true);
  }, 6 * 60_000);

  it('gives that broker a working FTS5 index and vector store', () => {
    // Both live behind the broker, and both are load-bearing for studio: FTS5 backs capture search,
    // vec0 backs find_similar. A broker that booted with either silently degraded is not "working".
    const { stages, brokerStderrTail } = brokerProbe(unpackedAnchor(GOOD_OUT), GOOD_OUT);
    expect(stages.fts5?.ok, `${stages.fts5?.detail}\n${brokerStderrTail}`).toBe(true);
    expect(stages.vec?.ok, `${stages.vec?.detail}\n${brokerStderrTail}`).toBe(true);
  }, 6 * 60_000);
});

describe.skipIf(!RUN)('negative control: the pre-fix anchor, inside the archive', () => {
  beforeAll(() => {
    if (!existsSync(binary(GOOD_OUT))) pack(GOOD_OUT, {});
  }, 20 * 60_000);

  // Hosted on the packaged ELECTRON binary, which is what makes this a faithful reproduction rather
  // than an approximation. Only Electron has the asar layer, and the layer is the entire trap: it
  // makes the in-archive path resolve AND makes `existsSync` return true for it, so the host has no
  // local way to notice that what it is about to hand a plain-Node child is not a file. No
  // `smartUnpack=false` needed anywhere here — this control is about the ANCHOR, not about a glob.
  const host = { runtime: binary(GOOD_OUT), env: { ELECTRON_RUN_AS_NODE: '1' } };

  it('resolves, passes an existence check, and still cannot start the broker', () => {
    const { stages, brokerPath } = brokerProbe(asarAnchor(GOOD_OUT), GOOD_OUT, host);
    expect(stages.resolve?.ok).toBe(true); // the trap, stated out loud
    expect(brokerPath).toContain('app.asar/node_modules');
    expect(stages.ready?.ok).toBe(false);
    // The exact production signature: the child dies on the entry point it was handed.
    expect(stages.ready?.detail).toMatch(/Cannot find module|MODULE_NOT_FOUND/);
    expect(stages.roundTrip).toBeUndefined();
  }, 6 * 60_000);

  it('starts fine from the unpacked anchor on that same host and artifact', () => {
    // The discriminating half. Same Electron, same build, same broker — only the anchor differs, so
    // "the broker is broken" and "the anchor is wrong" cannot be confused.
    const { stages, brokerStderrTail } = brokerProbe(unpackedAnchor(GOOD_OUT), GOOD_OUT, host);
    expect(stages.containment?.ok, stages.containment?.detail).toBe(true);
    expect(stages.ready?.ok, `${stages.ready?.detail}\n${brokerStderrTail}`).toBe(true);
    expect(stages.roundTrip?.ok, stages.roundTrip?.detail).toBe(true);
  }, 6 * 60_000);
});

describe.skipIf(!RUN)('negative control: the broker unpack glob removed', () => {
  beforeAll(() => {
    // smartUnpack is deliberately LEFT ON here, unlike the native control below. That is the claim
    // under test: the broker's module graph is the wigolo package plus ~19 external packages, and
    // apart from the four native ones NONE of them contains a binary, so the heuristic has nothing to
    // notice and cannot rescue any of it. If this control ever goes green, smartUnpack grew a new
    // rule and the glob's necessity has to be re-argued — not deleted.
    pack(BROKER_CONTROL_OUT, { [OMIT_ENV]: 'studio-db-broker' });
  }, 20 * 60_000);

  it('leaves the broker with no entry point inside the artifact', () => {
    // MEASURED 2026-08-17, and not what was predicted. Dropping the glob does NOT make resolution
    // fail: Node walks `node_modules` upward, escapes the .app bundle entirely, and finds the
    // developer's own checkout — which then boots a broker and passes every functional stage. Six
    // green stages for an artifact that is dead on any machine but the one that built it. So the
    // assertion is containment, not failure; a control that asserted `resolve.ok === false` would
    // have gone red on CI-the-machine and green here, for reasons unrelated to packaging.
    const { stages, brokerPath } = brokerProbe(unpackedAnchor(BROKER_CONTROL_OUT), BROKER_CONTROL_OUT);
    expect(stages.containment?.ok).toBe(false);
    expect(brokerPath).not.toContain('app.asar.unpacked');
    expect(stages.ready).toBeUndefined();
  }, 6 * 60_000);

  it('still unpacks the native engines in that same artifact', () => {
    // The discriminating half: "the broker glob mattered" has to look different from "this build is
    // broken everywhere". better-sqlite3 and sqlite-vec keep their own globs here.
    const { modules } = probe('node', {}, unpackedAnchor(BROKER_CONTROL_OUT), ['better-sqlite3', 'sqlite-vec']);
    expect(modules['better-sqlite3'].ok, modules['better-sqlite3'].detail).toBe(true);
    expect(modules['sqlite-vec'].ok, modules['sqlite-vec'].detail).toBe(true);
    // `ok` ALONE IS NOT ENOUGH, and this artifact is the one that proves it: `**/node_modules/**` is
    // dropped here, so if a native module also lost its own glob, resolution walks up out of the .app
    // bundle, finds the developer's checkout, dlopens happily and reports ok — green on an artifact
    // that is dead everywhere else. That is the same escape that made the broker control vacuous on
    // its first run, twenty lines up. native-probe.cjs has no containment check of its own, so the
    // path has to be asserted here.
    expect(modules['better-sqlite3'].detail).toContain('app.asar.unpacked');
    expect(modules['sqlite-vec'].detail).toContain('app.asar.unpacked');
  });
});

describe.skipIf(!RUN)('negative control: asarUnpack entries removed', () => {
  beforeAll(() => {
    // smartUnpack off is what makes this a control at all — see the file header.
    //
    // `studio-db-broker` MUST be in the omit list even though this control is aimed at the native
    // globs: its `**/node_modules/**` subsumes every entry in NATIVE_ASAR_UNPACK, so leaving it in
    // would unpack onnxruntime-node and sharp regardless of their own globs being dropped, and both
    // probes below would pass for a reason that has nothing to do with what is under test. Same class
    // of vacuous control as the smartUnpack one, different mechanism.
    pack(CONTROL_OUT, { [OMIT_ENV]: 'onnxruntime-node,sharp,studio-db-broker' }, ['-c.asar.smartUnpack=false']);
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

/**
 * The remote-debugging-port fence, EXECUTED (cdp-fence.ts, S9 spec §6).
 *
 * `decideCdpDebugPort` is unit-tested exhaustively, but every one of those tests passes
 * `isPackaged` as a literal. `app.isPackaged` is false in any unpackaged tree, so until this ran
 * the claim "a packaged build never opens the debugger port" rested on reasoning: nothing had ever
 * observed the packaged branch of the real `app` object, let alone the socket.
 *
 * A REFUSED PORT PROVES NOTHING ON ITS OWN. A probe pointed at a port nobody opened refuses
 * identically whether the fence works, the app crashed on boot, or the probe is broken. So the
 * fenced result is only ever asserted next to a run of the SAME probe, on the SAME port, against a
 * build where the fence does not apply — which must come back with a live CDP browser. Anything
 * less is the vacuous control this file's other half was already caught by once.
 */
const LOOSE_ELECTRON = join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const LOOSE_MAIN = join(APP_DIR, 'out/main/index.js');
/** Long enough for the engine to bind a port if it is ever going to; a boot is not instant. */
const BOOT_MS = 12_000;

interface FenceObservation {
  /** Which branch of the fence the real process took, read from its own stderr. */
  branch: 'IGNORED' | 'OPENED' | 'NO_FENCE_LINE';
  /** Result of a TCP connect: 'CONNECTED', or the errno the kernel returned. */
  tcp: string;
  /** `Browser` from the CDP `/json/version` handshake. Only a real debugger answers this. */
  cdpBrowser: string | null;
  /** Every TCP port the process tree is LISTENING on — "not 9222" is weaker than "nothing". */
  listening: string[];
}

async function freeCdpPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

function tcpProbe(port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    const done = (v: string) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(3000);
    s.on('connect', () => done('CONNECTED'));
    s.on('timeout', () => done('TIMEOUT'));
    s.on('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'ERROR'));
  });
}

function cdpHandshake(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/json/version', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve((JSON.parse(body) as { Browser?: string }).Browser ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/** Every LISTEN socket held by the launched process and its descendants. */
function listeningPorts(rootPid: number): string[] {
  let pids: number[];
  try {
    const rows = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length === 2)
      .map(([pid, ppid]) => ({ pid: Number(pid), ppid: Number(ppid) }));
    const want = new Set([rootPid]);
    for (let i = 0; i < 8; i++) for (const r of rows) if (want.has(r.ppid)) want.add(r.pid);
    pids = [...want];
  } catch {
    pids = [rootPid];
  }
  try {
    return execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(',')], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
      .filter(Boolean);
  } catch {
    // lsof exits non-zero when the filter matches nothing. For the fenced build that IS the result.
    return [];
  }
}

async function observeFence(runtime: string, args: string[], port: number): Promise<FenceObservation> {
  const dataDir = mkdtempSync(join(tmpdir(), 'wigolo-cdp-fence-'));
  const child = spawn(runtime, args, {
    env: {
      ...process.env,
      WIGOLO_STUDIO_CDP_PORT: String(port),
      // No window: this asserts on a socket, and a visible window is not part of the claim.
      WIGOLO_STUDIO_HIDDEN: '1',
      WIGOLO_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += String(d)));
  child.stdout.on('data', () => {});
  try {
    await new Promise((r) => setTimeout(r, BOOT_MS));
    const tcp = await tcpProbe(port);
    return {
      branch: /was IGNORED/.test(stderr) ? 'IGNORED' : /SECURITY: .*is OPEN/.test(stderr) ? 'OPENED' : 'NO_FENCE_LINE',
      tcp,
      cdpBrowser: tcp === 'CONNECTED' ? await cdpHandshake(port) : null,
      listening: listeningPorts(child.pid as number),
    };
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe.skipIf(!RUN)('the CDP fence, executed on a real packaged build', () => {
  let port: number;
  let packaged: FenceObservation;
  let loose: FenceObservation;

  beforeAll(async () => {
    if (!existsSync(binary(GOOD_OUT))) pack(GOOD_OUT, {});
    if (!existsSync(LOOSE_ELECTRON)) {
      // Fail loudly rather than skip. A skipped control is indistinguishable from a control that
      // passed, and this whole block is worthless without the unfenced arm.
      throw new Error(
        `the unfenced control needs the dev Electron binary at ${LOOSE_ELECTRON}; run electron's install script (npm rebuild electron) in apps/studio first`,
      );
    }
    port = await freeCdpPort();
    // The unfenced arm runs FIRST and the fenced arm re-uses the very port it just held open, so
    // "the port happened to be closed already" cannot explain the fenced result.
    loose = await observeFence(LOOSE_ELECTRON, [LOOSE_MAIN], port);
    packaged = await observeFence(binary(GOOD_OUT), [], port);
  }, 25 * 60_000);

  it('CONTROL: the unpackaged build opens the port, and the probe sees a live debugger', () => {
    // The load-bearing half. If this arm is ever anything but a real CDP browser, the fenced arm
    // below is measuring a broken probe and must not be believed.
    expect(loose.branch).toBe('OPENED');
    expect(loose.tcp).toBe('CONNECTED');
    expect(loose.cdpBrowser, 'no CDP handshake — the probe cannot tell open from closed').toMatch(/Chrome\//);
    expect(loose.listening.join('\n')).toContain(`:${port} `);
  });

  it('takes the IGNORED branch in a packaged build and refuses the port', () => {
    expect(packaged.branch).toBe('IGNORED');
    expect(packaged.tcp, 'the packaged build answered on the debugger port').toBe('ECONNREFUSED');
    expect(packaged.cdpBrowser).toBeNull();
  });

  it('opens no debugger port anywhere, not merely not the one that was asked for', () => {
    // `remote-debugging-port` is never appended, so there is no port to find. Asserting only that
    // the REQUESTED port refuses would leave "the engine bound somewhere else" untested — and the
    // fence's promise to the user is "No port is open", not "not that one".
    expect(packaged.listening.join('\n')).not.toContain(`:${port} `);
    // The app's own gateway is expected; a second listener would want explaining.
    expect(packaged.listening.length, packaged.listening.join('\n')).toBeLessThanOrEqual(1);
  });
});
