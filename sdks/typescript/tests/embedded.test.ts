import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createLocalClient, type LocalClient } from '../src/local.js';
import {
  distServeCommand,
  freePort,
  makeSeededDataDir,
  spawnServe,
  type SpawnedServe,
} from './serve-harness.js';
import { scrubWigoloEnv } from './helpers.js';

/**
 * Embedded-mode end-to-end. The dist serve is spawned via a WIGOLO_CLI argv
 * override (real binary, warmed data dir). Covers cold spawn (owned), warm
 * reuse (not owned), and close during an in-flight request (SIGKILL escalation).
 */

const dataDir = makeSeededDataDir();

const locals: LocalClient[] = [];
const serves: SpawnedServe[] = [];
const httpServers: Server[] = [];

beforeEach(() => {
  scrubWigoloEnv();
  process.env.WIGOLO_DATA_DIR = dataDir;
  process.env.WIGOLO_CLI = JSON.stringify(distServeCommand());
});

afterEach(async () => {
  for (const l of locals.splice(0)) await l.close().catch(() => {});
  for (const s of serves.splice(0)) await s.stop().catch(() => {});
  for (const h of httpServers.splice(0)) await new Promise<void>((r) => h.close(() => r()));
});

describe('cold start', () => {
  it('spawns a daemon (owned=true) and close() stops it within the bound', async () => {
    const port = await freePort();
    const local = await createLocalClient({ port });
    locals.push(local);
    expect(local.owned).toBe(true);

    const health = await local.client.health();
    expect(health.status).toBeTypeOf('string');

    const start = Date.now();
    await local.close();
    expect(Date.now() - start).toBeLessThan(6500);

    // The daemon is gone.
    await new Promise((r) => setTimeout(r, 300));
    await expect(
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toBeTruthy();
    locals.splice(0); // already closed
  }, 90_000);
});

describe('warm reuse', () => {
  it('reuses a pre-started daemon (owned=false) and leaves it running on close', async () => {
    const port = await freePort();
    const serve = await spawnServe({ port, dataDir });
    serves.push(serve);

    const local = await createLocalClient({ port });
    expect(local.owned).toBe(false);
    await local.close(); // no-op for a non-owned daemon

    // Still healthy after close.
    const res = await fetch(`${serve.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(200);
  }, 90_000);
});

describe('close during an in-flight request', () => {
  it('terminates a slow in-flight fetch within ~6s (SIGKILL escalation)', async () => {
    // A loopback target that never responds keeps a fetch() in-flight so the
    // daemon holds an open connection at close() time. Loopback is allowed on a
    // loopback bind.
    const slow = createServer(() => {
      /* accept the socket, never respond */
    });
    httpServers.push(slow);
    const slowPort = await freePort();
    await new Promise<void>((r) => slow.listen(slowPort, '127.0.0.1', () => r()));

    const port = await freePort();
    const local = await createLocalClient({ port });
    locals.push(local);
    expect(local.owned).toBe(true);

    // Fire a slow fetch; don't await it — it will be cut off by shutdown.
    const inflight = local.client
      .fetch({ url: `http://127.0.0.1:${slowPort}/`, render_js: false }, { timeoutMs: 300_000 })
      .catch(() => 'aborted');

    // Give the request time to reach the daemon and open the upstream socket.
    await new Promise((r) => setTimeout(r, 1500));

    const start = Date.now();
    await local.close();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(6500);

    // The daemon process is gone despite the open connection.
    await new Promise((r) => setTimeout(r, 300));
    await expect(
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toBeTruthy();
    await inflight;
    locals.splice(0);
  }, 90_000);
});
