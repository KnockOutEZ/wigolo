import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
    const launched: string[] = [];

    const result = await setupCompanion({
      releaseHost: host.origin,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: installer.install,
      launch: async (p: string) => {
        launched.push(p);
        return true;
      },
    });

    expect(result.outcome).toBe('installed');
    expect(result.version).toBe('1.4.0');
    expect(installer.calls).toHaveLength(1);
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
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: installer.install,
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
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: installer.install,
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
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: installer.install,
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
    expect(hdi.calls.map((c) => c[1])).toEqual(['attach', 'detach']);
  });

  it('unmounts even when the image holds no application bundle', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);
    const root = tempRoot();
    const hdi = fakeHdiutil({ bundle: '' });

    const result = await setupCompanion({
      releaseHost: host.origin,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      run: hdi.run,
    });

    expect(result.outcome).toBe('install_failed');
    // A mounted volume left behind by a failed install is debris the user has to clear by hand.
    expect(hdi.calls.map((c) => c[1])).toEqual(['attach', 'detach']);
  });

  it('reports a refused attach as a typed install failure with the host copy to fall back on', async () => {
    const payload = artifactBytes();
    const host = await startHost(payload, sha256(payload));
    hosts.push(host.server);
    const root = tempRoot();
    const hdi = fakeHdiutil({ attachCode: 1 });

    const result = await setupCompanion({
      releaseHost: host.origin,
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot: join(root, 'Applications'),
      run: hdi.run,
    });

    expect(result.outcome).toBe('install_failed');
    expect(result.error).toContain('no mountable file systems');
    expect(result.manualFallback).toContain(host.origin);
    expect(hdi.calls.map((c) => c[1])).toEqual(['attach']);
  });
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
      dataDir: join(root, 'data'),
      platform: 'darwin',
      arch: 'arm64',
      installRoot,
      install: recordingInstaller(installRoot).install,
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
