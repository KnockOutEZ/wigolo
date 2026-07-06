import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P3 T1 — broker TRANSPORT (real spawned process). Proves the JSON-RPC wire end-to-end: a real
 * plain-Node child, a real (temp) DB, newline-delimited framing, the `ready` notify, a request/response
 * round-trip, and the broker→main `artifact` notify. This is the one test that exercises the actual
 * cross-process seam (dispatch logic is covered without a process in broker-dispatch.test.ts).
 *
 * The broker boots the shared subsystems, whose embedding probe runs in the BACKGROUND (non-blocking,
 * fault-tolerant) — so `ready` + a `capture` RPC never wait on a model download; a temp data dir is safe.
 */
const BROKER = fileURLToPath(new URL('../../../dist/daemon/studio-db-broker.js', import.meta.url));

describe('studio-db-broker — transport (spawned process)', () => {
  let child: ChildProcess;
  let dir: string;
  let buf = '';
  const lines: Record<string, unknown>[] = [];
  const waiters: Array<(msg: Record<string, unknown>) => boolean> = [];
  const resolvers: Array<() => void> = [];

  const pump = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const match = lines.find((l) => waiters[i](l));
      if (match) { resolvers[i](); waiters.splice(i, 1); resolvers.splice(i, 1); }
    }
  };
  const waitFor = (pred: (msg: Record<string, unknown>) => boolean, timeoutMs = 30_000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const existing = lines.find(pred);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error('broker message timeout')), timeoutMs);
      waiters.push(pred);
      resolvers.push(() => { clearTimeout(timer); resolve(lines.find(pred)!); });
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-transport-'));
    child = spawn(process.execPath, [BROKER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, WIGOLO_STUDIO_BROKER_MAIN: '1', WIGOLO_DATA_DIR: dir, LOG_LEVEL: 'error' },
    });
    child.unref(); // don't let the child keep the test runner alive if a kill is slow
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => {
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) { try { lines.push(JSON.parse(line)); } catch { /* non-JSON stray */ } }
      }
      pump();
    });
    await waitFor((m) => m.notify === 'ready');
  }, 40_000);

  afterAll(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ } // force — the broker loads onnxruntime; SIGTERM teardown can hang
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('answers a capture RPC over the wire and pushes an artifact notify', async () => {
    child.stdin!.write(JSON.stringify({
      id: 1, method: 'capture',
      params: { input: { type: 'clip', content: 'transport wire content', url: 'https://ex.com/t' }, sessionId: 'sT', currentNavEpoch: 0, lastObserveEpoch: 0, credentialSignal: {} },
    }) + '\n');
    const resp = await waitFor((m) => m.id === 1);
    expect(resp.ok).toBe(true);
    expect((resp.result as { inserted: boolean }).inserted).toBe(true);
    const notify = await waitFor((m) => m.notify === 'artifact');
    expect((notify.delta as { type: string }).type).toBe('clip');
  }, 20_000);

  it('rejects an unknown method with a structured error', async () => {
    child.stdin!.write(JSON.stringify({ id: 2, method: 'nope' }) + '\n');
    const resp = await waitFor((m) => m.id === 2);
    expect(resp.ok).toBe(false);
    expect((resp.error as { message: string }).message).toMatch(/unknown broker method/);
  }, 20_000);
});
