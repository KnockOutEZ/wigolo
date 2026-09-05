import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import {
  COMPANION_MANIFEST_PATH,
  detectCompanionTarget,
  runStudioSetup,
  setupCompanion,
  type CompanionRelease,
  type CompanionSetupDeps,
} from '../../../src/cli/studio-setup.js';
import { parseCommand } from '../../../src/cli/index.js';

/**
 * C5 acceptance — the companion download/pair bootstrap against a MOCKED RELEASE HOST.
 *
 * The host is a real loopback server rather than a stubbed `fetch`, because the two properties
 * this file exists to pin are both HTTP-level: a resumed download has to send a byte range the
 * server actually honours, and a mismatching checksum has to stop the install AFTER the bytes
 * arrived. A stubbed fetch would let both pass while the wire behaviour was wrong.
 */

const APP_NAME = 'Wigolo Studio.app';

/**
 * The loopback opt-out, spelled out at every call site that uses a fixture host.
 *
 * `studio setup` refuses a cleartext release address before it opens a socket, and these fixtures
 * ARE cleartext — a loopback server with no certificate. Passing the opt-out explicitly rather
 * than ambiently is deliberate: an arm that installs from a fixture is stating that it needed a
 * hole in the transport rule, and an arm that forgets to state it fails the way a real user's
 * plain-http host would.
 */
const ALLOW_HTTP: NodeJS.ProcessEnv = { WIGOLO_COMPANION_ALLOW_HTTP: '1' };

/**
 * The shell-out the post-install security step goes through, recorded.
 *
 * `signed` is what a real `codesign --verify` would answer. A fixture bundle is a directory with
 * a marker file in it, so the honest default is UNSIGNED — which is exactly the case that must
 * still be quarantined and must NOT be assessed.
 */
function recordingRun(opts: { xattrCode?: number; signed?: boolean; assessCode?: number } = {}): {
  run: NonNullable<CompanionSetupDeps['run']>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'xattr') return { code: opts.xattrCode ?? 0, stderr: opts.xattrCode ? 'Operation not permitted' : '' };
      if (cmd === 'codesign') return { code: opts.signed ? 0 : 1, stderr: opts.signed ? '' : 'code object is not signed at all' };
      if (cmd === 'spctl') return { code: opts.assessCode ?? 0, stderr: opts.assessCode ? 'rejected source=no usable signature' : '' };
      return { code: 0, stderr: '' };
    },
  };
}

function getPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

function startServer(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Deterministic stand-in for the disk image, big enough that a partial file is a real prefix. */
function artifactBytes(size = 4096): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) % 251;
  return buf;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface Host {
  server: http.Server;
  origin: string;
  /** Every Range header the artifact route saw, in order. */
  ranges: Array<string | undefined>;
  /** Bytes actually written down the wire per artifact request. */
  served: number[];
}

/**
 * A release host that serves one manifest and one artifact, honouring `Range` the way a static
 * file host does. `checksum` is what the manifest CLAIMS, which the mismatch arm makes a lie.
 */
async function startHost(payload: Buffer, checksum: string, version = '1.4.0'): Promise<Host> {
  const state: Pick<Host, 'ranges' | 'served'> = { ranges: [], served: [] };
  const artifactPath = `/companion/wigolo-studio-${version}-darwin-arm64.dmg`;
  let origin = '';

  const server = await startServer((req, res) => {
    if (req.url === COMPANION_MANIFEST_PATH) {
      const release: CompanionRelease = {
        version,
        artifacts: {
          'darwin-arm64': { url: `${origin}${artifactPath}`, sha256: checksum, size: payload.length },
        },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(release));
      return;
    }
    if (req.url === artifactPath) {
      const range = req.headers.range as string | undefined;
      state.ranges.push(range);
      const match = range?.match(/^bytes=(\d+)-$/);
      const start = match ? Number(match[1]) : 0;
      if (start >= payload.length) {
        res.writeHead(416, { 'content-range': `bytes */${payload.length}` });
        res.end();
        state.served.push(0);
        return;
      }
      const slice = payload.subarray(start);
      state.served.push(slice.length);
      if (start > 0) {
        res.writeHead(206, {
          'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'content-length': String(slice.length),
        });
      } else {
        res.writeHead(200, { 'content-length': String(slice.length) });
      }
      res.end(slice);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  origin = `http://127.0.0.1:${getPort(server)}`;
  return { server, origin, ranges: state.ranges, served: state.served };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wigolo-companion-'));
}

/** Collects everything a verb writes, both streams, as one string. */
function collector(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/**
 * Stands in for the disk-image installer. Records that it ran and where, so "no install" is an
 * assertion about a call that did not happen rather than about an empty directory that might
 * have been empty for some other reason.
 */
function recordingInstaller(installRoot: string): {
  install: NonNullable<CompanionSetupDeps['install']>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    install: async (artifactPath: string): Promise<string> => {
      calls.push(artifactPath);
      const dest = join(installRoot, APP_NAME);
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'marker'), readFileSync(artifactPath));
      return dest;
    },
  };
}

describe('detectCompanionTarget', () => {
  it('keys a target by platform and architecture', () => {
    expect(detectCompanionTarget('darwin', 'arm64')).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      key: 'darwin-arm64',
      supported: true,
    });
  });

  it('marks a platform with no published artifact unsupported rather than guessing one', () => {
    expect(detectCompanionTarget('linux', 'x64').supported).toBe(false);
    expect(detectCompanionTarget('win32', 'x64').supported).toBe(false);
  });
});

