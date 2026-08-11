import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createBrokerClient } from '../../src/main/broker-client';

/**
 * P3 T1 — the broker CLIENT (Electron-main side). A fake child (no real process) exercises the wire
 * client: id-routing, ready-gating, artifact notifications, and the §11 resilience contract — fail-fast
 * on exit, never-hang on a silent broker, respawn with backoff. The real cross-process seam is covered
 * in the core broker-transport test.
 */
interface FakeChild {
  stdout: EventEmitter & { setEncoding(): void };
  stdin: { write(s: string): boolean };
  exitCode: number | null;
  kill(): void;
  on(ev: string, cb: (...a: unknown[]) => void): void;
  emit(ev: string, ...a: unknown[]): boolean;
  writes: string[];
  line(obj: unknown): void;
}

function makeFakeChild(): FakeChild {
  const stdout = Object.assign(new EventEmitter(), { setEncoding() { /* noop */ } });
  const bus = new EventEmitter();
  const writes: string[] = [];
  const child = {
    stdout,
    stdin: { write: (s: string) => { writes.push(s); return true; } },
    exitCode: null as number | null,
    on: (ev: string, cb: (...a: unknown[]) => void) => { bus.on(ev, cb); },
    emit: (ev: string, ...a: unknown[]) => bus.emit(ev, ...a),
    writes,
    kill() { child.exitCode = 0; bus.emit('exit', 0); },
    line: (obj: unknown) => { stdout.emit('data', JSON.stringify(obj) + '\n'); },
  };
  return child;
}

function newClient(opts: { children: FakeChild[]; callTimeoutMs?: number; bootTimeoutMs?: number; warn?: (l: string) => void }) {
  const spawnFn = () => { const c = makeFakeChild(); opts.children.push(c); return c as unknown as ChildProcess; };
  // nodePath is injected, so the runtime probe is skipped: these tests exercise the wire, not resolution.
  return createBrokerClient({ spawnFn, brokerPath: '/broker.js', nodePath: 'node', warn: opts.warn ?? (() => { /* silence */ }), callTimeoutMs: opts.callTimeoutMs, bootTimeoutMs: opts.bootTimeoutMs });
}

describe('broker-client', () => {
  it('call writes a framed request and resolves on the matching response', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children });
    children[0].line({ notify: 'ready' });
    await client.ready();
    const p = client.call<string>('ping');
    await vi.waitFor(() => expect(children[0].writes.length).toBe(1));
    const req = JSON.parse(children[0].writes[0]) as { id: number; method: string };
    expect(req.method).toBe('ping');
    children[0].line({ id: req.id, ok: true, result: 'pong' });
    expect(await p).toBe('pong');
  });

  it('routes concurrent responses by id', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children });
    children[0].line({ notify: 'ready' });
    await client.ready();
    const a = client.call<string>('m'); const b = client.call<string>('m');
    await vi.waitFor(() => expect(children[0].writes.length).toBe(2));
    const [r1, r2] = children[0].writes.map((w) => JSON.parse(w) as { id: number });
    children[0].line({ id: r2.id, ok: true, result: 'B' }); // respond out of order
    children[0].line({ id: r1.id, ok: true, result: 'A' });
    expect(await a).toBe('A');
    expect(await b).toBe('B');
  });

  it('ready() resolves only after the ready notify', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children });
    let ready = false;
    void client.ready().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    children[0].line({ notify: 'ready' });
    await vi.waitFor(() => expect(ready).toBe(true));
  });

  it('onArtifact fires on an artifact notify', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children });
    const seen: unknown[] = [];
    client.onArtifact((d) => seen.push(d));
    children[0].line({ notify: 'artifact', delta: { id: 1, type: 'clip' } });
    expect(seen).toEqual([{ id: 1, type: 'clip' }]);
  });

  it('fail-fast: a pending call rejects when the child exits', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children });
    children[0].line({ notify: 'ready' });
    await client.ready();
    const p = client.call('slow');
    await vi.waitFor(() => expect(children[0].writes.length).toBe(1));
    children[0].emit('exit', 1);
    await expect(p).rejects.toThrow(/exited/i);
  });

  it('never-hang: a silent broker rejects within callTimeoutMs', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children, callTimeoutMs: 40 });
    children[0].line({ notify: 'ready' });
    await client.ready();
    await expect(client.call('slow')).rejects.toThrow(/timed out/i);
  });

  it('respawns after an unexpected exit (backoff)', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children });
    children[0].line({ notify: 'ready' });
    await client.ready();
    children[0].emit('exit', 1); // unexpected
    await vi.waitFor(() => expect(children.length).toBe(2), { timeout: 1000 });
    await client.stop();
  });

  /**
   * `spawn` reports a missing or unexecutable binary ASYNCHRONOUSLY, as an 'error' event — never as the
   * synchronous throw the spawn try/catch was written for. `EventEmitter` re-throws an 'error' that has
   * no listener, so before this handler existed a bad broker Node took the entire Electron main down
   * instead of degrading captures. A background service must never be able to kill its host.
   */
  it('an async spawn error degrades instead of taking the process down', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children, bootTimeoutMs: 200 });
    const err = Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
    expect(() => children[0].emit('error', err)).not.toThrow();
    await expect(client.ready()).rejects.toThrow(/not ready/i);
    await client.stop();
  });

  it('a pending call rejects when the child errors out', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children });
    children[0].line({ notify: 'ready' });
    await client.ready();
    const p = client.call('slow');
    await vi.waitFor(() => expect(children[0].writes.length).toBe(1));
    children[0].emit('error', new Error('spawn node ENOENT'));
    await expect(p).rejects.toThrow(/failed to start/i);
    await client.stop();
  });

  /** 'exit' may or may not follow 'error'. Respawning for both would double the backoff schedule. */
  it('error then exit respawns once, not twice', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children });
    children[0].line({ notify: 'ready' });
    await client.ready();
    children[0].emit('error', new Error('spawn node ENOENT'));
    children[0].emit('exit', 1);
    await vi.waitFor(() => expect(children.length).toBe(2), { timeout: 1000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(children.length).toBe(2);
    await client.stop();
  });

  it('stop() prevents respawn', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children });
    children[0].line({ notify: 'ready' });
    await client.ready();
    await client.stop();
    children[0].emit('exit', 0);
    await new Promise((r) => setTimeout(r, 350));
    expect(children.length).toBe(1); // no respawn after stop
  });
});
