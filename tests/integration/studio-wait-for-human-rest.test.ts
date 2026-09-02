import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { allowNetworkInThisFile } from '../net-fence.js';
import { applyMigrations, _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { sqliteRunsStore } from '../../src/daemon/rest/runs-store.js';
import { createDeliveryHooks } from '../../src/daemon/message-queue.js';
import {
  dispatchStudioTool,
  setBatonGate,
  setDeliveryHooks,
  type StudioHostHandlers,
} from '../../src/daemon/studio-dispatch.js';
import { runEventListenerCount } from '../../src/studio/run-bus.js';

allowNetworkInThisFile('boots one real DaemonHttpServer on loopback; the test makes no external requests');

let daemon: import('../../src/daemon/http-server.js').DaemonHttpServer;
let db: Database.Database;
let dir: string;
let port = 0;

interface Response {
  status: number;
  body: Record<string, unknown>;
}

function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        Connection: 'close',
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('request timeout')));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const host = (): StudioHostHandlers => ({
  observe: async () => ({ id: 's', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  // The host recognizes the additive verb and returns its sentinel. The daemon delivery seam owns
  // the parked Promise and replaces this with the eventual human answer.
  act: async (input) => ({ ok: true, action: input.action }),
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 'bg-1' }),
  close: async (input) => ({ closed: true, session_id: input.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: [], rows: [], pages_followed: 0 }),
});

async function createRun(task: string): Promise<string> {
  const response = await request('POST', '/v1/runs', {
    task,
    driver: { kind: 'cli', client: { name: 'wait-demo', version: '1.0' } },
  });
  expect(response.status).toBe(201);
  return (response.body.run as { id: string }).id;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-wait-rest-'));
  _resetMigrationGuard();
  db = new Database(join(dir, 'wait.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });

  const { DaemonHttpServer } = await import('../../src/daemon/http-server.js');
  daemon = new DaemonHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiToken: null,
    runStore: sqliteRunsStore(db),
    // REST is under test; studio-only mode avoids booting unrelated search subsystems.
    mcpServerFactory: () => new Server({ name: 'wait-demo', version: '1.0' }, { capabilities: { tools: {} } }),
  });
  port = Number(new URL(await daemon.start()).port);
  setDeliveryHooks(createDeliveryHooks({
    openDb: async () => db,
    caller: () => ({ name: 'wait-demo', version: '1.0' }),
  }));
}, 30_000);

afterAll(async () => {
  setDeliveryHooks(undefined);
  setBatonGate(undefined);
  await daemon?.stop();
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
}, 30_000);

describe('wait_for_human — real REST resolution', () => {
  it('parks run A only and resolves it from POST /messages with a wait delivery receipt', async () => {
    const runA = await createRun('choose an account');
    const runB = await createRun('continue independently');

    let waitSettled = false;
    const waiting = dispatchStudioTool(
      'studio_act',
      { action: 'wait_for_human', reason: 'Which account should I use?', run_id: runA },
      host(),
      dir,
    ).then((result) => {
      waitSettled = true;
      return result;
    });
    await expect.poll(() => runEventListenerCount(runA), { timeout: 2_000 }).toBe(1);

    const independent = await dispatchStudioTool(
      'studio_act',
      { action: 'navigate', url: 'https://example.com', run_id: runB },
      host(),
      dir,
    );
    expect(JSON.parse(independent.content[0]!.text)).toMatchObject({ ok: true, action: 'navigate' });
    expect(waitSettled).toBe(false);

    const sent = await request('POST', `/v1/runs/${runA}/messages`, { text: 'Use the work account' });
    expect(sent.status).toBe(202);
    expect(sent.body.message).toMatchObject({ text: 'Use the work account', state: 'queued' });

    const result = JSON.parse((await waiting).content[0]!.text) as {
      answer: Record<string, unknown>;
      human_messages: Array<Record<string, unknown>>;
    };
    expect(result.answer).toMatchObject({ text: 'Use the work account', state: 'delivered', delivered_via: 'wait' });
    expect(result.human_messages).toEqual([result.answer]);
    expect(runEventListenerCount(runA)).toBe(0);

    const listed = await request('GET', `/v1/runs/${runA}/messages`);
    expect(listed.status).toBe(200);
    expect(listed.body.messages).toEqual([expect.objectContaining({
      text: 'Use the work account',
      state: 'delivered',
      delivered_via: 'wait',
    })]);
  });
});
