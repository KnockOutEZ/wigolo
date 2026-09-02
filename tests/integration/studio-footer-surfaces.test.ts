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
import { appendRunEventWithTail, createRunWithTail } from '../../src/studio/run-bus.js';
import type { Driver } from '../../src/studio/run-store.js';
import {
  dispatchStudioTool,
  setDeliveryHooks,
  setFooterSource,
  type McpToolResult,
  type StudioHostHandlers,
} from '../../src/daemon/studio-dispatch.js';
import { createFooterSource } from '../../src/daemon/result-footer.js';
import { createDeliveryHooks, queueMessage } from '../../src/daemon/message-queue.js';
import { profileClient, withClientProfile } from '../../src/daemon/capability-handshake.js';
import { isFooterBlock } from '../../src/daemon/studio-footer.js';

/**
 * SD2 §4.4 through the REAL stack — the footer source, the delivery queue and the run log wired the
 * way `setStudioHost` wires them, driven by `dispatchStudioTool`.
 *
 * Two claims, both of them law-shaped:
 *
 *  - §4.4's "phrasing is tailored per detected client; CONTENT IS IDENTICAL" (law 5). Two clients,
 *    one run, one state: the parsed block is byte-identical and the footer differs only in the
 *    imperative tails. Anything else differing would mean the client name had bought behaviour.
 *  - law 3's "shown identically everywhere": the footer's driver string is the one REST serves.
 *    The footer is the fourth surface to render a driver, and `driver-baton-surfaces` covers the
 *    other three.
 */

let dir: string;
let db: Database.Database;

const CLI: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };

const host = (): StudioHostHandlers => ({
  observe: async () => ({ id: 'snap-1', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (input) => ({ ok: true, action: input.action, url: input.url }),
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 'bg-1' }),
  close: async (input) => ({ closed: true as const, session_id: input.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: [], rows: [], pages_followed: 0, artifact_id: 1 }),
});

async function rest(method: string, path: string): Promise<Record<string, unknown>> {
  const req = Object.assign(Readable.from([]), { headers: {} }) as unknown as IncomingMessage;
  const res = { destroyed: false, headersSent: false, setTimeout: () => {}, writeHead: () => {}, end: () => {}, on: () => {}, off: () => {} } as unknown as ServerResponse;
  let body: Record<string, unknown> = {};
  await handleRunsRequest(req, res, {
    pathname: path,
    method,
    url: new URL(`http://127.0.0.1${path}`),
    respond: (_status, payload) => { body = payload as Record<string, unknown>; },
    sendError: (e) => { body = e.body as unknown as Record<string, unknown>; },
    store: sqliteRunsStore(db),
  });
  return body;
}

/** Dispatch as a named client — the detected tier is exactly what the MCP handshake reported. */
function asClient(name: string | undefined, call: () => Promise<McpToolResult>): Promise<McpToolResult> {
  const profile = profileClient(name ? { name, version: '1.0.0' } : undefined);
  return withClientProfile(profile, call);
}

const footerOf = (r: McpToolResult): string[] => {
  expect(isFooterBlock(r.content[1])).toBe(true);
  return r.content[1]!.text.split('\n');
};

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-footer-surfaces-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  setFooterSource(createFooterSource({ openDb: async () => db, caller: () => CLI.client }));
  setDeliveryHooks(createDeliveryHooks({ openDb: async () => db, caller: () => CLI.client }));
});

