import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * #334 — the six SD2 run-log methods over the REAL spawned-process wire.
 *
 * WHY A SPAWN AND NOT THE HANDLER MAP. `studio-db-broker-run-log.test.ts` proves the handlers
 * answer what the native binding answers, in one process. That cannot prove the thing this file
 * exists for: the transport is newline-delimited JSON-RPC, and it flattens a THROWN error to
 * `{ ok: false, error: { message } }` — a bare string with no `error_reason` on it. A refusal that
 * threw would therefore arrive as a transport failure, and the REST route above it would answer 500
 * where its documented answer is 404, 409 or 400. In-process that difference is invisible, because
 * a rejected promise and a resolved refusal are both just what the function did.
 *
 * It lives in `tests/integration/` because that is the SERIAL lane. A test that spawns a `dist/`
 * path cannot run in the parallel one: `dist/` is absent for the whole of a clean rebuild, and a
 * spawn landing in that window dies with a module-not-found that reads as a broken wire — the race
 * `dist-rebuild-serialization.test.ts` exists to keep shut.
 *
 * So every row below reads the frame, not the value: `ok` is the TRANSPORT's verdict and must stay
 * `true` on a refusal, `error` must be absent, and the `error_reason` has to be inside `result`.
 * The live-tail rows read the `run-event` notify the child pushes, which is the only way a
 * `driver.changed` or `message.queued` row committed in this process reaches the host's surfaces.
 */
const BROKER = fileURLToPath(new URL('../../dist/daemon/studio-db-broker.js', import.meta.url));

interface Frame { id?: number; ok?: boolean; result?: unknown; error?: { message: string }; notify?: string; runId?: string; envelope?: { seq: number; type: string } }

