import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { createRunWithTail } from '../../../src/studio/run-bus.js';
import { eventsSince, type Driver } from '../../../src/studio/run-store.js';
import {
  dispatchStudioTool,
  setBatonGate,
  setDeliveryHooks,
  setReceiptDelivery,
  type McpToolResult,
  type StudioHostHandlers,
} from '../../../src/daemon/studio-dispatch.js';
import { createBatonGate, grantWheel, releaseWheel, requestWheel, takeWheel } from '../../../src/daemon/driver-baton.js';
import { createDeliveryHooks } from '../../../src/daemon/message-queue.js';
import { NOTHING_TO_POLL, RECEIPT_DELIVERED, createReceiptDelivery } from '../../../src/daemon/driver-receipt.js';

/**
 * SD2 §7 rows 2 and 3, at the seam that actually has to honour them.
 *
 * WHY THIS FILE EXISTS SEPARATELY from the module tests: rows 2 and 3 are not properties of a
 * function, they are properties of a SEQUENCE of tool calls made by a client that has already lost
 * the wheel. Once-ness, and "then refusals", are only observable across calls — a unit test of
 * either projection can be perfectly green while the dispatch ladder returns the interrupt twice,
 * or returns the refusal first and swallows the receipt behind it.
 *
 * The whole ladder is installed here on purpose (baton gate + delivery hooks + receipt delivery),
 * because the ORDER between the three is the contract.
 */

let dir: string;
let db: Database.Database;
let runId: string;

const AGENT: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const SDK: Driver = { kind: 'sdk', client: { name: 'wigolo-sdk', version: '0.4.0' } };
const HUMAN: Driver = { kind: 'human' };
const STUDIO: Driver = { kind: 'studio' };

function host(): StudioHostHandlers {
  return {
    observe: async () => ({ id: 's', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
    act: async (input) => ({ ok: true, action: input.action, url: input.url }),
    marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
    capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
    spawn: async () => ({ session_id: 'bg-1' }),
    close: async (input) => ({ closed: true as const, session_id: input.session_id ?? '' }),
    list: async () => ({ sessions: [] }),
    say: async () => ({ posted: true, posted_at: 0 }),
    extractSet: async () => ({ columns: [], rows: [], pages_followed: 0, artifact_id: 1 }),
  };
}

type Body = Record<string, unknown>;

function body(result: McpToolResult): Body {
  const block = result.content[0]!;
  if (block.type !== 'text') throw new Error('not a text block');
  return JSON.parse(block.text) as Body;
}

/** One act-class call as the old driver. Act-class so the baton refusal is reachable. */
async function act(): Promise<McpToolResult> {
  return dispatchStudioTool('studio_act', { action: 'navigate', url: 'https://example.com', run_id: runId }, host(), dir);
}

/** One read-class call as the old driver — never refused, so it isolates the receipt from the refusal. */
async function observe(): Promise<McpToolResult> {
  return dispatchStudioTool('studio_observe', { run_id: runId }, host(), dir);
}

function eventTypes(): string[] {
  return eventsSince(db, runId, 0, 200).map((e) => e.type);
}

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-baton-takeover-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  runId = createRunWithTail(db, { task: 'book the flight', driver: AGENT }).id;
  const caller = (): typeof AGENT.client => AGENT.client;
  setDeliveryHooks(createDeliveryHooks({ openDb: async () => db, caller }));
  setBatonGate(createBatonGate({ openDb: async () => db, caller }));
  setReceiptDelivery(createReceiptDelivery({ openDb: async () => db, caller }));
});