afterEach(() => {
  setFooterSource(undefined);
  setDeliveryHooks(undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('two detected clients, one run — identical content, tailored phrasing', () => {
  it('renders the same fields, values and numbers; only the imperatives are reworded', async () => {
    const run = createRunWithTail(db, { task: 'compare two monitors', driver: CLI });
    appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 't1' } });
    appendRunEventWithTail(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    appendRunEventWithTail(db, run.id, { actor: { kind: 'human' }, type: 'snapshot.invalidated', payload: { by: 'human', cause: 'input', tabId: 't1' } });
    appendRunEventWithTail(db, run.id, {
      actor: { kind: 'daemon' },
      type: 'decision.requested',
      payload: { decisionId: 'd1', kind: 'approval', prompt: 'Allow the purchase of one monitor?' },
    });

    // A mapped harness and an unmapped one, same call, same run state. `studio_marks` is a read that
    // does not itself clear the invalidation, so both see the identical page-changed announcement.
    const known = await asClient('claude-code', () => dispatchStudioTool('studio_marks', { run_id: run.id }, host(), dir));
    const unknown = await asClient('some-other-harness', () => dispatchStudioTool('studio_marks', { run_id: run.id }, host(), dir));

    // The parsed block is what every consumer reads: byte-identical between the two clients.
    expect(known.content[0]).toEqual(unknown.content[0]);

    const a = footerOf(known);
    const b = footerOf(unknown);
    expect(a).toHaveLength(b.length);

    // Same fields, same values, same numbers — compared with the imperative tails stripped off.
    const withoutImperative = (lines: string[]) => lines.map((l) => l.split(' — ')[0]);
    expect(withoutImperative(a)).toEqual(withoutImperative(b));
    expect(a[0]).toBe(`— run ${run.id} · driver cli (claude-code) · tab 1 —`);
    expect(a.at(-1)).toBe(`  cost so far: $0.00 · 1 browser actions · watch: wigolo.studio/r/${run.id}`);

    // And the only difference is the two imperatives §4.2 lets phrasing reword.
    expect(a.filter((line, i) => line !== b[i])).toEqual([
      '  page changed: yes — page changed by human — re-read with studio_observe',
      '  approval: Allow the purchase of one monitor? — resolve from the panel, or answer here',
    ]);
    expect(b.filter((line, i) => line !== a[i])).toEqual([
      '  page changed: yes — page changed by human — re-read the page',
      '  approval: Allow the purchase of one monitor? — resolve from any surface, or answer here',
    ]);
  });

  it('the footer\'s driver string is the one REST serves — the fourth surface agrees with the other three', async () => {
    const run = createRunWithTail(db, { task: 'compare two monitors', driver: CLI });
    const result = await asClient('claude-code', () => dispatchStudioTool('studio_list', { run_id: run.id }, host(), dir));
    const served = ((await rest('GET', `/v1/runs/${run.id}`)).run as { driverName: string }).driverName;

    expect(served).toBe('cli (claude-code)');
    expect(footerOf(result)[0]).toContain(`driver ${served} `);
  });
});

describe('law 7 at the footer — a delivered message is counted, once', () => {
  it('the result that carries the human message says so; the next one does not', async () => {
    const run = createRunWithTail(db, { task: 'compare two monitors', driver: CLI });
    queueMessage(db, run.id, { text: 'buy the cheaper one' });

    const carrying = await asClient('claude-code', () => dispatchStudioTool('studio_observe', { run_id: run.id }, host(), dir));
    expect(JSON.parse(carrying.content[0]!.text).human_messages).toHaveLength(1);
    expect(footerOf(carrying)).toContain('  human msgs: 1');

    const after = await asClient('claude-code', () => dispatchStudioTool('studio_observe', { run_id: run.id }, host(), dir));
    expect(footerOf(after).some((l) => l.startsWith('  human msgs'))).toBe(false);
  });
});

describe('§7 row 11 — the browser closes mid-run', () => {
  it('the next call answers with the structured error, the run id, and the watch link', async () => {
    const run = createRunWithTail(db, { task: 'compare two monitors', driver: CLI });
    const dead: StudioHostHandlers = { ...host(), observe: async () => { throw new Error('Target page, context or browser has been closed'); } };

    const result = await asClient('claude-code', () => dispatchStudioTool('studio_observe', { run_id: run.id }, dead, dir));

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body).toEqual({
      error_reason: 'browser_closed',
      run: run.id,
      hint: `The browser engine closed while run ${run.id} was in flight. The run and its log survive; results so far are at the watch link. Re-open the browser and resume, or end the run.`,
    });
    expect(footerOf(result).at(-1)).toContain(`watch: wigolo.studio/r/${run.id}`);

    // The run outlives the browser (law 2): it is still there, still readable, still driven.
    expect(((await rest('GET', `/v1/runs/${run.id}`)).run as { id: string }).id).toBe(run.id);
  });
});
