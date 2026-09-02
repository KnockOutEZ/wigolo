import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { applyMigrations, _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { handleRunsRequest } from '../../src/daemon/rest/runs.js';
import { sqliteRunsStore } from '../../src/daemon/rest/runs-store.js';
import { createRunWithTail, subscribeRunEvents } from '../../src/studio/run-bus.js';
import type { Driver, RunEvent } from '../../src/studio/run-store.js';
import { dispatchStudioTool, setBatonGate, type StudioHostHandlers } from '../../src/daemon/studio-dispatch.js';
import { createBatonGate } from '../../src/daemon/driver-baton.js';

/**
 * Law 3 says the driver is "shown identically everywhere". This is that claim as a test: one run,
 * one handover, and the SAME STRING read off all three surfaces a client can reach it from — the
 * REST body, the live event stream, and a tool result. They agree because they share one formatter;
 * the day a surface renders `driver.kind` itself, this row is what says so.
 */

let dir: string;
let db: Database.Database;

const A: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const B: Driver = { kind: 'sdk', client: { name: 'wigolo-sdk', version: '0.4.0' } };

const host = (): StudioHostHandlers => ({
  observe: async () => ({ id: 's', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (input) => ({ ok: true, action: input.action, url: input.url }),
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 'bg-1' }),
  close: async (input) => ({ closed: true as const, session_id: input.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: [], rows: [], pages_followed: 0, artifact_id: 1 }),
});

interface RestAnswer { status: number; body: Record<string, unknown> }

async function rest(method: string, path: string, payload?: unknown): Promise<RestAnswer> {
  const req = (payload === undefined
    ? Object.assign(Readable.from([]), { headers: {} })
    : Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { headers: { 'content-type': 'application/json' } })
  ) as unknown as IncomingMessage;
  const res = { destroyed: false, headersSent: false, setTimeout: () => {}, writeHead: () => {}, end: () => {}, on: () => {}, off: () => {} } as unknown as ServerResponse;
  let answer: RestAnswer = { status: 0, body: {} };
  await handleRunsRequest(req, res, {
    pathname: path,
    method,
    url: new URL(`http://127.0.0.1${path}`),
    respond: (status, body) => { answer = { status, body: body as Record<string, unknown> }; },
    sendError: (e) => { answer = { status: e.status, body: e.body as unknown as Record<string, unknown> }; },
    store: sqliteRunsStore(db),
  });
  return answer;
}

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-baton-surfaces-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
});

afterEach(() => {
  setBatonGate(undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('one driver name, three surfaces', () => {
  it('REST, the event stream and a tool refusal all say the same string for one run', async () => {
    const runId = createRunWithTail(db, { task: 'buy the monitor', driver: A }).id;

    // Subscribed BEFORE the gesture: this is the same in-process bus the SSE route fans out from,
    // so what lands here is what a `GET /v1/runs/<id>/events` client would have been sent.
    const streamed: RunEvent[] = [];
    const unsubscribe = subscribeRunEvents(runId, (e) => streamed.push(e));

    // The handover happens over REST, gesture by gesture — there is no setter to shortcut it with.
    const asked = await rest('POST', `/v1/runs/${runId}/driver`, { gesture: 'request', by: B, reason: 'checkout step' });
    expect(asked.status).toBe(200);
    const requestId = asked.body.requestId as string;
    expect(requestId).toBeTruthy();

    const granted = await rest('POST', `/v1/runs/${runId}/driver`, { gesture: 'grant', by: A, requestId });
    expect(granted.status).toBe(200);
    unsubscribe();

    // Surface 1 — REST.
    const read = await rest('GET', `/v1/runs/${runId}`);
    const run = read.body.run as { driverName: string; driver: Driver; wheelRequests: unknown[] };
    expect(run.driver).toEqual(B);
    expect(run.wheelRequests).toEqual([]);

    // Surface 2 — the live event stream.
    const changed = streamed.find((e) => e.type === 'driver.changed');
    expect(changed).toBeDefined();
    expect(changed!.payload.cause).toBe('grant');
    expect(changed!.payload.requestId).toBe(requestId);
    const streamedName = (changed!.payload.to as { name: string }).name;

    // Surface 3 — a tool result. A is now the observer, and the refusal names the new driver.
    setBatonGate(createBatonGate({ openDb: async () => db, caller: () => A.client }));
    const refused = await dispatchStudioTool('studio_act', { action: 'navigate', url: 'https://example.com', run_id: runId }, host(), dir);
    const toolBody = JSON.parse(refused.content[0].text) as { error_reason: string; driver_name: string };
    expect(toolBody.error_reason).toBe('not_the_driver');

    expect([run.driverName, streamedName, toolBody.driver_name]).toEqual([
      'sdk (wigolo-sdk)',
      'sdk (wigolo-sdk)',
      'sdk (wigolo-sdk)',
    ]);
  });

  it('rejects a gesture body that names no maker, and refuses one made by a non-driver with 409', async () => {
    const runId = createRunWithTail(db, { task: 'buy the monitor', driver: A }).id;
    expect((await rest('POST', `/v1/runs/${runId}/driver`, { gesture: 'grant' })).status).toBe(400);
    expect((await rest('POST', `/v1/runs/${runId}/driver`, { gesture: 'nope', by: A })).status).toBe(400);

    const refused = await rest('POST', `/v1/runs/${runId}/driver`, { gesture: 'release', by: B });
    expect(refused.status).toBe(409);
    expect(refused.body.error_reason).toBe('not_the_driver');
    expect(String(refused.body.error)).toContain('cli (claude-code)');

    // The wheel has no GET of its own, and no other method moves it.
    expect((await rest('GET', `/v1/runs/${runId}/driver`)).status).toBe(405);
    expect((await rest('POST', `/v1/runs/zzzz/driver`, { gesture: 'release', by: A })).status).toBe(404);
  });
});
