/**
 * PX2 RC exit gate — proof that the egress fence is load-bearing.
 *
 * The gate's all-local claim rests on `egress-fence.cjs` actually stopping a
 * connection and actually recording it. If the preload silently failed to load —
 * a typo in `NODE_OPTIONS`, a `--require` the runtime ignored, a patch applied to
 * the wrong prototype — every arm would still be green and the claim would be
 * worth nothing: an unfenced run also records zero blocked connections. So the
 * instrument gets its own test, in both directions.
 *
 * It runs OFFLINE and deterministically. The destination is `192.0.2.1`
 * (TEST-NET-1, RFC 5737), which exists precisely to be unroutable — so the
 * unfenced arm needs no internet either: it fails to connect on its own, which is
 * a different outcome from being refused by the fence, and that difference is
 * exactly what is being asserted.
 *
 * This file is cheap, so unlike the rest of the gate it does NOT need the opt-in:
 * it spawns two short node processes and touches no network, no database and no
 * tarball. Running it in the ordinary suite is what keeps the fence honest
 * between RC runs.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const FENCE = join(import.meta.dirname, 'egress-fence.cjs');

/** TEST-NET-1: reserved for documentation, routable nowhere. */
const UNROUTABLE = '192.0.2.1';

interface ProbeOutcome {
  code: number | null;
  output: string;
  record: string;
}

/**
 * Try one TCP connect in a child process, with the fence on or off.
 *
 * The probe prints a single token for what happened, so the assertion reads the
 * outcome rather than parsing an error shape.
 */
async function probe(options: { fenced: boolean }): Promise<ProbeOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'wigolo-rc-fence-'));
  const recordPath = join(dir, 'egress.log');
  const script = join(dir, 'probe.cjs');

  await writeFile(
    script,
    `const net = require('node:net');
try {
  const socket = net.connect(80, '${UNROUTABLE}');
  socket.on('error', () => { console.log('CONNECT_ERROR'); process.exit(0); });
  socket.on('connect', () => { console.log('CONNECTED'); socket.destroy(); process.exit(0); });
  setTimeout(() => { console.log('CONNECT_PENDING'); process.exit(0); }, 2000);
} catch (error) {
  console.log('THREW:' + String(error && error.message));
}
`,
    'utf8',
  );

  const args = options.fenced ? ['--require', FENCE, script] : [script];
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: { ...process.env, RC_EGRESS_RECORD: recordPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });

  const code = await new Promise<number | null>((resolveExit) => {
    child.once('close', (exit) => resolveExit(exit));
  });

  let record = '';
  try {
    record = await readFile(recordPath, 'utf8');
  } catch {
    record = '';
  }

  return { code, output, record };
}

describe('PX2 RC exit gate — the egress fence itself', () => {
  it('refuses a non-loopback connection and records it', async () => {
    const fenced = await probe({ fenced: true });

    // The fence throws synchronously out of `connect`, so the probe's own
    // try/catch sees it — a socket error would arrive asynchronously instead.
    expect(fenced.output).toContain('THREW:');
    expect(fenced.output).toContain('PX2 RC egress fence');
    // The record is the half a caught throw cannot erase, which is why the arms
    // read it rather than trusting that an engine reported a failure.
    expect(fenced.record).toContain(UNROUTABLE);
  }, 60_000);

  it('does not interfere when it is not loaded — so a green arm means the fence ran', async () => {
    const unfenced = await probe({ fenced: false });

    // Without the preload the connect is attempted for real: it errors or hangs
    // against an unroutable address, but it is never REFUSED, and nothing is
    // recorded. That asymmetry is what makes the fenced arm's evidence mean
    // something.
    expect(unfenced.output).not.toContain('PX2 RC egress fence');
    expect(unfenced.record).toBe('');
  }, 60_000);

  it('lets loopback through, or every arm would be testing the fence instead of wigolo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wigolo-rc-fence-ok-'));
    const script = join(dir, 'loopback.cjs');
    await writeFile(
      script,
      `const net = require('node:net');
const server = net.createServer((socket) => socket.end());
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const socket = net.connect(port, '127.0.0.1');
  socket.on('connect', () => { console.log('LOOPBACK_OK'); socket.destroy(); server.close(); process.exit(0); });
  socket.on('error', (error) => { console.log('LOOPBACK_FAILED:' + error.message); server.close(); process.exit(1); });
});
`,
      'utf8',
    );

    const child = spawn(process.execPath, ['--require', FENCE, script], {
      cwd: dir,
      env: { ...process.env, RC_EGRESS_RECORD: join(dir, 'egress.log') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolveExit) => {
      child.once('close', (exit) => resolveExit(exit));
    });

    expect(output).toContain('LOOPBACK_OK');
    expect(code).toBe(0);
  }, 60_000);
});