afterEach(() => {
  setDeliveryHooks(undefined);
  setBatonGate(undefined);
  setReceiptDelivery(undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('§7 row 2 — the human takes the wheel', () => {
  it('answers the next call with the interrupted shape EXACTLY once, then refuses', async () => {
    takeWheel(db, runId, { by: HUMAN, reason: 'I will finish the checkout myself' });

    const first = body(await act());
    expect(first).toMatchObject({
      interrupted: true,
      reason: 'human took control',
      detail: 'I will finish the checkout myself',
    });

    // Once. The second call is an ordinary observer refusal naming who drives.
    const second = body(await act());
    expect(second.interrupted).toBeUndefined();
    expect(second).toMatchObject({ error_reason: 'not_the_driver', driver_name: 'human' });

    // …and it stays refused; the interrupt does not come back around.
    expect(body(await act()).interrupted).toBeUndefined();
  });

  it('is a designed answer, not a failure — the agent should observe and wait, not retry', async () => {
    takeWheel(db, runId, { by: HUMAN });
    const first = await act();
    expect(first.isError).toBe(false);
    expect(body(first)).toMatchObject({ interrupted: true, reason: 'human took control' });
    expect(body(first).detail).toBeUndefined(); // no reason given ⇒ no invented one
  });

  it('does NOT hand the taken-from driver a release receipt — the two answers are disjoint', async () => {
    takeWheel(db, runId, { by: HUMAN });
    expect(body(await act()).released).toBeUndefined();
    expect(body(await act()).released).toBeUndefined();
    expect(eventTypes()).not.toContain(RECEIPT_DELIVERED);
  });
});

describe('§7 row 3 — the driver released', () => {
  it('rides the old driver`s next call with to-whom, nothing-to-poll and the watch link', async () => {
    requestWheel(db, runId, { by: SDK, requestId: 'wr_sdk' });
    releaseWheel(db, runId, { by: AGENT });

    const released = body(await observe()).released as { to: Body; text: string };
    expect(released.to).toEqual({ kind: 'sdk', client: SDK.client });
    expect(released.text).toContain('sdk (wigolo-sdk)');
    expect(released.text).toContain(NOTHING_TO_POLL);
    expect(released.text).toContain(`wigolo.studio/r/${runId}`);
  });

  it('rides a REFUSED call too, and the refusal survives beside it', async () => {
    grantWheel(db, runId, { by: HUMAN, to: SDK });

    const refused = await act();
    expect(refused.isError).toBe(true);
    expect(body(refused)).toMatchObject({
      error_reason: 'not_the_driver',
      driver_name: 'sdk (wigolo-sdk)',
      released: { to: { kind: 'sdk', client: SDK.client } },
    });
  });

  it('tells a driver the human handed the wheel to the panel, which the baton gate cannot refuse for', async () => {
    // `{ kind: 'studio' }` carries no MCP badge, so #52's gate allows the call — refusing on an
    // absence of information is the one thing it must never do. The receipt is the only thing that
    // tells this client the wheel is gone, which is exactly why it does not reuse that predicate.
    grantWheel(db, runId, { by: HUMAN, to: STUDIO });

    const result = await act();
    expect(result.isError).toBe(false);
    expect(body(result)).toMatchObject({ ok: true, released: { to: { kind: 'studio', client: null } } });
    expect((body(result).released as { text: string }).text).toMatch(/granted to studio/);
  });

  it('audits the delivery once, naming the recipient and the transition seq', async () => {
    releaseWheel(db, runId, { by: AGENT });
    const changed = eventsSince(db, runId, 0, 200).find((e) => e.type === 'driver.changed')!;

    await observe();
    await observe();

    const audited = eventsSince(db, runId, 0, 200).filter((e) => e.type === RECEIPT_DELIVERED);
    expect(audited).toHaveLength(1);
    expect(audited[0]!.payload).toEqual({ to: AGENT, at_seq: changed.seq });
  });

  it('keeps the §4.4 footer on a receipted result — the receipt is a decoration, not a second exit', async () => {
    releaseWheel(db, runId, { by: AGENT });
    const result = await observe();
    expect(body(result).released).toBeDefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[1]!.type).toBe('text');
  });
});