describe('setupCompanion', () => {
  const hosts: http.Server[] = [];
  afterEach(async () => {
    while (hosts.length > 0) {
      const s = hosts.pop();
      if (s) await closeServer(s);
    }
  });

  it('downloads, verifies and installs on the happy path, then launches for pairing', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);

    const root = tempRoot();
    const installRoot = join(root, 'Applications');
    mkdirSync(installRoot, { recursive: true });
    const installer = recordingInstaller(installRoot);
    const shell = recordingRun();
    const launched: string[] = [];

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: installer.install,
      run: shell.run,
      launch: async (p: string) => {
        launched.push(p);
        return true;
      },
    });

    expect(result.outcome).toBe('installed');
    expect(result.version).toBe('1.4.0');
    expect(installer.calls).toHaveLength(1);
    // The bundle we downloaded ourselves carries no quarantine flag unless we write one, and
    // without it this system never evaluates the application at first launch.
    const marked = shell.calls.find((c) => c[0] === 'xattr');
    expect(marked?.slice(0, 3)).toEqual(['xattr', '-w', 'com.apple.quarantine']);
    expect(marked?.[3]).toMatch(/^0081;[0-9a-f]+;wigolo;$/);
    expect(marked?.[4]).toBe(join(installRoot, APP_NAME));
    // Unsigned fixture: the assessment would refuse it by definition, so it must not be asked.
    expect(shell.calls.map((c) => c[0])).toEqual(['xattr', 'codesign']);
    expect(existsSync(join(installRoot, APP_NAME, 'marker'))).toBe(true);
    expect(readFileSync(join(installRoot, APP_NAME, 'marker')).equals(payload)).toBe(true);
    expect(launched).toEqual([join(installRoot, APP_NAME)]);
    // A first-run launch is the pairing handshake's trigger; saying so is the whole point of
    // the verb, so the outcome has to carry it rather than leaving the user to guess.
    expect(result.launched).toBe(true);
  });

  it('refuses a checksum mismatch with a typed outcome, installs nothing, and drops the bytes', async () => {
    const payload = artifactBytes();
    // The manifest claims a digest the bytes do not have — a corrupted mirror or a swapped file.
    const host = await startHost(payload, sha256(Buffer.from('something else entirely')));
    hosts.push(host.server);

    const root = tempRoot();
    const installRoot = join(root, 'Applications');
    mkdirSync(installRoot, { recursive: true });
    const installer = recordingInstaller(installRoot);

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: installer.install,
      run: recordingRun().run,
      launch: async () => true,
    });

    expect(result.outcome).toBe('checksum_mismatch');
    expect(installer.calls).toEqual([]);
    expect(readdirSync(installRoot)).toEqual([]);
    // The partial MUST be gone: bytes that failed verification would otherwise be the prefix a
    // later `--resume` builds on, and a poisoned prefix can never verify.
    expect(result.partialRetained).toBe(false);
    expect(existsSync(result.artifactPath ?? '')).toBe(false);
    expect(result.manualFallback).toContain(host.origin);
  });

  it('resumes from a partial download instead of refetching bytes already on disk', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);

    const root = tempRoot();
    const installRoot = join(root, 'Applications');
    mkdirSync(installRoot, { recursive: true });
    const dataDir = join(root, 'data');

    // Seed exactly the prefix an interrupted download would have left behind.
    const prefix = payload.subarray(0, 1500);
    const partial = join(dataDir, 'studio', 'downloads', `wigolo-studio-1.4.0-darwin-arm64.dmg.part`);
    mkdirSync(join(dataDir, 'studio', 'downloads'), { recursive: true });
    writeFileSync(partial, prefix);

    const installer = recordingInstaller(installRoot);
    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: installer.install,
      run: recordingRun().run,
      launch: async () => true,
    });

    expect(result.outcome).toBe('installed');
    expect(host.ranges).toEqual([`bytes=${prefix.length}-`]);
    // The server sent only the tail. If the range were ignored the file would still verify —
    // the resume claim is only provable from what crossed the wire.
    expect(host.served).toEqual([payload.length - prefix.length]);
    expect(result.resumedFromBytes).toBe(prefix.length);
    expect(readFileSync(join(installRoot, APP_NAME, 'marker')).equals(payload)).toBe(true);
  });

  it('restarts from zero when the host ignores the range and answers 200', async () => {
    const payload = artifactBytes();
    const checksum = sha256(payload);
    const root = tempRoot();
    const dataDir = join(root, 'data');
    const installRoot = join(root, 'Applications');
    mkdirSync(installRoot, { recursive: true });

    const partial = join(dataDir, 'studio', 'downloads', 'wigolo-studio-1.4.0-darwin-arm64.dmg.part');
    mkdirSync(join(dataDir, 'studio', 'downloads'), { recursive: true });
    writeFileSync(partial, payload.subarray(0, 900));

    let origin = '';
    const server = await startServer((req, res) => {
      if (req.url === COMPANION_MANIFEST_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            version: '1.4.0',
            artifacts: { 'darwin-arm64': { url: `${origin}/art.dmg`, sha256: checksum } },
          } satisfies CompanionRelease),
        );
        return;
      }
      // A range-blind host: always the whole body, always 200.
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    hosts.push(server);
    origin = `http://127.0.0.1:${getPort(server)}`;

    const installer = recordingInstaller(installRoot);
    const result = await setupCompanion({
      releaseHost: origin,
      env: ALLOW_HTTP,
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: installer.install,
      launch: async () => true,
    });

    expect(result.outcome).toBe('installed');
    expect(result.resumedFromBytes).toBe(0);
    // Appending a whole body onto a stale prefix is the bug this arm exists for: the file must
    // be the payload exactly, not 900 bytes longer than it.
    expect(statSync(join(installRoot, APP_NAME, 'marker')).size).toBe(payload.length);
  });

  it('declines a platform with no published artifact without touching the network', async () => {
    const root = tempRoot();
    let hit = false;
    const server = await startServer((_req, res) => {
      hit = true;
      res.writeHead(500);
      res.end();
    });
    hosts.push(server);

    const result = await setupCompanion({
      releaseHost: `http://127.0.0.1:${getPort(server)}`,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'linux',
      arch: 'x64',
      installRoot: join(root, 'Applications'),
    });

    expect(result.outcome).toBe('platform_unsupported');
    expect(hit).toBe(false);
    expect(result.manualFallback).toBeTruthy();
  });

  it('says so plainly when no release host is configured yet', async () => {
    const root = tempRoot();
    const result = await setupCompanion({
      releaseHost: null,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
    });

    expect(result.outcome).toBe('no_release_host');
    expect(result.manualFallback).toBeTruthy();
  });

  it('types an unreadable manifest rather than falling through to a download', async () => {
    const root = tempRoot();
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"version":"1.4.0"}');
    });
    hosts.push(server);
    const installer = recordingInstaller(join(root, 'Applications'));

    const result = await setupCompanion({
      releaseHost: `http://127.0.0.1:${getPort(server)}`,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      install: installer.install,
    });

    expect(result.outcome).toBe('manifest_unreadable');
    expect(installer.calls).toEqual([]);
  });

  it('is idempotent: a second run over a recorded install downloads nothing', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);

    const root = tempRoot();
    const installRoot = join(root, 'Applications');
    mkdirSync(installRoot, { recursive: true });
    const dataDir = join(root, 'data');
    const installer = recordingInstaller(installRoot);
    const base: CompanionSetupDeps = {
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: installer.install,
      run: recordingRun().run,
      launch: async () => true,
    };

    expect((await setupCompanion(base)).outcome).toBe('installed');
    const second = await setupCompanion(base);

    expect(second.outcome).toBe('already_current');
    expect(installer.calls).toHaveLength(1);
    expect(host.served).toHaveLength(1);

    // `--force` is the way back to a fresh download over an intact record.
    const forced = await setupCompanion({ ...base, force: true });
    expect(forced.outcome).toBe('installed');
    expect(installer.calls).toHaveLength(2);
  });
});

