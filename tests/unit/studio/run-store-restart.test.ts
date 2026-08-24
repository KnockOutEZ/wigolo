import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, RunEvent } from '../../../src/studio/run-store.js';

/**
 * SD1 acceptance — a run outlives every UI (law 1). This is the only test that proves it against a
 * REAL process boundary: a broker child creates a run and appends events, the process dies, a second
 * process opens the same data dir and reads back the identical run and the identical event sequence.
 *
 * An in-process test cannot make this claim — it would pass with the whole log in a module-level Map.
 */
const BROKER = fileURLToPath(new URL('../../../dist/daemon/studio-db-broker.js', import.meta.url));

interface Broker {
  call<T>(method: string, params?: unknown): Promise<T>;
  notifications: Array<Record<string, unknown>>;
  stop(): void;
  stopGracefully(): Promise<void>;
}

function startBroker(dataDir: string): Promise<Broker> {
  const child: ChildProcess = spawn(process.execPath, [BROKER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, WIGOLO_STUDIO_BROKER_MAIN: '1', WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'error' },
  });
  child.unref();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: Array<Record<string, unknown>> = [];
  let nextId = 1;
  let buf = '';
  let onReady: (() => void) | undefined;
  const ready = new Promise<void>((r) => { onReady = r; });

  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (msg.notify === 'ready') { onReady?.(); continue; }
      if (msg.notify) { notifications.push(msg); continue; }
      const p = pending.get(msg.id as number);
      if (!p) continue;
      pending.delete(msg.id as number);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(String((msg.error as { message?: string })?.message ?? 'broker error')));
    }
  });

  const broker: Broker = {
    call<T>(method: string, params?: unknown): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        child.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    notifications,
    stop: () => { child.kill('SIGKILL'); },
    // The way the app really ends a broker: SIGTERM, which `bail` turns into `process.exit(0)`
    // (no-orphan, spec §11). Awaited, because the store's disk queue drains inside that exit.
    stopGracefully: () => {
      const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
      child.kill('SIGTERM');
      return exited;
    },
  };
  return ready.then(() => broker);
}

describe('run store — survives a broker process restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wigolo-run-restart-'));
  afterAll(() => {
    // A SIGKILLed child releases its database handle asynchronously, and Windows keeps the file
    // locked until it does — so the unlink races the kill and raises EBUSY. Retry, and never let
    // a leftover temp directory redden a test whose subject is durability, not cleanup.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch { /* the runner reclaims it */ }
  });

  it('reads back the identical run and event sequence from a second process', async () => {
    const first = await startBroker(dir);
    const created = await first.call<Run>('runCreate', {
      input: { task: 'compare the three cheapest options', driver: { kind: 'cli', client: { name: 'a-harness', version: '2.1.0' } } },
    });
    for (const event of [
      { actor: { kind: 'agent', driver: 'cli' }, type: 'tab.attached', payload: { tabId: 'tab-1', url: 'https://example.com' } },
      { actor: { kind: 'agent', driver: 'cli' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 4 } },
      { actor: { kind: 'agent', driver: 'cli' }, type: 'cost.recorded', payload: { kind: 'tokens_in', amount: 900 } },
      { actor: { kind: 'agent', driver: 'cli' }, type: 'decision.requested', payload: { decisionId: 'd1', kind: 'approval', prompt: 'sign in?' } },
    ]) {
      await first.call<RunEvent>('runAppend', { runId: created.id, event });
    }
    const before = await first.call<Run>('runGet', { runId: created.id });
    const logBefore = await first.call<RunEvent[]>('runEventsSince', { runId: created.id, limit: 100 });
    // The live tail fired for every committed envelope, in order, before the process died.
    expect((first.notifications.filter((n) => n.notify === 'run-event')).map((n) => (n.envelope as RunEvent).seq)).toEqual([1, 2, 3, 4, 5]);
    // Graceful, because the disk projection is queued rather than written inline (A-118-1) and the
    // law-11 assertion at the bottom is about the file. The SIGKILL boundary is the next test.
    await first.stopGracefully();

    const second = await startBroker(dir);
    const after = await second.call<Run>('runGet', { runId: created.id });
    const logAfter = await second.call<RunEvent[]>('runEventsSince', { runId: created.id, limit: 100 });
    second.stop();

    expect(after).toEqual(before);
    expect(logAfter).toEqual(logBefore);
    expect(logAfter.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(after.cost).toEqual({ browserActions: 4, tokensIn: 900, tokensOut: 0, spendUsd: 0 });
    expect(after.tabIds).toEqual(['tab-1']);
    expect(after.status).toBe('needs_you');
    expect(after.pendingDecisions.map((d) => d.decisionId)).toEqual(['d1']);

    // Law 11 — the run is on disk and readable without any of our tooling.
    const file = join(dir, 'studio', 'runs', created.id, 'events.jsonl');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))).toEqual(logAfter);
  }, 120_000);

  it('loses nothing that matters when the process is SIGKILLed — the DB is whole and the file is a prefix of it', async () => {
    // The boundary A-118-1 draws, said out loud rather than left to a CI flake. The projection is
    // queued now (it was `appendFileSync` before, complete by the time `appendEvent` returned), so a
    // kill no exit handler can survive may leave the file short. What must NOT change: the event log
    // itself, which is the source of truth every other surface projects from (law 1).
    const first = await startBroker(dir);
    const created = await first.call<Run>('runCreate', { input: { task: 'killed mid-flight', driver: { kind: 'cli' } } });
    for (let i = 0; i < 6; i++) {
      await first.call<RunEvent>('runAppend', {
        runId: created.id,
        event: { actor: { kind: 'agent', driver: 'cli' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } },
      });
    }
    first.stop(); // SIGKILL — no `exit` listener runs, nothing gets to drain

    const second = await startBroker(dir);
    const log = await second.call<RunEvent[]>('runEventsSince', { runId: created.id, limit: 100 });
    await second.stopGracefully();

    // Committed synchronously inside the transaction, so the crash cannot reach them.
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // And the file is a genuine PREFIX: whole lines, in seq order, never reordered and never a torn
    // one. How short it is depends on how much the runner had drained, which is why this arm bounds
    // rather than pins — the ordering and exactly-once claims underneath it have their teeth in
    // `run-store-disk-projection.test.ts` and `run-store-exit-drain.test.ts`, where the state can be
    // forced. What this arm catches is the shape a loaded machine produces and a fast one never does:
    // a batch that coalesced four events and then landed in the wrong order, or half-written.
    const file = join(dir, 'studio', 'runs', created.id, 'events.jsonl');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.map((l) => JSON.parse(l) as RunEvent)).toEqual(log.slice(0, lines.length));
  }, 120_000);
});
