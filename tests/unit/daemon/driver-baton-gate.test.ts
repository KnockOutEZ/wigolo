import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { createRunWithTail } from '../../../src/studio/run-bus.js';
import type { ClientInfo, Driver } from '../../../src/studio/run-store.js';
import { dispatchStudioTool, setBatonGate, type McpToolResult, type StudioHostHandlers } from '../../../src/daemon/studio-dispatch.js';
import { createBatonGate, grantWheel, requestWheel } from '../../../src/daemon/driver-baton.js';

/**
 * SD2 §7 row 12 AT THE TOOL BOUNDARY: two clients on one run — one drives, the others observe. An
 * observer's ACT is refused with the structured `not_the_driver` shape naming who drives, and the
 * refusal happens BEFORE the host handler runs, so an observer's act never reaches the page at all.
 * (The e2e version of this row is `wigolo-studio-run#58`.)
 */

let dir: string;
let db: Database.Database;
let acted: number;
let observed: number;
let caller: ClientInfo | undefined;

const A: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const B: Driver = { kind: 'sdk', client: { name: 'wigolo-sdk', version: '0.4.0' } };

const host = (): StudioHostHandlers => ({
  observe: async () => { observed++; return { id: 'snap1', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }; },
  act: async (input) => { acted++; return { ok: true, action: input.action, url: input.url }; },
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 'bg-1' }),
  close: async (input) => ({ closed: true as const, session_id: input.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: ['name'], rows: [{ name: 'A' }], pages_followed: 0, artifact_id: 1 }),
});

const body = (r: McpToolResult): Record<string, unknown> => JSON.parse(r.content[0].text) as Record<string, unknown>;

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-baton-gate-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  acted = 0;
  observed = 0;
  caller = undefined;
  // The production wiring installs this from `DaemonHttpServer.setStudioHost`; here the db and the
  // calling client are injected so one test can play two clients against one run.
  setBatonGate(createBatonGate({ openDb: async () => db, caller: () => caller }));
});

afterEach(() => {
  // A leaked gate outlives the suite and would silently gate every later dispatch test.
  setBatonGate(undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function newRun(driver: Driver = A): string {
  return createRunWithTail(db, { task: 'buy the monitor', driver }).id;
}

describe('an observer’s act is refused at the tool boundary, naming who drives', () => {
  it('refuses studio_act and never reaches the host handler', async () => {
    const runId = newRun();
    caller = B.client;
    const r = await dispatchStudioTool('studio_act', { action: 'navigate', url: 'https://example.com', run_id: runId }, host(), dir);

    expect(r.isError).toBe(true);
    expect(body(r)).toMatchObject({
      error_reason: 'not_the_driver',
      driver: { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } },
      driver_name: 'cli (claude-code)',
    });
    expect(String(body(r).hint)).toContain('Request the wheel');
    // The page was never touched: refusing after the act would be a different product.
    expect(acted).toBe(0);
  });

  it('lets the DRIVER act on the same run', async () => {
    const runId = newRun();
    caller = A.client;
    const r = await dispatchStudioTool('studio_act', { action: 'navigate', url: 'https://example.com', run_id: runId }, host(), dir);
    expect(r.isError).toBe(false);
    expect(acted).toBe(1);
  });

  it('still lets an observer OBSERVE — read-class calls are what an observer is for', async () => {
    const runId = newRun();
    caller = B.client;
    const r = await dispatchStudioTool('studio_observe', { since: 0, run_id: runId }, host(), dir);
    expect(r.isError).toBe(false);
    expect(observed).toBe(1);
  });

  it('refuses session lifecycle verbs too — an observer does not open or close the run’s sessions', async () => {
    const runId = newRun();
    caller = B.client;
    for (const name of ['studio_open', 'studio_spawn', 'studio_close']) {
      const r = await dispatchStudioTool(name, { run_id: runId }, host(), dir);
      expect(body(r).error_reason, name).toBe('not_the_driver');
    }
  });

  it('does not gate a call that names no run — the baton has nothing to say about it', async () => {
    caller = B.client;
    const r = await dispatchStudioTool('studio_act', { action: 'navigate', url: 'https://example.com' }, host(), dir);
    expect(r.isError).toBe(false);
    expect(acted).toBe(1);
  });

  it('allows rather than throwing when the store cannot be read at all', async () => {
    const runId = newRun();
    caller = B.client;
    setBatonGate(createBatonGate({ openDb: async () => { throw new Error('locked'); }, caller: () => caller }));
    const r = await dispatchStudioTool('studio_act', { action: 'navigate', run_id: runId }, host(), dir);
    expect(r.isError).toBe(false);
  });

  it('an unknown tool is still unknown — the gate never turns a 404 into a refusal about drivers', async () => {
    caller = B.client;
    const r = await dispatchStudioTool('studio_control', { run_id: newRun() }, host(), dir);
    expect(body(r).error_reason).toBe('unknown_studio_tool');
  });
});

describe('the demo: two MCP clients on one run, and the roles swap', () => {
  it('B refused naming A → B requests → A grants by requestId → B drives and A is refused', async () => {
    const runId = newRun(A);
    const act = async (client: ClientInfo | undefined): Promise<Record<string, unknown>> => {
      caller = client;
      return body(await dispatchStudioTool('studio_act', { action: 'navigate', url: 'https://example.com', run_id: runId }, host(), dir));
    };

    // 1. B is an observer. Its act is refused, and the refusal names A.
    expect(await act(B.client)).toMatchObject({ error_reason: 'not_the_driver', driver_name: 'cli (claude-code)' });

    // 2. B asks for the wheel. EXPLICITLY — the refusal above enqueued nothing.
    const asked = requestWheel(db, runId, { by: B, reason: 'I own the checkout step' });
    expect(asked.ok && asked.requestId).toBeTruthy();

    // 3. A grants THAT request, by id.
    const granted = grantWheel(db, runId, { by: A, requestId: asked.ok ? asked.requestId : undefined });
    expect(granted.ok && granted.run.driver).toEqual(B);

    // 4. The roles are swapped, on the same run, with no reconnect.
    acted = 0;
    expect(await act(B.client)).toMatchObject({ ok: true });
    expect(acted).toBe(1);
    expect(await act(A.client)).toMatchObject({ error_reason: 'not_the_driver', driver_name: 'sdk (wigolo-sdk)' });
    expect(acted).toBe(1);
  });
});
