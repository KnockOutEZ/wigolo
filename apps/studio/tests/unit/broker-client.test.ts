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
  stdin: { write(s: string): boolean; end(): void };
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  /** Set by `stdin.end()` — the graceful drain door. Distinguishes it from a bare `kill()`. */
  stdinEnded: boolean;
  killedWith: NodeJS.Signals | undefined;
  kill(signal?: NodeJS.Signals): void;
  on(ev: string, cb: (...a: unknown[]) => void): void;
  once(ev: string, cb: (...a: unknown[]) => void): void;
  emit(ev: string, ...a: unknown[]): boolean;
  writes: string[];
  line(obj: unknown): void;
}

function makeFakeChild(): FakeChild {
  const stdout = Object.assign(new EventEmitter(), { setEncoding() { /* noop */ } });
  const bus = new EventEmitter();
  const writes: string[] = [];
  const child: FakeChild = {
    stdout,
    stdin: {
      write: (s: string) => { writes.push(s); return true; },
      // The real broker turns stdin EOF into an in-process readline `close` and exits 0 — which is
      // what runs its projection drain. Modelled here so a stop that skips this door is visible.
      end: () => { child.stdinEnded = true; child.exitCode = 0; bus.emit('exit', 0, null); },
    },
    exitCode: null,
    signalCode: null,
    stdinEnded: false,
    killedWith: undefined,
    on: (ev: string, cb: (...a: unknown[]) => void) => { bus.on(ev, cb); },
    once: (ev: string, cb: (...a: unknown[]) => void) => { bus.once(ev, cb); },
    emit: (ev: string, ...a: unknown[]) => bus.emit(ev, ...a),
    writes,
    kill(signal?: NodeJS.Signals) { child.killedWith = signal ?? 'SIGTERM'; child.exitCode = 0; bus.emit('exit', 0, child.killedWith); },
    line: (obj: unknown) => { stdout.emit('data', JSON.stringify(obj) + '\n'); },
  };
  return child;
}

