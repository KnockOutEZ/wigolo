import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowNetworkInThisFile } from '../net-fence.js';

allowNetworkInThisFile(
  'boots two real daemon children on loopback in sequence; their background search-backend bootstrap may egress, the queue assertions do not',
);

/**
 * WHY: SD2 §3.3 says an undelivered message survives a daemon restart BY CONSTRUCTION — a message
 * is three events, and the queue is a fold over the log rather than anything a process holds. #54's
 * acceptance criterion is that this is proven with a REAL restart, and it has to be, because every
 * cheaper version of the test is self-refuting:
 *
 *   - a second `DaemonHttpServer` in this process reopens the SAME module-level SQLite handle and
 *     the same `run-bus` subscriber table, so it proves a cached handle still answers;
 *   - closing and reopening the handle in-process still leaves every `run-bus` subscriber and every
 *     module-level closure from before the "restart" alive.
 *
 * So the daemon is a child process, and it is killed. What survives is what is on disk.
 *
 * The second half is the part a durability test usually forgets: surviving is not enough, the
 * message has to still be DELIVERABLE. The restarted daemon is asked for one tool call through the
 * production dispatch seam, and the message it queued before the crash rides that result — the same
 * rules, on the other side of a process boundary, with no state handed across it.
 *
 * THE CHILD RUNS `dist/`. A stale build here would test the previous commit's daemon.
 */

let dataDir: string;
let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
let restPort = 0;
let controlPort = 0;
let runId = '';

interface Resp { status: number; body: unknown }

function request(port: number, opts: { method?: string; path: string; body?: string }): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { Connection: 'close', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = text;
          try { body = JSON.parse(text); } catch { /* leave as text */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const get = (path: string): Promise<Resp> => request(restPort, { path });
const post = (path: string, body: unknown): Promise<Resp> =>
  request(restPort, { method: 'POST', path, body: JSON.stringify(body) });

/** One tool call inside the daemon child — the only way another process can make it mint a result. */
async function toolCall(): Promise<Record<string, unknown>> {
  const answer = await request(controlPort, { method: 'POST', path: '/call', body: JSON.stringify({ runId }) });
  expect(answer.status).toBe(200);
  return answer.body as Record<string, unknown>;
}

async function messages(): Promise<Array<Record<string, unknown>>> {
  const answer = await get(`/v1/runs/${runId}/messages`);
  expect(answer.status).toBe(200);
  return (answer.body as { messages: Array<Record<string, unknown>> }).messages;
}

function startDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const spawned = spawn(process.execPath, [join(process.cwd(), 'tests/integration/delivery-queue-daemon-child.mjs')], {
      env: { ...process.env, WIGOLO_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = spawned;
    let out = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`daemon child never reported its ports. stderr:\n${stderr}`)), 60_000);
    spawned.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf-8');
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) return;
      clearTimeout(timer);
      const ports = JSON.parse(line) as { rest: number; control: number };
      restPort = ports.rest;
      controlPort = ports.control;
      resolve();
    });
    spawned.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    spawned.on('exit', (code) => {
      clearTimeout(timer);
      if (restPort === 0) reject(new Error(`daemon child exited early with ${code}. stderr:\n${stderr}`));
    });
  });
}

async function killDaemon(): Promise<void> {
  const dying = child;
  child = null;
  restPort = 0;
  controlPort = 0;
  if (!dying) return;
  await new Promise<void>((resolve) => {
    dying.on('exit', () => resolve());
    dying.kill('SIGKILL');
  });
}

beforeAll(() => {
  if (!existsSync(join(process.cwd(), 'dist/daemon/http-server.js'))) {
    throw new Error('dist/ is not built — run `npm run build` before this suite (the daemon child imports it).');
  }
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-queue-restart-'));
  delete process.env.WIGOLO_API_TOKEN;
  delete process.env.WIGOLO_API_TOKEN_FILE;
}, 60000);

afterAll(async () => {
  await killDaemon();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}, 30000);

describe('SD2 §3.3 — a message queued before a restart is delivered by the same rules after it', () => {
  it('survives the daemon it was queued in, still queued, and then rides the next result', async () => {
    await startDaemon();
    const firstPid = child!.pid;

    const created = await post('/v1/runs', { task: 'book the flight' });
    expect(created.status).toBe(201);
    runId = (created.body as { run: { id: string } }).run.id;

    // A human types while the agent is between calls. 202: accepted into the log, not delivered.
    const sent = await post(`/v1/runs/${runId}/messages`, { text: 'stop before you pay' });
    expect(sent.status).toBe(202);
    const queued = (sent.body as { message: Record<string, unknown> }).message;
    expect(queued.state).toBe('queued');
    expect(queued.state_line).toBe('queued — reaches the agent at its next tool call');

    // THE RESTART. SIGKILL, so nothing gets a chance to flush anything on the way out — what is on
    // disk is what was committed by the append, which is the whole of the durability claim.
    await killDaemon();
    await startDaemon();
    expect(child!.pid, 'the restart must be a different process').not.toBe(firstPid);

    // Surviving, and surviving in the state it was in — not re-queued, not lost, not "delivered"
    // to a process that no longer exists.
    const afterRestart = await messages();
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0].message_id).toBe(queued.message_id);
    expect(afterRestart[0].queued_at_step).toBe(queued.queued_at_step);
    expect(afterRestart[0].state).toBe('queued');
    expect(afterRestart[0].state_line).toBe('queued — reaches the agent at its next tool call');

    // And still deliverable: the agent's next call in the NEW process carries it, by mechanism 1,
    // with a step number the new process's own append assigned.
    const result = await toolCall();
    const carried = result.human_messages as Array<Record<string, unknown>>;
    expect(carried).toHaveLength(1);
    expect(carried[0].text).toBe('stop before you pay');
    expect(carried[0].delivered_via).toBe('piggyback');
    expect(carried[0].delivered_at_step).toBeGreaterThan(queued.queued_at_step as number);

    const delivered = await messages();
    expect(delivered[0].state).toBe('delivered');
    expect(delivered[0].delivered_at_step).toBe(carried[0].delivered_at_step);

    // The following call is the implicit acknowledgement, and REST says so.
    const second = await toolCall();
    expect(second.human_messages).toBeUndefined();
    const acknowledged = await messages();
    expect(acknowledged[0].state).toBe('acknowledged');
    expect(acknowledged[0].acknowledged_at_step).toBeGreaterThan(acknowledged[0].delivered_at_step as number);
    expect(acknowledged[0].state_line).toBe(`acknowledged at step ${String(acknowledged[0].acknowledged_at_step)}`);
  }, 180000);
});