/**
 * The default installer, with only the shell-out injected.
 *
 * Every other arm above replaces the installer wholesale, which is right for asserting WHETHER an
 * install happened but leaves the thing that actually moves the bundle untested. Here the disk
 * image is faked at the mount point — the level a real `attach` produces — so the copy, the bundle
 * discovery and the unmount are the code under test.
 */
describe('setupCompanion — disk-image install path', () => {
  const hosts: http.Server[] = [];
  afterEach(async () => {
    while (hosts.length > 0) {
      const s = hosts.pop();
      if (s) await closeServer(s);
    }
  });

  function fakeHdiutil(opts: { bundle?: string; attachCode?: number } = {}): {
    run: NonNullable<CompanionSetupDeps['run']>;
    calls: string[][];
  } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        // The post-install security step shells out through this same injection point; a fixture
        // bundle is unsigned, so `codesign` refuses it and the assessment is correctly skipped.
        if (cmd === 'codesign') return { code: 1, stderr: 'code object is not signed at all' };
        if (cmd !== 'hdiutil') return { code: 0, stderr: '' };
        if (args[0] === 'attach') {
          if (opts.attachCode) return { code: opts.attachCode, stderr: 'no mountable file systems' };
          const mount = args[args.indexOf('-mountpoint') + 1];
          if (opts.bundle !== undefined && opts.bundle === '') {
            mkdirSync(join(mount, 'README'), { recursive: true });
          } else {
            const app = join(mount, opts.bundle ?? APP_NAME, 'Contents', 'MacOS');
            mkdirSync(app, { recursive: true });
            writeFileSync(join(app, 'Wigolo Studio'), 'launcher');
          }
        }
        return { code: 0, stderr: '' };
      },
    };
  }

  it('opens the image, copies the bundle out, and unmounts', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);
    const root = tempRoot();
    const installRoot = join(root, 'Applications');
    const hdi = fakeHdiutil();

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      run: hdi.run,
      launch: async () => true,
    });

    expect(result.outcome).toBe('installed');
    expect(result.installedPath).toBe(join(installRoot, APP_NAME));
    expect(existsSync(join(installRoot, APP_NAME, 'Contents', 'MacOS', 'Wigolo Studio'))).toBe(true);
    expect(hdi.calls.filter((c) => c[0] === 'hdiutil').map((c) => c[1])).toEqual(['attach', 'detach']);
  });

  it('unmounts even when the image holds no application bundle', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);
    const root = tempRoot();
    const hdi = fakeHdiutil({ bundle: '' });

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      run: hdi.run,
    });

    expect(result.outcome).toBe('install_failed');
    // A mounted volume left behind by a failed install is debris the user has to clear by hand.
    expect(hdi.calls.filter((c) => c[0] === 'hdiutil').map((c) => c[1])).toEqual(['attach', 'detach']);
  });

  it('reports a refused attach as a typed install failure with the host copy to fall back on', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);
    const root = tempRoot();
    const hdi = fakeHdiutil({ attachCode: 1 });

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      run: hdi.run,
    });

    expect(result.outcome).toBe('install_failed');
    expect(result.error).toContain('no mountable file systems');
    expect(result.manualFallback).toContain(host.origin);
    expect(hdi.calls.filter((c) => c[0] === 'hdiutil').map((c) => c[1])).toEqual(['attach']);
  });
});

