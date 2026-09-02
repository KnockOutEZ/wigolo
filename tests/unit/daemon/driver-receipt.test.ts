import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { createRunWithTail } from '../../../src/studio/run-bus.js';
import { eventsSince, getRun, type ClientInfo, type Driver, type Run } from '../../../src/studio/run-store.js';
import { grantWheel, releaseWheel, requestWheel, takeWheel } from '../../../src/daemon/driver-baton.js';
import {
  NOTHING_TO_POLL,
  RECEIPT_DELIVERED,
  consumeReleaseReceipt,
  pendingReleaseReceipt,
  withReleaseReceipt,
} from '../../../src/daemon/driver-receipt.js';
import type { McpToolResult } from '../../../src/daemon/studio-dispatch.js';

/**
 * SD2 §1.4 row 3 — the release receipt. The wheel moving is a run event; the OLD driver learning
 * about it is a separate fact, because a pull client is told nothing until it calls again (law 7).
 * Every row here is about that gap: the receipt is a projection of `driver.changed`, it rides the
 * old driver's next result whatever that result is, and `driver.receipt_delivered` is the audit
 * that it landed.
 */

let dir: string;
let db: Database.Database;

const A: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const B: Driver = { kind: 'sdk', client: { name: 'wigolo-sdk', version: '0.4.0' } };
const HUMAN: Driver = { kind: 'human' };
const STUDIO: Driver = { kind: 'studio' };

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-receipt-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function newRun(driver: Driver = A): Run {
  return createRunWithTail(db, { task: 'compare two monitors', driver });
}

function live(run: Run): Run {
  return getRun(db, run.id)!;
}

function textResult(data: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
}

function body(result: McpToolResult): Record<string, unknown> {
  const block = result.content[0]!;
  if (block.type !== 'text') throw new Error('not a text block');
  return JSON.parse(block.text) as Record<string, unknown>;
}

function deliver(run: Run, caller: ClientInfo | undefined, result: McpToolResult): McpToolResult | undefined {
  const current = live(run);
  const pending = pendingReleaseReceipt(db, current, caller);
  if (!pending) return undefined;
  const merged = withReleaseReceipt(result, pending.receipt);
  if (!merged) return undefined;
  consumeReleaseReceipt(db, current, caller, pending);
  return merged;
}

describe('the receipt names the new driver, says nothing is coming, and links the watch page', () => {
  it('carries to-whom, the verbatim nothing-to-poll phrase and the watch link', () => {
    const run = newRun(A);
    releaseWheel(db, run.id, { by: A });

    const pending = pendingReleaseReceipt(db, live(run), A.client)!;
    expect(pending).toBeDefined();
    expect(pending.receipt.to).toEqual({ kind: 'human', client: null });
    expect(pending.receipt.text).toContain(NOTHING_TO_POLL);
    expect(pending.receipt.text).toContain(`wigolo.studio/r/${run.id}`);
    expect(pending.receipt.text).toContain('human');
  });

  it('names the successor with the ONE driver formatter, client badge included', () => {
    const run = newRun(A);
    requestWheel(db, run.id, { by: B, requestId: 'wr_b' });
    releaseWheel(db, run.id, { by: A });

    const pending = pendingReleaseReceipt(db, live(run), A.client)!;
    expect(pending.receipt.to).toEqual({ kind: 'sdk', client: B.client });
    expect(pending.receipt.text).toContain('sdk (wigolo-sdk)');
  });

  it('says the wheel was GRANTED when a human moved it, rather than claiming the agent released it', () => {
    const run = newRun(A);
    grantWheel(db, run.id, { by: HUMAN, to: STUDIO });

    const pending = pendingReleaseReceipt(db, live(run), A.client)!;
    expect(pending.receipt.to).toEqual({ kind: 'studio', client: null });
    expect(pending.receipt.text).toMatch(/granted/i);
    expect(pending.receipt.text).not.toMatch(/you released/i);
    // The pinned fields are the same either way — only the sentence differs.
    expect(pending.receipt.text).toContain(NOTHING_TO_POLL);
    expect(pending.receipt.text).toContain(`wigolo.studio/r/${run.id}`);
  });
});