describe('studio-db-broker — SD2 run-log methods over the spawned wire', () => {
  let child: ChildProcess;
  let dir: string;
  let buf = '';
  const frames: Frame[] = [];
  const waiters: Array<(f: Frame) => boolean> = [];
  const resolvers: Array<() => void> = [];
  let nextId = 1;
  let runId = '';

  const pump = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (frames.find((f) => waiters[i](f))) { resolvers[i](); waiters.splice(i, 1); resolvers.splice(i, 1); }
    }
  };
  const waitFor = (pred: (f: Frame) => boolean, timeoutMs = 30_000): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const existing = frames.find(pred);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error('broker message timeout')), timeoutMs);
      waiters.push(pred);
      resolvers.push(() => { clearTimeout(timer); resolve(frames.find(pred)!); });
    });

  /** One request over the wire, answered by its own id. */
  const call = async (method: string, params?: unknown): Promise<Frame> => {
    const id = nextId++;
    child.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
    return waitFor((f) => f.id === id);
  };

  const runEvents = (type: string): Frame[] =>
    frames.filter((f) => f.notify === 'run-event' && f.envelope?.type === type);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-runlog-wire-'));
    child = spawn(process.execPath, [BROKER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, WIGOLO_STUDIO_BROKER_MAIN: '1', WIGOLO_DATA_DIR: dir, LOG_LEVEL: 'error' },
    });
    child.unref();
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => {
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) { try { frames.push(JSON.parse(line) as Frame); } catch { /* non-JSON stray */ } }
      }
      pump();
    });
    await waitFor((f) => f.notify === 'ready');
    const created = await call('runCreate', { input: { task: 'compare two monitors', driver: { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } } } });
    runId = (created.result as { id: string }).id;
  }, 60_000);

  afterAll(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ } // force — the broker loads the local ML runtime; a graceful teardown can hang
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('a BATON REFUSAL crosses as a resolved value carrying error_reason, not as a transport error', async () => {
    const frame = await call('runDriver', { runId, input: { gesture: 'release', by: { kind: 'sdk', client: { name: 'wigolo-sdk', version: '0.4.0' } } } });
    // The transport succeeded. That is the claim: a thrown refusal would invert exactly these two.
    expect(frame.ok).toBe(true);
    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({ ok: false, error_reason: 'not_the_driver' });
    // And it carries the fields a route needs to answer with — the machine code AND the driver line.
    expect((frame.result as { driverName: string }).driverName).toBe('cli (claude-code)');
  }, 20_000);

  it('a run that does not exist is a refusal too, not a 500', async () => {
    const frame = await call('runDriver', { runId: 'zzzzzzz', input: { gesture: 'takeover', by: { kind: 'human' } } });
    expect(frame.ok).toBe(true);
    expect(frame.result).toMatchObject({ ok: false, error_reason: 'run_not_found' });
  }, 20_000);

  it('a MESSAGE REFUSAL crosses as a resolved value carrying error_reason', async () => {
    const blank = await call('runSendMessage', { runId, input: { text: '   ' } });
    expect(blank.ok).toBe(true);
    expect(blank.error).toBeUndefined();
    expect(blank.result).toMatchObject({ ok: false, error_reason: 'invalid_message' });

    const absent = await call('runSendMessage', { runId: 'zzzzzzz', input: { text: 'nobody home' } });
    expect(absent.ok).toBe(true);
    expect(absent.result).toMatchObject({ ok: false, error_reason: 'run_not_found' });
  }, 20_000);

  it('an accepted gesture answers, and pushes its committed envelope back as a run-event notify', async () => {
    const before = runEvents('driver.changed').length;
    const frame = await call('runDriver', { runId, input: { gesture: 'takeover', by: { kind: 'human' }, reason: 'I will finish this' } });
    expect(frame.ok).toBe(true);
    expect(frame.result).toMatchObject({ ok: true });
    const committed = (frame.result as { events: Array<{ seq: number; type: string }> }).events;
    expect(committed.map((e) => e.type)).toEqual(['driver.changed']);

    const notify = await waitFor((f) => f.notify === 'run-event' && f.envelope?.seq === committed[0].seq);
    expect(notify.runId).toBe(runId);
    expect(notify.envelope?.type).toBe('driver.changed');
    expect(runEvents('driver.changed').length).toBe(before + 1);
  }, 20_000);

  it('an accepted message answers, and pushes its message.queued envelope back', async () => {
    const frame = await call('runSendMessage', { runId, input: { text: 'stop at the checkout page', messageId: 'hm_wire' } });
    expect(frame.ok).toBe(true);
    const queued = frame.result as { ok: true; message: { messageId: string; state: string }; event: { seq: number } };
    expect(queued.message).toMatchObject({ messageId: 'hm_wire', state: 'queued' });

    const notify = await waitFor((f) => f.notify === 'run-event' && f.envelope?.seq === queued.event.seq);
    expect(notify.envelope?.type).toBe('message.queued');
  }, 20_000);

  it('the four reads answer over the wire, in the shapes the port members declare', async () => {
    const messages = await call('runMessages', { runId, limit: 50 });
    expect(messages.ok).toBe(true);
    expect((messages.result as Array<{ messageId: string }>).map((m) => m.messageId)).toContain('hm_wire');

    const typed = await call('runTypedEvents', { runId, query: { types: ['run.created'], limit: 10 } });
    expect((typed.result as Array<{ type: string }>).map((e) => e.type)).toEqual(['run.created']);

    const unanswered = await call('runUnansweredEvents', { runId, query: { askType: 'message.queued', answerType: 'message.delivered', correlationKey: 'messageId', limit: 10 } });
    expect((unanswered.result as Array<{ payload: { messageId: string } }>).map((e) => e.payload.messageId)).toEqual(['hm_wire']);

    // The takeover above is an eligible, unconsumed trigger for the client it took the wheel FROM.
    const trigger = await call('runInterruptTrigger', { runId, caller: { name: 'claude-code', version: '2.1.0' } });
    expect(trigger.ok).toBe(true);
    expect(trigger.result).toMatchObject({ type: 'driver.changed' });
  }, 30_000);
});