/**
 * The two security properties of the install, both stated as behaviour rather than as code shape.
 *
 * WHY THIS BLOCK EXISTS: `setup` is the one verb that fetches an executable and starts it. Two
 * things carry that: the transport, which is the ONLY thing that says who wrote the bytes (the
 * manifest's digest is published by the same host it claims to vouch for, so it proves transfer
 * and never authorship), and the quarantine flag, which is what makes this system evaluate the
 * bundle at first launch. Neither is visible in a passing install, so each is pinned by an
 * outside signal: a server that records whether it was reached at all, and the real attribute on
 * a real directory.
 */
describe('setupCompanion — transport and first-launch security', () => {
  const hosts: http.Server[] = [];
  afterEach(async () => {
    while (hosts.length > 0) {
      const s = hosts.pop();
      if (s) await closeServer(s);
    }
  });

  it('refuses a cleartext release host BEFORE it opens a socket', async () => {
    const root = tempRoot();
    const asked: string[] = [];
    const result = await setupCompanion({
      releaseHost: 'http://releases.example.com',
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      // Not a stub that answers — a stub that records. The claim is "nothing was requested",
      // and only a call count can carry it.
      fetchImpl: (async (url: string | URL | Request) => {
        asked.push(String(url));
        throw new Error('the transport check let a cleartext request through');
      }) as unknown as typeof globalThis.fetch,
    });

    expect(result.outcome).toBe('insecure_transport');
    expect(asked).toEqual([]);
    // The opt-out above is set and still does not help: it unlocks this machine, not the network.
    expect(result.detail).toContain('http://releases.example.com');
    expect(result.manualFallback).toBeTruthy();
  });

  it('refuses a cleartext loopback host until the opt-out is set, and the server sees nothing', async () => {
    const root = tempRoot();
    let hit = false;
    const server = await startServer((_req, res) => {
      hit = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    hosts.push(server);

    const result = await setupCompanion({
      releaseHost: `http://127.0.0.1:${getPort(server)}`,
      env: {},
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
    });

    expect(result.outcome).toBe('insecure_transport');
    expect(hit).toBe(false);
  });

  it('refuses a cleartext artifact address even when the manifest itself was allowed', async () => {
    const payload = artifactBytes();
    const root = tempRoot();
    const requested: string[] = [];
    const server = await startServer((req, res) => {
      requested.push(req.url ?? '');
      if (req.url === COMPANION_MANIFEST_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            version: '1.4.0',
            // A manifest is data from the network. An allowed host handing out a cleartext
            // artifact address is the same attack one hop further along.
            artifacts: { 'darwin-arm64': { url: 'http://cdn.example.com/companion.dmg', sha256: sha256(payload) } },
          } satisfies CompanionRelease),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    hosts.push(server);
    const installer = recordingInstaller(join(root, 'Applications'));

    const result = await setupCompanion({
      releaseHost: `http://127.0.0.1:${getPort(server)}`,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      install: installer.install,
    });

    expect(result.outcome).toBe('insecure_transport');
    expect(result.detail).toContain('http://cdn.example.com/companion.dmg');
    expect(requested).toEqual([COMPANION_MANIFEST_PATH]);
    expect(installer.calls).toEqual([]);
  });

  it('assesses a SIGNED bundle, and installs it when this system accepts it', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);
    const root = tempRoot();
    const installRoot = join(root, 'Applications');
    const shell = recordingRun({ signed: true });

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: recordingInstaller(installRoot).install,
      run: shell.run,
      launch: async () => true,
    });

    expect(result.outcome).toBe('installed');
    expect(shell.calls.map((c) => c[0])).toEqual(['xattr', 'codesign', 'spctl']);
    expect(shell.calls[2]).toEqual(['spctl', '--assess', '--type', 'execute', join(installRoot, APP_NAME)]);
  });

  it('removes a signed bundle this system refuses, and records nothing', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);
    const root = tempRoot();
    const installRoot = join(root, 'Applications');
    const dataDir = join(root, 'data');
    const launched: string[] = [];

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: recordingInstaller(installRoot).install,
      run: recordingRun({ signed: true, assessCode: 3 }).run,
      launch: async (p: string) => {
        launched.push(p);
        return true;
      },
    });

    expect(result.outcome).toBe('gatekeeper_rejected');
    // Leaving a refused bundle in /Applications and only printing a warning would be the finding
    // this issue exists for, one step later: an unassessed application on the machine.
    expect(existsSync(join(installRoot, APP_NAME))).toBe(false);
    expect(launched).toEqual([]);
    expect(existsSync(join(dataDir, 'studio', 'companion-install.json'))).toBe(false);
    expect(result.manualFallback).toMatch(/manually/i);
  });

  it('removes the bundle and refuses to launch when the quarantine flag cannot be written', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);
    const root = tempRoot();
    const installRoot = join(root, 'Applications');
    const dataDir = join(root, 'data');
    const shell = recordingRun({ xattrCode: 1 });
    const launched: string[] = [];

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: recordingInstaller(installRoot).install,
      run: shell.run,
      launch: async (p: string) => {
        launched.push(p);
        return true;
      },
    });

    expect(result.outcome).toBe('quarantine_failed');
    expect(result.error).toContain('Operation not permitted');
    // An unmarked bundle is one this system will never evaluate, so it must not survive, must not
    // be recorded as the current install, and must certainly not be started.
    expect(existsSync(join(installRoot, APP_NAME))).toBe(false);
    expect(existsSync(join(dataDir, 'studio', 'companion-install.json'))).toBe(false);
    expect(launched).toEqual([]);
    // Nothing is assessed once the flag failed: the decision is already made.
    expect(shell.calls.map((c) => c[0])).toEqual(['xattr']);
  });

  it.skipIf(process.platform !== 'darwin')(
    'leaves the real quarantine attribute on the installed bundle, through the real shell-out',
    async () => {
      const payload = artifactBytes();
      const host = await startHost(payload, sha256(payload));
      hosts.push(host.server);
      const root = tempRoot();
      const installRoot = join(root, 'Applications');
      mkdirSync(installRoot, { recursive: true });

      // No `run` injection: this arm is the outside signal. Everything above asserts on a
      // recorded argv, which is green even if the argv is one this system rejects.
      const result = await setupCompanion({
        releaseHost: host.origin,
        env: ALLOW_HTTP,
        dataDir: join(root, 'data'),
        platform: 'darwin',
        arch: 'arm64',
        installRoot,
        install: recordingInstaller(installRoot).install,
        noLaunch: true,
      });

      expect(result.outcome).toBe('installed');
      const attr = execFileSync('xattr', ['-p', 'com.apple.quarantine', join(installRoot, APP_NAME)], {
        encoding: 'utf8',
      }).trim();
      expect(attr).toMatch(/^0081;[0-9a-f]+;wigolo;$/);
    },
  );
});

