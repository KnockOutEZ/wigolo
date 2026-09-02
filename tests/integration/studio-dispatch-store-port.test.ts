import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { sqliteRunsStore, type RunsStore } from '../../src/daemon/rest/runs-store.js';
import { appendRunEventWithTail, createRunWithTail } from '../../src/studio/run-bus.js';
import { eventsOfTypes, getRun, type Driver } from '../../src/studio/run-store.js';
import {
  dispatchStudioTool,
  setBatonGate,
  setDeliveryHooks,
  setFooterSource,
  setReceiptDelivery,
  type McpToolResult,
  type StudioHostHandlers,
} from '../../src/daemon/studio-dispatch.js';
import { createFooterSource } from '../../src/daemon/result-footer.js';
import { createBatonGate, releaseWheel } from '../../src/daemon/driver-baton.js';
import { createReceiptDelivery } from '../../src/daemon/driver-receipt.js';
import { createDeliveryHooks, queueMessage } from '../../src/daemon/message-queue.js';
import { profileClient, withClientProfile } from '../../src/daemon/capability-handshake.js';
import { isFooterBlock } from '../../src/daemon/studio-footer.js';

/**
 * SD2's dispatch layer driven over a STORE PORT with no native handle (#331).
 *
 * WHAT WAS BROKEN. All four mechanisms — footer, baton, delivery queue, release receipt — resolved
 * the run through a native handle, and `setStudioHost` built every one of them with no options, so
 * a host that reaches its store some other way had no seam to supply one. Post-PX0 that host IS the
 * product: the desktop app's main process deliberately never loads a native store. Measured against
 * the running app, `GET /v1/runs/:id` answered 200 with the full run while a tool call naming the
 * same id rendered `— no run —`; all fifteen studio paths did. §7 rows 1, 2, 3 and 12 did not
 * happen in the shipped product, and nothing errored — which is why unit coverage stayed green.
 *
 * THE PORT USED HERE IS DELIBERATELY HOSTILE. It exposes only the interface methods, hops a
 * microtask on every call, and round-trips every argument and result through JSON. Any handle,
 * live object or synchronous assumption that survived the seam would not survive that — which is
 * what makes "no native handle" a property of the test rather than a claim about it.
 */

let dir: string;
let db: Database.Database;

const A: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const B = { name: 'other-harness', version: '9.9.9' };
const HUMAN: Driver = { kind: 'human' };

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

/** Everything in and out crosses a wire. A live handle cannot. */
async function wire<T>(value: T): Promise<T> {
  await Promise.resolve();
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * The app's shape: an async port and nothing else. Built over the daemon's own binding so the two
 * arms below are provably reading ONE log — the difference under test is how they reach it, not
 * what is in it.
 */
function portOnly(source: RunsStore = sqliteRunsStore(db)): RunsStore {
  return {
    create: async (input) => wire(await source.create(input)),
    list: async (opts) => wire(await source.list(opts)),
    get: async (runId) => wire(await source.get(runId)),
    exists: async (runId) => wire(await source.exists(runId)),
    eventsSince: async (runId, since, limit) => wire(await source.eventsSince(runId, since, limit)),
    typedEvents: async (runId, query) => wire(await source.typedEvents!(runId, query)),
    unansweredEvents: async (runId, query) => wire(await source.unansweredEvents!(runId, query)),
    appendEvent: async (runId, input) => wire(await source.appendEvent!(runId, input)),
    subscribeEvents: (runId, listener) => source.subscribeEvents!(runId, listener),
    interruptTrigger: async (runId, caller) => wire(await source.interruptTrigger!(runId, caller)),
  };
}

/** The narrowest binding the interface allows: reads a run, and knows nothing else. */
function minimalPort(): RunsStore {
  const source = sqliteRunsStore(db);
  return {
    create: async (input) => wire(await source.create(input)),
    list: async (opts) => wire(await source.list(opts)),
    get: async (runId) => wire(await source.get(runId)),
    exists: async (runId) => wire(await source.exists(runId)),
    eventsSince: async (runId, since, limit) => wire(await source.eventsSince(runId, since, limit)),
  };
}

function install(options: { openDb?: () => Promise<Database.Database>; openStore?: () => Promise<RunsStore | undefined> }, caller = A.client): void {
  setFooterSource(createFooterSource({ ...options, caller: () => caller }));
  setBatonGate(createBatonGate({ ...options, caller: () => caller }));
  setDeliveryHooks(createDeliveryHooks({ ...options, caller: () => caller }));
  setReceiptDelivery(createReceiptDelivery({ ...options, caller: () => caller }));
}

const handleArm = { openDb: async () => db };
const portArm = { openStore: async () => portOnly() };

function footerOf(r: McpToolResult): string {
  expect(isFooterBlock(r.content[1]), 'every studio result carries a footer block').toBe(true);
  return r.content[1]!.text;
}

const body = (r: McpToolResult): Record<string, unknown> => JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

function asClient(client: { name: string; version: string } | undefined, call: () => Promise<McpToolResult>): Promise<McpToolResult> {
  return withClientProfile(profileClient(client), call);
}

/** A run with something in every always-present footer field, plus the two conditionals. */
function seededRun(): string {
  const run = createRunWithTail(db, { task: 'compare two monitors', driver: A });
  appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 't1' } });
  appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 't2' } });
  appendRunEventWithTail(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 3 } });
  appendRunEventWithTail(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'spend_usd', amount: 0.25 } });
  appendRunEventWithTail(db, run.id, { actor: { kind: 'human' }, type: 'snapshot.invalidated', payload: { by: 'human', cause: 'input', tabId: 't1' } });
  appendRunEventWithTail(db, run.id, {
    actor: { kind: 'daemon' },
    type: 'decision.requested',
    payload: { decisionId: 'd1', kind: 'approval', prompt: 'Allow the purchase of one monitor?' },
  });
  return run.id;
}

