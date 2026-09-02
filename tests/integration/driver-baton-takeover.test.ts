import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { createRunWithTail } from '../../src/studio/run-bus.js';
import { eventsSince, getRun, type Driver } from '../../src/studio/run-store.js';
import { ControlToken } from '../../src/studio/control-token.js';
import {
  dispatchStudioTool,
  setBatonGate,
  setDeliveryHooks,
  setFooterSource,
  setReceiptDelivery,
  type McpToolResult,
  type StudioHostHandlers,
} from '../../src/daemon/studio-dispatch.js';
import { createBatonGate, formatDriver, grantWheel } from '../../src/daemon/driver-baton.js';
import { createBatonTokenBridge, type BatonTokenBridge } from '../../src/daemon/driver-baton-bridge.js';
import { createDeliveryHooks } from '../../src/daemon/message-queue.js';
import { createFooterSource } from '../../src/daemon/result-footer.js';
import { RECEIPT_DELIVERED, createReceiptDelivery } from '../../src/daemon/driver-receipt.js';

/**
 * #217's demo, as an assertion: ONE run, ONE MCP client, and the whole baton story end to end —
 * the client drives, a human takes the wheel by hand, the client's next call is told so, the human
 * hands the wheel to the panel, and the client's next call carries the receipt.
 *
 * WHY AN INTEGRATION TEST and not three unit rows: every step here is produced by a DIFFERENT
 * mechanism — the bridge reflects the hand takeover upward, the delivery queue's interrupt returns
 * row 2, the baton gate returns the refusal, the receipt hook decorates it — and the thing worth
 * proving is that they compose in this order without any of them being told about the others. The
 * takeover is performed the way a human actually performs one (a control-token reclaim on the live
 * session), NOT by calling `takeWheel` directly, because the run only learns about that flip if the
 * bridge is really in the loop.
 */

let dir: string;
let db: Database.Database;
let runId: string;
let token: ControlToken;
let bridge: BatonTokenBridge;

const CLI: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const STUDIO: Driver = { kind: 'studio' };
const HUMAN: Driver = { kind: 'human' };

function host(): StudioHostHandlers {
  return {
    observe: async () => ({ id: 's1', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
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

const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

/** The MCP client's call, and the JSON block the agent would read plus the footer it would see. */
async function agentCall(): Promise<{ body: Record<string, unknown>; footer: string; isError: boolean }> {
  const result: McpToolResult = await dispatchStudioTool(
    'studio_act',
    { action: 'navigate', url: 'https://shop.example/cart', run_id: runId },
    host(),
    dir,
  );
  const first = result.content[0]!;
  const last = result.content[result.content.length - 1]!;
  return {
    body: JSON.parse(first.type === 'text' ? first.text : '{}') as Record<string, unknown>,
    footer: last.type === 'text' && last !== first ? last.text : '',
    isError: result.isError === true,
  };
}

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-217-demo-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  runId = createRunWithTail(db, { task: 'buy the 27-inch monitor', driver: CLI }).id;

  // The live session the human's hands are on, and the bridge that ties it to the run.
  token = new ControlToken({ initialHolder: 'agent' });
  bridge = createBatonTokenBridge({ token, runId, openDb: () => db });

  // The whole dispatch ladder, as `DaemonHttpServer.setStudioHost` installs it.
  const caller = (): typeof CLI.client => CLI.client;
  setDeliveryHooks(createDeliveryHooks({ openDb: async () => db, caller }));
  setBatonGate(createBatonGate({ openDb: async () => db, caller }));
  setReceiptDelivery(createReceiptDelivery({ openDb: async () => db, caller }));
  setFooterSource(createFooterSource({ openDb: async () => db, caller }));
});

afterEach(() => {
  bridge.dispose();
  setDeliveryHooks(undefined);
  setBatonGate(undefined);
  setReceiptDelivery(undefined);
  setFooterSource(undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('#217 demo — MCP client drives, human takes the wheel, human hands it on', () => {
  it('tells the client it was interrupted, then refuses it, then hands it the receipt', async () => {
    // 1. THE CLIENT DRIVES. Ordinary result, footer attached, nothing owed to anyone.
    const driving = await agentCall();
    expect(driving.body).toMatchObject({ ok: true, action: 'navigate' });
    expect(driving.isError).toBe(false);
    expect(driving.footer).toContain(`wigolo.studio/r/${runId}`);

    // 2. THE HUMAN TAKES THE WHEEL — by hand, on the session. The bridge reports it upward.
    token.reclaim();
    await flush();
    expect(getRun(db, runId)!.driver).toEqual(HUMAN);
    expect(formatDriver(getRun(db, runId)!.driver)).toBe('human');

    // 3. THE CLIENT'S NEXT CALL is told, once, and told that this is an answer rather than a fault.
    const interrupted = await agentCall();
    expect(interrupted.isError).toBe(false);
    expect(interrupted.body).toMatchObject({ interrupted: true, reason: 'human took control' });

    // 4. THE CALL AFTER THAT is an observer refusal naming who drives — the interrupt does not repeat.
    const refused = await agentCall();
    expect(refused.body.interrupted).toBeUndefined();
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatchObject({ error_reason: 'not_the_driver', driver_name: 'human' });

    // 5. THE HUMAN HANDS THE WHEEL ON to the panel rather than back to the agent.
    grantWheel(db, runId, { by: HUMAN, to: STUDIO, reason: 'I will watch from the panel' });
    await flush();
    expect(getRun(db, runId)!.driver).toEqual(STUDIO);
    expect(token.holder).toBe('agent'); // studio is a machine driver: the bridge re-granted input

    // 6. THE RECEIPT rides the client's next call: to whom, nothing to poll, the watch link.
    const receipted = await agentCall();
    const released = receipted.body.released as { to: Record<string, unknown>; text: string };
    expect(released.to).toEqual({ kind: 'studio', client: null });
    expect(released.text).toBe(
      'The wheel was granted to studio. No further results will arrive on this connection — nothing to poll. '
      + `Watch: wigolo.studio/r/${runId}`,
    );

    // 7. AND ONCE. The next call is the refusal alone; the log audits exactly one delivery.
    const after = await agentCall();
    expect(after.body.released).toBeUndefined();
    const audited = eventsSince(db, runId, 0, 500).filter((e) => e.type === RECEIPT_DELIVERED);
    expect(audited).toHaveLength(1);
    expect(audited[0]!.payload).toMatchObject({ to: CLI });

    // The run log is the whole story, in order, with no second source of truth anywhere in it.
    expect(eventsSince(db, runId, 0, 500).map((e) => e.type)).toEqual([
      'run.created',
      'driver.changed',              // the hand takeover, reflected upward by the bridge
      'delivery.interrupt_consumed', // row 2, delivered once
      'driver.changed',              // the human's grant to the panel
      RECEIPT_DELIVERED,             // row 3, delivered once
    ]);
  });
});