describe('runStudioSetup', () => {
  const hosts: http.Server[] = [];
  afterEach(async () => {
    while (hosts.length > 0) {
      const s = hosts.pop();
      if (s) await closeServer(s);
    }
  });

  it('prints the installed path and exits 0 on success', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);
    const root = tempRoot();
    const installRoot = join(root, 'Applications');
    mkdirSync(installRoot, { recursive: true });
    const out = collector();
    const err = collector();

    const code = await runStudioSetup(['setup'], {
      stdout: out.stream,
      stderr: err.stream,
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: recordingInstaller(installRoot).install,
      run: recordingRun().run,
      launch: async () => true,
    });

    expect(code).toBe(0);
    expect(out.text()).toContain(APP_NAME);
    expect(err.text()).toBe('');
  });

  it('exits non-zero and prints the manual fallback when verification fails', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(Buffer.from('wrong')));
    hosts.push(host.server);
    const root = tempRoot();
    const installRoot = join(root, 'Applications');
    mkdirSync(installRoot, { recursive: true });
    const out = collector();
    const err = collector();

    const code = await runStudioSetup(['setup'], {
      stdout: out.stream,
      stderr: err.stream,
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: recordingInstaller(installRoot).install,
    });

    expect(code).toBe(1);
    // The fallback is the only thing a user can act on when the automated path fails, so it
    // belongs on stderr with the failure, not in a help screen they would have to go find.
    expect(err.text()).toMatch(/manually/i);
    expect(err.text()).toContain(host.origin);
  });

  it('prints usage for --help and exits 0', async () => {
    const out = collector();
    const code = await runStudioSetup(['--help'], { stdout: out.stream, stderr: collector().stream });
    expect(code).toBe(0);
    expect(out.text()).toContain('Usage: wigolo studio setup');
  });
});

/**
 * Carried forward from the C4 stub's own file. Every arm goes through `parseCommand`, never a
 * hand-built argv: the first cut of these passed `['studio', 'setup']` and was green while the real
 * CLI answered its own usage block and exited 1, because the parser strips the verb before the
 * handler sees it. A test that invents the argv shape cannot catch that.
 */