const headOf = (runId: string): number => getRun(db, runId)!.lastSeq;

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-dispatch-port-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
});

afterEach(() => {
  setFooterSource(undefined);
  setBatonGate(undefined);
  setDeliveryHooks(undefined);
  setReceiptDelivery(undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('one run, one log, two ways in — the footer cannot tell them apart', () => {
  it('renders byte-identical footers over a native handle and over a port alone', async () => {
    const runId = seededRun();
    // `studio_marks` is a read that appends nothing, so the log the second arm sees is the log the
    // first one saw. The head is asserted below rather than assumed — an arm that wrote would have
    // handed the next arm a different run, and "identical" would then be measuring nothing.
    const head = headOf(runId);
    const call = (): Promise<McpToolResult> => asClient(A.client, () => dispatchStudioTool('studio_marks', { run_id: runId }, host(), dir));

    install(handleArm);
    const overHandle = await call();
    install(portArm);
    const overPort = await call();
    // Order reversed: if either arm warmed something for the other, this third render would differ.
    install(handleArm);
    const handleAgain = await call();

    expect(headOf(runId), 'a read must not have written to the log').toBe(head);
    expect(footerOf(overPort)).toBe(footerOf(overHandle));
    expect(footerOf(handleAgain)).toBe(footerOf(overPort));
    expect(overPort.content[0]).toEqual(overHandle.content[0]);
  });

  it('renders the §4.2 run-bearing footer over the port, where the shipped app rendered — no run —', async () => {
    const runId = seededRun();

    // The measured defect, reproduced: a host with no way to supply its store renders this for a
    // run id the REST surface answers 200 for.
    const inert = await asClient(A.client, () => dispatchStudioTool('studio_marks', { run_id: runId }, host(), dir));
    expect(footerOf(inert)).toBe('— no run —');

    install(portArm);
    const live = footerOf(await asClient(A.client, () => dispatchStudioTool('studio_marks', { run_id: runId }, host(), dir)));

    expect(live).toContain(`— run ${runId} · driver cli (claude-code) · tab 2 —`);
    expect(live).toContain('page changed: yes');
    expect(live).toContain('approval: Allow the purchase of one monitor?');
    expect(live).toContain('cost so far: $0.25 · 3 browser actions');
    expect(live).toContain(`watch: wigolo.studio/r/${runId}`);
  });
});

describe('the other three mechanisms, over the port alone', () => {
  it('refuses an act from a client that is not driving (§7 row 12)', async () => {
    const runId = seededRun();
    install(portArm, B);

    const refused = await asClient(B, () => dispatchStudioTool('studio_act', { run_id: runId, action: 'click', ref: 'e1' }, host(), dir));

    expect(refused.isError).toBe(true);
    expect(body(refused).error_reason).toBe('not_the_driver');
    // The refusal still names the run and the watch link — a refused observer needs those more.
    expect(footerOf(refused)).toContain(`— run ${runId}`);
  });

  it('rides a queued human message out on the next result, and counts it in the footer (§3.2)', async () => {
    const runId = seededRun();
    const queued = queueMessage(db, runId, { text: 'buy the cheaper one' });
    expect(queued.ok).toBe(true);
    install(portArm);

    const carried = await asClient(A.client, () => dispatchStudioTool('studio_marks', { run_id: runId }, host(), dir));

    const messages = body(carried).human_messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe('buy the cheaper one');
    expect(messages[0]!.state).toBe('delivered');
    expect(messages[0]!.state_line).toContain('delivered at step');
    expect(footerOf(carried)).toContain('human msgs: 1');
    // Law 1: the delivery is in the log, not in a counter this process kept.
    expect(eventsOfTypes(db, runId, { types: ['message.delivered'], limit: 10, newestFirst: true })).toHaveLength(1);
  });

  it('hands a stranded driver its release receipt (§7 row 3)', async () => {
    const runId = seededRun();
    releaseWheel(db, runId, { by: A, reason: 'handing over' });
    install(portArm);

    const receipted = await asClient(A.client, () => dispatchStudioTool('studio_marks', { run_id: runId }, host(), dir));

    const receipt = body(receipted).released as Record<string, unknown>;
    expect(receipt).toBeDefined();
    expect(String(receipt.text)).toContain(`wigolo.studio/r/${runId}`);
    expect(String(receipt.text)).toContain('nothing to poll');
    // Once, and only once: the second call is owed nothing.
    const again = await asClient(A.client, () => dispatchStudioTool('studio_marks', { run_id: runId }, host(), dir));
    expect(body(again).released).toBeUndefined();
  });
});

describe('a binding that implements less degrades, and never fails a call', () => {
  it('still renders every field the run projection alone can answer', async () => {
    const runId = seededRun();
    install({ openStore: async () => minimalPort() });

    const result = await asClient(A.client, () => dispatchStudioTool('studio_marks', { run_id: runId }, host(), dir));
    const footer = footerOf(result);

    expect(result.isError).toBeFalsy();
    expect(footer).toContain(`— run ${runId} · driver cli (claude-code) · tab 2 —`);
    expect(footer).toContain('cost so far: $0.25 · 3 browser actions');
    expect(footer).toContain(`watch: wigolo.studio/r/${runId}`);
    expect(footer).toContain('approval: Allow the purchase of one monitor?');
    // The two lines that need a typed read are absent rather than guessed at.
    expect(footer).not.toContain('page changed');
    expect(footer).not.toContain('human msgs');
  });

  it('leaves a queued message queued rather than marking it delivered into nowhere', async () => {
    const runId = seededRun();
    queueMessage(db, runId, { text: 'stop' });
    install({ openStore: async () => minimalPort() });

    const result = await asClient(A.client, () => dispatchStudioTool('studio_marks', { run_id: runId }, host(), dir));

    expect(body(result).human_messages).toBeUndefined();
    expect(eventsOfTypes(db, runId, { types: ['message.delivered'], limit: 10, newestFirst: true })).toHaveLength(0);
  });

  it('refuses to park a run it could never wake, instead of hanging on it (law 7)', async () => {
    const runId = seededRun();
    install({ openStore: async () => minimalPort() });

    const parked = await asClient(A.client, () => dispatchStudioTool(
      'studio_act',
      { run_id: runId, action: 'wait_for_human', reason: 'which monitor?' },
      host(),
      dir,
    ));

    expect(parked.isError).toBe(true);
    expect(body(parked).error_reason).toBe('wait_unsupported');
    // Nothing was written: a log that claimed a wait nobody kept would outlive the refusal.
    expect(eventsOfTypes(db, runId, { types: ['delivery.wait_requested'], limit: 10, newestFirst: true })).toHaveLength(0);
  });

  it('a host that supplies neither a handle nor a port degrades exactly as it did before', async () => {
    const runId = seededRun();
    install({ openStore: async () => undefined });

    const result = await asClient(A.client, () => dispatchStudioTool('studio_marks', { run_id: runId }, host(), dir));

    expect(result.isError).toBeFalsy();
    expect(footerOf(result)).toBe('— no run —');
    expect(body(result).human_messages).toBeUndefined();
  });
});

describe('the human takeover receipt over the port (§7 row 2)', () => {
  it('returns interrupted: human took control to the driver that lost the wheel', async () => {
    const runId = seededRun();
    install(portArm);
    // The takeover goes through the baton so the log carries the row the interrupt scan reads.
    const { takeWheel } = await import('../../src/daemon/driver-baton.js');
    expect(takeWheel(db, runId, { by: HUMAN, reason: 'I will finish this' }).ok).toBe(true);

    const interrupted = await asClient(A.client, () => dispatchStudioTool('studio_marks', { run_id: runId }, host(), dir));

    expect(body(interrupted).interrupted).toBe(true);
    expect(body(interrupted).reason).toBe('human took control');
    expect(body(interrupted).detail).toBe('I will finish this');
  });
});