function newClient(opts: { children: FakeChild[]; callTimeoutMs?: number; bootTimeoutMs?: number; warn?: (l: string) => void; maxFrameChars?: number }) {
  const spawnFn = () => { const c = makeFakeChild(); opts.children.push(c); return c as unknown as ChildProcess; };
  // nodePath is injected, so the runtime probe is skipped: these tests exercise the wire, not resolution.
  return createBrokerClient({ spawnFn, brokerPath: '/broker.js', nodePath: 'node', warn: opts.warn ?? (() => { /* silence */ }), callTimeoutMs: opts.callTimeoutMs, bootTimeoutMs: opts.bootTimeoutMs, maxFrameChars: opts.maxFrameChars });
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

  /**
   * SD1 exit-9 finding K2. These loops run inside the child's `stdout` data callback, which is the
   * Electron main's event loop and nothing else: there is no caller above them to catch anything, so
   * an unisolated handler throw is an uncaught exception that takes the whole app down — the
   * background service killing its host, the one thing §11 says it must never be able to do. The
   * second half is quieter and just as bad: a notify is a live tail, not a request, so the handlers
   * after the throwing one never get an envelope that will not be sent again.
   *
   * The `not.toThrow()` is the real assertion. Unisolated, the throw escapes `onLine`, then the
   * `stdout.emit('data', …)` inside `line()`, and lands right here.
   */
  it('a throwing run-event handler kills neither the caller nor its siblings', () => {
    const children: FakeChild[] = [];
    const warnings: string[] = [];
    const client = newClient({ children, warn: (l) => { warnings.push(l); } });
    const seen: string[] = [];
    client.onRunEvent(() => { seen.push('view-model'); });
    client.onRunEvent(() => { throw new Error('the fold blew up'); });
    client.onRunEvent((runId) => { seen.push(runId); });

    expect(() => children[0].line({ notify: 'run-event', runId: 'rAB1', envelope: { seq: 1, type: 'run.created' } })).not.toThrow();
    expect(seen, 'the throwing handler starved the one after it of an envelope nothing re-sends').toEqual(['view-model', 'rAB1']);
    expect(warnings.join(''), 'the throw was swallowed silently').toMatch(/run-event listener threw/);
  });

  /** The artifact tail is the same loop with the same consequence, one line above it. */
  it('a throwing artifact handler kills neither the caller nor its siblings', () => {
    const children: FakeChild[] = [];
    const warnings: string[] = [];
    const client = newClient({ children, warn: (l) => { warnings.push(l); } });
    const seen: unknown[] = [];
    client.onArtifact(() => { throw new Error('the capture pane blew up'); });
    client.onArtifact((d) => seen.push(d));

    expect(() => children[0].line({ notify: 'artifact', delta: { id: 1, type: 'clip' } })).not.toThrow();
    expect(seen).toEqual([{ id: 1, type: 'clip' }]);
    expect(warnings.join('')).toMatch(/artifact listener threw/);
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

  /**
   * MED-2's client half. Every read that could produce an unbounded answer is bounded at the source
   * now, and that is where a policy bound belongs — this is the backstop for what a source bound
   * cannot cover: a child that is broken, wedged mid-write, or newer than this host. Without it the
   * partial-line buffer is an unbounded JS string on the thread that paints, and the failure mode is
   * the window dying for memory with no error anyone can act on.
   */
  it('cuts off a frame that would grow without bound, and recovers instead of accumulating it', async () => {
    const children: FakeChild[] = [];
    const warnings: string[] = [];
    const client = newClient({ children, maxFrameChars: 1_000, warn: (l) => { warnings.push(l); } });
    children[0].line({ notify: 'ready' });
    await client.ready();
    const inFlight = client.call('runListLogs');
    await vi.waitFor(() => expect(children[0].writes.length).toBe(1));

    // A frame with no newline in it, growing. Nothing legitimate produces this.
    for (let i = 0; i < 3; i++) children[0].stdout.emit('data', 'x'.repeat(500));

    // The caller is told, rather than left on a promise nobody will settle.
    await expect(inFlight).rejects.toThrow(/oversized frame/);
    expect(warnings.join(''), 'the cut-off was silent').toMatch(/exceeded 1000 characters/);
    // …and the client recovers: a fresh child, and the stale partial line is not carried into it,
    // which would eat the respawn's `ready` and leave the app permanently without a background service.
    await vi.waitFor(() => expect(children.length).toBe(2), { timeout: 1000 });
    children[1].line({ notify: 'ready' });
    await expect(client.ready()).resolves.toBeUndefined();
    await client.stop();
  });

  // The control: an ordinary answer that arrives across several chunks is REASSEMBLED, not cut. The
  // guard is on a frame that never ends, not on a frame that arrives in pieces.
  it('still reassembles a large answer that is split across chunks', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children, maxFrameChars: 1_000 });
    children[0].line({ notify: 'ready' });
    await client.ready();
    const p = client.call<string>('m');
    await vi.waitFor(() => expect(children[0].writes.length).toBe(1));
    const id = (JSON.parse(children[0].writes[0]) as { id: number }).id;

    const frame = JSON.stringify({ id, ok: true, result: 'z'.repeat(800) }) + '\n';
    for (let i = 0; i < frame.length; i += 100) children[0].stdout.emit('data', frame.slice(i, i + 100));

    expect(await p).toBe('z'.repeat(800));
    await client.stop();
  });

  /**
   * The stop has to reach the child's exit hook, because that hook is what drains the queued tail of
   * `events.jsonl` — the copy of the run a person can read without our tooling (law 11). A signal
   * cannot carry that: on Windows `kill('SIGTERM')` is a `TerminateProcess` and no handler runs, so a
   * perfectly ordinary app quit silently truncated the log. Ending stdin is the one door every
   * platform delivers, so that is what a normal stop must use — a kill here is the escalation only.
   */
  it('stop() closes the child stdin rather than signalling it', async () => {
    const children: FakeChild[] = [];
    const client = newClient({ children });
    children[0].line({ notify: 'ready' });
    await client.ready();
    await client.stop();
    expect(children[0].stdinEnded, 'the graceful drain door was never opened').toBe(true);
    expect(children[0].killedWith).toBeUndefined();
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