describe('wigolo studio setup — route and usage', () => {
  const SRC = resolve(fileURLToPath(new URL('../../../src', import.meta.url)));

  it('refuses an unknown subcommand with a non-zero code and the usage block', async () => {
    const out = collector();
    const err = collector();
    const code = await runStudioSetup(parseCommand(['studio', 'observe']).args, {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('Unknown subcommand');
    expect(err.text()).toContain('observe');
    expect(err.text()).toContain('Usage: wigolo studio setup');
  });

  it('names no session or flow verb — those went with the companion', async () => {
    const out = collector();
    const err = collector();
    // No subcommand: usage, and a non-zero code because nothing was asked for.
    expect(await runStudioSetup(parseCommand(['studio']).args, { stdout: out.stream, stderr: err.stream })).toBe(1);
    const usage = out.text() + err.text();
    for (const gone of ['studio_', 'wigolo flow', 'observe', 'marks']) {
      expect(usage, `usage still advertises '${gone}'`).not.toContain(gone);
    }
  });

  it('leaves `flow` an unknown command rather than a verb that exits 0 in silence', () => {
    // It was in the parser's known set with no case left in the switch, so it fell through the
    // whole routing table and the process exited 0 having done and said nothing.
    expect(parseCommand(['flow', 'list']).command).toBe('unknown');
  });

  it('is the verb `studio` routes to — and `flow` routes nowhere at all', () => {
    // mutation: drop the `case 'studio'` block from index.ts → the first two assertions red.
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(index).toContain("case 'studio':");
    expect(index).toContain('runStudioSetup(args)');
    expect(index).not.toContain("case 'flow':");
    // The MCP `setup` verb is a DIFFERENT route and must survive untouched beside this one.
    expect(index).toContain("case 'setup':");
  });

  it('parses `studio setup` into the verb tail the handler expects', () => {
    const parsed = parseCommand(['studio', 'setup']);
    expect(parsed.command).toBe('studio');
    expect(parsed.args).toEqual(['setup']);
  });
});

/**
 * Every path under `root`, relative and sorted, entries stat'd WITHOUT following links.
 *
 * ⚠ THE CLAIM IS "NOTHING WAS WRITTEN", AND ONLY A DIFF CAN CARRY IT. A refusal outcome proves the
 * function returned early; it says nothing about what the function did before it returned, and the
 * bug this file guards is precisely a write that happens on the way to an answer. So the arms
 * below compare the whole sandbox before and after — a stray file lands in the diff whether or not
 * anything reported it, and an arm that only asserted `outcome === 'artifact_path_refused'` would
 * stay green against a build that refused loudly and traversed anyway.
 *
 * `lstat` rather than `stat` so a link is recorded as a link: the containment arm plants one, and
 * following it would make the plant and its target indistinguishable in the snapshot.
 */
function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        out.push(`link ${rel}`);
        continue;
      }
      if (entry.isDirectory()) {
        out.push(`dir  ${rel}`);
        walk(join(dir, entry.name), rel);
        continue;
      }
      out.push(`file ${rel}`);
    }
  };
  walk(root, '');
  return out;
}

/**
 * A release host under the fixture's control: it chooses the manifest's `version` and the artifact
 * URL's spelling, which is exactly the pair a compromised release host owns in the real attack.
 *
 * The artifact route answers on ANY path it has not already handled, so an arm that bends the
 * URL's extension still gets bytes served if the install ever asks for them. That matters: "the
 * artifact was never requested" has to be a fact about a server that WOULD have answered, not
 * about a 404.
 */
async function startChosenPathHost(opts: {
  version?: string;
  artifactPath?: string;
  payload?: Buffer;
}): Promise<{ server: http.Server; origin: string; requested: string[] }> {
  const payload = opts.payload ?? artifactBytes();
  const version = opts.version ?? '1.4.0';
  const artifactPath = opts.artifactPath ?? '/companion/wigolo-studio.dmg';
  const requested: string[] = [];
  let origin = '';

  const server = await startServer((req, res) => {
    requested.push(req.url ?? '');
    if (req.url === COMPANION_MANIFEST_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          version,
          artifacts: {
            'darwin-arm64': { url: `${origin}${artifactPath}`, sha256: sha256(payload), size: payload.length },
          },
        } satisfies CompanionRelease),
      );
      return;
    }
    res.writeHead(200, { 'content-length': String(payload.length) });
    res.end(payload);
  });

  origin = `http://127.0.0.1:${getPort(server)}`;
  return { server, origin, requested };
}