describe('the receipt is owed to the OLD driver, exactly once', () => {
  it('rides the first result and never a second one', () => {
    const run = newRun(A);
    releaseWheel(db, run.id, { by: A });

    const first = deliver(run, A.client, textResult({ ok: true }));
    expect(body(first!).released).toMatchObject({ to: { kind: 'human' } });
    expect(body(first!).ok).toBe(true);

    expect(deliver(run, A.client, textResult({ ok: true }))).toBeUndefined();
  });

  it('records driver.receipt_delivered naming the recipient and the transition seq', () => {
    const run = newRun(A);
    releaseWheel(db, run.id, { by: A });
    const changed = eventsSince(db, run.id, 0, 100).find((e) => e.type === 'driver.changed')!;

    deliver(run, A.client, textResult({ ok: true }));

    const audited = eventsSince(db, run.id, 0, 100).filter((e) => e.type === RECEIPT_DELIVERED);
    expect(audited).toHaveLength(1);
    expect(audited[0]!.payload).toEqual({ to: A, at_seq: changed.seq });
  });

  it('is not owed to the client that now holds the wheel', () => {
    const run = newRun(A);
    requestWheel(db, run.id, { by: B, requestId: 'wr_b' });
    releaseWheel(db, run.id, { by: A });

    // B drives now: "no further results will arrive on this connection" would be a lie.
    expect(pendingReleaseReceipt(db, live(run), B.client)).toBeUndefined();
    expect(pendingReleaseReceipt(db, live(run), A.client)).toBeDefined();
  });

  it('is not owed to a bystander that never drove this run', () => {
    const run = newRun(A);
    releaseWheel(db, run.id, { by: A });
    expect(pendingReleaseReceipt(db, live(run), { name: 'other-cli', version: '1.0.0' })).toBeUndefined();
  });

  it('is NOT the takeover answer — a takeover owes the interrupted shape, not a receipt', () => {
    const run = newRun(A);
    takeWheel(db, run.id, { by: HUMAN, reason: 'sign-in needs you' });
    expect(pendingReleaseReceipt(db, live(run), A.client)).toBeUndefined();
  });

  it('survives the old driver never calling again — the transition is on the log regardless', () => {
    const run = newRun(A);
    releaseWheel(db, run.id, { by: A });

    // Nothing delivered: no receipt event at all, and the run log still says where the wheel went.
    expect(eventsSince(db, run.id, 0, 100).filter((e) => e.type === RECEIPT_DELIVERED)).toHaveLength(0);
    const changed = eventsSince(db, run.id, 0, 100).find((e) => e.type === 'driver.changed')!;
    expect(changed.payload).toMatchObject({ cause: 'release', to: { kind: 'human', name: 'human' } });
    // …and a client that DOES come back later still gets it.
    expect(pendingReleaseReceipt(db, live(run), A.client)).toBeDefined();
  });
});

describe('merging a receipt into a result never invents a place to put it', () => {
  it('keeps the result body and appends only the released key', () => {
    const run = newRun(A);
    releaseWheel(db, run.id, { by: A });
    const pending = pendingReleaseReceipt(db, live(run), A.client)!;

    const merged = withReleaseReceipt(textResult({ ok: true, marks: [1, 2] }), pending.receipt)!;
    expect(body(merged)).toMatchObject({ ok: true, marks: [1, 2], released: pending.receipt });
    expect(merged.isError).toBe(false);
  });

  it('rides a REFUSED result too — an observer refusal is still the old driver`s next call', () => {
    const run = newRun(A);
    releaseWheel(db, run.id, { by: A });
    const refused: McpToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ error_reason: 'not_the_driver' }, null, 2) }],
      isError: true,
    };
    const merged = deliver(run, A.client, refused)!;
    expect(merged.isError).toBe(true);
    expect(body(merged)).toMatchObject({ error_reason: 'not_the_driver', released: { to: { kind: 'human' } } });
  });

  it('declines a result it cannot merge into, leaving the receipt owed', () => {
    const run = newRun(A);
    releaseWheel(db, run.id, { by: A });
    const pending = pendingReleaseReceipt(db, live(run), A.client)!;

    expect(withReleaseReceipt({ content: [{ type: 'text', text: 'not json' }], isError: false }, pending.receipt)).toBeUndefined();
    expect(withReleaseReceipt({ content: [], isError: false }, pending.receipt)).toBeUndefined();
    // Nothing was consumed, so the next mergeable result still carries it.
    expect(pendingReleaseReceipt(db, live(run), A.client)).toBeDefined();
  });
});