describe('setupCompanion — the release manifest does not choose a local path', () => {
  const hosts: http.Server[] = [];
  afterEach(async () => {
    while (hosts.length > 0) {
      const s = hosts.pop();
      if (s) await closeServer(s);
    }
  });

  /**
   * `<sandbox>/data/studio/downloads` is three levels under the sandbox root, so a version
   * carrying four `..` segments lands the artifact at the sandbox root — OUTSIDE the download
   * directory and INSIDE the tree the snapshot covers. That placement is the point: an escape has
   * to be somewhere the diff can see it, or the arm proves nothing when the guard is removed.
   * (The first `..` is spent leaving the literal `wigolo-studio-..` segment the name template
   * builds; `..` only traverses when it is a whole segment.)
   */
  const ESCAPING_VERSION = '../../../../hijacked';

  it('refuses a version that walks out of the download folder, and creates nothing at all', async () => {
    const root = tempRoot();
    const host = await startChosenPathHost({ version: ESCAPING_VERSION });
    hosts.push(host.server);
    const installer = recordingInstaller(join(root, 'Applications'));
    const before = snapshotTree(root);

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      install: installer.install,
      run: recordingRun().run,
      launch: async () => true,
    });

    expect(result.outcome).toBe('artifact_path_refused');
    // DELIBERATELY SILENT ABOUT WHICH LAYER ANSWERED. Both cover this fixture — the name check
    // sees the separators, containment sees the escape — so pinning either message here would
    // make this arm go red when the OTHER layer was removed, and a red that moves with an
    // unrelated edit stops being evidence about anything. Each layer is pinned once, alone, in
    // the two arms below; this one carries the property the issue is actually about.
    // The refusal lands BEFORE the socket for the bytes — the manifest is the only thing fetched.
    expect(host.requested).toEqual([COMPANION_MANIFEST_PATH]);
    expect(installer.calls).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
    // Named explicitly as well as by diff, because this is the file the real attack is trying for.
    expect(existsSync(join(root, 'hijacked-darwin-arm64.dmg'))).toBe(false);
    expect(existsSync(join(root, 'hijacked-darwin-arm64.dmg.part'))).toBe(false);
  });

  it('refuses an artifact format the URL spells with a separator in it', async () => {
    const root = tempRoot();
    // `%2F` SURVIVES `new URL().pathname` VERBATIM — the parser normalises `..` segments and
    // decodes nothing, so this is the spelling a hostile host reaches for once literal `..` in a
    // URL path stops working. `extname()` hands the encoded separator straight into the filename.
    const host = await startChosenPathHost({ artifactPath: '/companion/app.%2F..%2F..%2F..%2F..%2Fhijacked' });
    hosts.push(host.server);
    const installer = recordingInstaller(join(root, 'Applications'));
    const before = snapshotTree(root);

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      install: installer.install,
      run: recordingRun().run,
      launch: async () => true,
    });

    expect(result.outcome).toBe('artifact_path_refused');
    expect(result.detail).toContain('format this install does not write');
    expect(host.requested).toEqual([COMPANION_MANIFEST_PATH]);
    expect(installer.calls).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
  });

  /**
   * THE GAP THE NAME CHECK COVERS ALONE.
   *
   * `1.4.0/nested` never leaves the download directory — containment has no complaint about it and
   * would wave it through — so this arm goes red if and only if the version allowlist is removed.
   * A version carrying four `..` would go red for either guard and so could not tell them apart.
   */
  it('refuses a version that nests INSIDE the download folder, which containment would allow', async () => {
    const root = tempRoot();
    const host = await startChosenPathHost({ version: '1.4.0/nested' });
    hosts.push(host.server);
    const installer = recordingInstaller(join(root, 'Applications'));
    const before = snapshotTree(root);

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      install: installer.install,
      run: recordingRun().run,
      launch: async () => true,
    });

    expect(result.outcome).toBe('artifact_path_refused');
    expect(result.detail).toContain('cannot be part of a filename');
    expect(host.requested).toEqual([COMPANION_MANIFEST_PATH]);
    expect(snapshotTree(root)).toEqual(before);
  });

  /**
   * THE GAP CONTAINMENT COVERS ALONE.
   *
   * The version is `1.4.0` and the URL ends `.dmg`: every string the manifest supplied is spelt
   * correctly, so the allowlist sees nothing wrong and this arm goes red if and only if the
   * containment assert is removed. What is wrong is on the DISK — the part file's name is already
   * taken by a link pointing out of the download directory, and `createWriteStream` follows it.
   */
  it('refuses when the part file is already a link out of the download folder', async () => {
    const root = tempRoot();
    const host = await startChosenPathHost({});
    hosts.push(host.server);
    const downloadDir = join(root, 'data', 'studio', 'downloads');
    mkdirSync(downloadDir, { recursive: true });
    const stolen = join(root, 'stolen.dmg');
    symlinkSync(stolen, join(downloadDir, 'wigolo-studio-1.4.0-darwin-arm64.dmg.part'));
    const installer = recordingInstaller(join(root, 'Applications'));
    const before = snapshotTree(root);

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      install: installer.install,
      run: recordingRun().run,
      launch: async () => true,
    });

    expect(result.outcome).toBe('artifact_path_refused');
    // The refusal names the link, not "outside the download folder": the PATH is inside it, and
    // copy that pointed at the containing folder would send the reader to the wrong half.
    expect(result.detail).toContain('already a link pointing somewhere else');
    expect(host.requested).toEqual([COMPANION_MANIFEST_PATH]);
    expect(installer.calls).toEqual([]);
    expect(existsSync(stolen)).toBe(false);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('still installs when the manifest names an ordinary version and format', async () => {
    const payload = artifactBytes();
    const root = tempRoot();
    const host = await startChosenPathHost({ payload });
    hosts.push(host.server);
    const installer = recordingInstaller(join(root, 'Applications'));

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      install: installer.install,
      run: recordingRun().run,
      launch: async () => true,
    });

    // The guards are two refusals standing beside the happy path, not in it. Without this arm a
    // version allowlist one character too strict would look exactly like a working control.
    expect(result.outcome).toBe('installed');
    expect(installer.calls).toHaveLength(1);
    expect(installer.calls[0]).toContain('wigolo-studio-1.4.0-darwin-arm64.dmg');
  });
});

/**
 * A host that answers `hops` redirects before serving, and can be told to point one of them
 * somewhere the transport policy refuses.
 */
async function startRedirectingHost(opts: {
  manifestRedirectTo?: string;
  artifactRedirectTo?: string;
  hops?: number;
  payload?: Buffer;
}): Promise<{ server: http.Server; origin: string; requested: string[] }> {
  const payload = opts.payload ?? artifactBytes();
  const hops = opts.hops ?? 0;
  const requested: string[] = [];
  let origin = '';

  const server = await startServer((req, res) => {
    const url = req.url ?? '';
    requested.push(url);

    if (url === COMPANION_MANIFEST_PATH) {
      if (opts.manifestRedirectTo) {
        res.writeHead(302, { location: opts.manifestRedirectTo });
        res.end();
        return;
      }
      if (hops > 0) {
        res.writeHead(302, { location: `${origin}/mirror/1${COMPANION_MANIFEST_PATH}` });
        res.end();
        return;
      }
    }

    const mirrored = url.match(/^\/mirror\/(\d+)(\/.*)$/);
    if (mirrored) {
      const n = Number(mirrored[1]);
      const rest = mirrored[2] as string;
      if (n < hops) {
        res.writeHead(302, { location: `${origin}/mirror/${n + 1}${rest}` });
        res.end();
        return;
      }
      if (rest === COMPANION_MANIFEST_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            version: '1.4.0',
            artifacts: {
              'darwin-arm64': { url: `${origin}/companion/app.dmg`, sha256: sha256(payload), size: payload.length },
            },
          } satisfies CompanionRelease),
        );
        return;
      }
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
      return;
    }

    if (url === COMPANION_MANIFEST_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          version: '1.4.0',
          artifacts: {
            'darwin-arm64': { url: `${origin}/companion/app.dmg`, sha256: sha256(payload), size: payload.length },
          },
        } satisfies CompanionRelease),
      );
      return;
    }

    if (url === '/companion/app.dmg') {
      if (opts.artifactRedirectTo) {
        res.writeHead(302, { location: opts.artifactRedirectTo });
        res.end();
        return;
      }
      if (hops > 0) {
        res.writeHead(302, { location: `${origin}/mirror/1/companion/app.dmg` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  origin = `http://127.0.0.1:${getPort(server)}`;
  return { server, origin, requested };
}

/**
 * The address a policy-passing host redirects TO in the hostile arms.
 *
 * ⚠ THIS IS THE STAND-IN FOR `https → http`, AND IT IS THE SAME RULE. `companionTransportRefusal`
 * has two arms: cleartext to a REMOTE host is refused outright, and cleartext to this machine is
 * refused unless the fixture opt-out is set. The fixtures here are loopback http — there is no
 * certificate authority in a unit test to make them https — so the pair that can be exercised is
 * "an address the policy allowed" redirecting to "an address the policy refuses under any
 * environment". A downgrade to remote cleartext is that, and it is refused for the same reason and
 * by the same call the https→http downgrade would be.
 *
 * Nothing dials it: the refusal lands before the socket, which the request log then proves.
 */
const REFUSED_HOP = 'http://cdn.example.com/companion.dmg';

describe('setupCompanion — a redirect is a second address, and gets judged like one', () => {
  const hosts: http.Server[] = [];
  afterEach(async () => {
    while (hosts.length > 0) {
      const s = hosts.pop();
      if (s) await closeServer(s);
    }
  });

  it('refuses a manifest hop the transport policy would not have allowed as an address', async () => {
    const root = tempRoot();
    const host = await startRedirectingHost({ manifestRedirectTo: REFUSED_HOP });
    hosts.push(host.server);
    const installer = recordingInstaller(join(root, 'Applications'));

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      install: installer.install,
    });

    // Typed as the transport refusal it is, NOT as an unreadable manifest: the manifest was never
    // read, and "the host is broken" would send the user looking in the wrong place entirely.
    expect(result.outcome).toBe('insecure_transport');
    expect(result.detail).toContain(REFUSED_HOP);
    expect(host.requested).toEqual([COMPANION_MANIFEST_PATH]);
    expect(installer.calls).toEqual([]);
  });

  it('refuses a download hop the transport policy would not have allowed as an address', async () => {
    const root = tempRoot();
    const host = await startRedirectingHost({ artifactRedirectTo: REFUSED_HOP });
    hosts.push(host.server);
    const installer = recordingInstaller(join(root, 'Applications'));

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      install: installer.install,
      run: recordingRun().run,
      launch: async () => true,
    });

    // The address in the manifest passed the pre-check. The bytes still never left this machine's
    // encrypted-or-loopback set, because the ANSWER's address was checked too.
    expect(result.outcome).toBe('insecure_transport');
    expect(result.detail).toContain(REFUSED_HOP);
    expect(installer.calls).toEqual([]);
    expect(existsSync(join(root, 'data', 'studio', 'downloads', 'wigolo-studio-1.4.0-darwin-arm64.dmg'))).toBe(false);
  });

  /**
   * THE ARM THAT CATCHES THE OVERCORRECTION.
   *
   * `redirect: 'error'` would pass both hostile arms above while declining every real download —
   * release CDNs 302 on the happy path, so a blanket refusal is a regression that only shows up
   * after merge, in the one code path no hostile fixture exercises. Both hops redirect here.
   */
  it('follows a redirect chain the policy allows, on both hops, and installs', async () => {
    const payload = artifactBytes();
    const root = tempRoot();
    const host = await startRedirectingHost({ hops: 2, payload });
    hosts.push(host.server);
    const installer = recordingInstaller(join(root, 'Applications'));

    const result = await setupCompanion({
      releaseHost: host.origin,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      install: installer.install,
      run: recordingRun().run,
      launch: async () => true,
    });

    expect(result.outcome).toBe('installed');
    expect(result.version).toBe('1.4.0');
    expect(installer.calls).toHaveLength(1);
    // Every hop was actually taken rather than the final address being guessed at.
    expect(host.requested).toContain(`/mirror/2${COMPANION_MANIFEST_PATH}`);
    expect(host.requested).toContain('/mirror/2/companion/app.dmg');
  });

  it('gives up on a redirect loop instead of following it forever', async () => {
    const root = tempRoot();
    const server = await startServer((req, res) => {
      res.writeHead(302, { location: req.url ?? '/' });
      res.end();
    });
    hosts.push(server);

    const result = await setupCompanion({
      releaseHost: `http://127.0.0.1:${getPort(server)}`,
      env: ALLOW_HTTP,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
    });

    expect(result.outcome).toBe('manifest_unreadable');
    expect(result.error).toContain('redirected more than');
  });
});
