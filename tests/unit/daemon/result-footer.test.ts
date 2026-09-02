import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { appendRunEventWithTail, createRunWithTail } from '../../../src/studio/run-bus.js';
import { eventsSince, type Driver, type Run } from '../../../src/studio/run-store.js';
import { createFooterSource, SNAPSHOT_INVALIDATED, SNAPSHOT_READ, ASSERTION_FAILED } from '../../../src/daemon/result-footer.js';
import { renderFooter } from '../../../src/daemon/studio-footer.js';
import { queueMessage, deliverMessages } from '../../../src/daemon/message-queue.js';
import type { FooterContext, McpToolResult } from '../../../src/daemon/studio-dispatch.js';

/**
 * SD2 §4.2 — every footer field is a PROJECTION of the run log (#56's acceptance criterion: "no
 * parallel bookkeeping anywhere in the result assembler"). Each row here changes the LOG and then
 * reads the footer: if a field could be satisfied any other way, the log-only change would not move
 * it.
 */

let dir: string;
let db: Database.Database;

const CLI: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const ok: McpToolResult = { content: [{ type: 'text', text: '{}' }], isError: false };

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-result-footer-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const source = () => createFooterSource({ openDb: async () => db, caller: () => CLI.client });

function newRun(driver: Driver = CLI): Run {
  return createRunWithTail(db, { task: 'compare two monitors', driver });
}

async function begin(run: Run, tool = 'studio_observe'): Promise<FooterContext> {
  const ctx = await source().begin(tool, { run_id: run.id });
  expect(ctx, 'the footer source did not resolve the run').toBeDefined();
  return ctx!;
}

async function footerFor(run: Run, tool = 'studio_observe'): Promise<string> {
  return renderFooter(await (await begin(run, tool)).fields(), 'generic');
}

describe('the always-present fields come off the Run projection', () => {
  it('run id, driver badge and tab count — the same driver string REST and the event stream mint', async () => {
    const run = newRun();
    appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 't1' } });
    appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 't2' } });

    const footer = await footerFor(run);
    expect(footer.split('\n')[0]).toBe(`— run ${run.id} · driver cli (claude-code) · tab 2 —`);
  });

  it('the driver line MOVES when the baton moves — it is read, never remembered', async () => {
    const run = newRun();
    expect(await footerFor(run)).toContain('driver cli (claude-code)');

    appendRunEventWithTail(db, run.id, {
      actor: { kind: 'human' },
      type: 'driver.changed',
      payload: { to: { kind: 'human', name: 'human' }, cause: 'takeover' },
    });
    expect(await footerFor(run)).toContain('driver human');
  });

  it('an unknown run resolves to no context at all — the footer says `— no run —` rather than guessing', async () => {
    expect(await source().begin('studio_observe', { run_id: 'zzzz' })).toBeUndefined();
    expect(await source().begin('studio_observe', {})).toBeUndefined();
  });
});

describe('cost so far — the log\'s own aggregate, never a tally kept beside it', () => {
  it('counts recorded browser actions and BYOK spend', async () => {
    const run = newRun();
    for (const kind of ['browser_action', 'browser_action', 'browser_action']) {
      appendRunEventWithTail(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind, amount: 1 } });
    }
    appendRunEventWithTail(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'spend_usd', amount: 0.25 } });

    expect(await footerFor(run)).toContain('cost so far: $0.25 · 3 browser actions');
  });

  it('is $0.00 and 0 actions on a run that has recorded nothing — honest, never fabricated', async () => {
    expect(await footerFor(newRun())).toContain('cost so far: $0.00 · 0 browser actions');
  });

  it('includes what THIS call appended — the fields are read at the exit, not at entry', async () => {
    const run = newRun();
    const ctx = await begin(run);
    appendRunEventWithTail(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    expect(renderFooter(await ctx.fields(), 'generic')).toContain('1 browser actions');
  });
});

describe('human msgs — what THIS result delivers, not what the run has ever carried', () => {
  it('counts the message.delivered rows appended above the head at entry', async () => {
    const run = newRun();
    queueMessage(db, run.id, { text: 'buy the cheaper one' });
    // Delivered on an EARLIER call: already below the next call's entry head.
    deliverMessages(db, run.id, { via: 'piggyback' });
    expect(await footerFor(run)).not.toContain('human msgs');

    const ctx = await begin(run);
    queueMessage(db, run.id, { text: 'actually, the other one' });
    deliverMessages(db, run.id, { via: 'piggyback' });
    expect(renderFooter(await ctx.fields(), 'generic')).toContain('human msgs: 1');
  });

  it('the line is absent when the call delivered nothing', async () => {
    expect(await footerFor(newRun())).not.toContain('human msgs');
  });
});

describe('page changed — an invalidation NEWER than the driver\'s last read (§4.2/§5)', () => {
  it('is silent until a human edit lands', async () => {
    expect(await footerFor(newRun())).not.toContain('page changed');
  });

  it('announces after a snapshot.invalidated, in §7 row 1\'s words', async () => {
    const run = newRun();
    appendRunEventWithTail(db, run.id, { actor: { kind: 'human' }, type: SNAPSHOT_INVALIDATED, payload: { by: 'human', cause: 'input', tabId: 't1' } });
    expect(await footerFor(run)).toContain('page changed: yes — page changed by human — re-read');
  });

  it('the ANNOUNCING result still carries the line — settle records the re-read after the render', async () => {
    const run = newRun();
    appendRunEventWithTail(db, run.id, { actor: { kind: 'human' }, type: SNAPSHOT_INVALIDATED, payload: { by: 'human', cause: 'input' } });

    const ctx = await begin(run, 'studio_observe');
    expect(renderFooter(await ctx.fields(), 'generic')).toContain('page changed: yes');
    await ctx.settle?.(ok);

    expect(eventsSince(db, run.id, 0, 100).map((e) => e.type)).toContain(SNAPSHOT_READ);
    expect(await footerFor(run)).not.toContain('page changed');
  });

  it('a re-read is recorded AT MOST ONCE per invalidation — an observe loop on an untouched page writes nothing', async () => {
    const run = newRun();
    appendRunEventWithTail(db, run.id, { actor: { kind: 'human' }, type: SNAPSHOT_INVALIDATED, payload: { by: 'human', cause: 'input' } });

    for (let i = 0; i < 4; i++) await (await begin(run, 'studio_observe')).settle?.(ok);

    const reads = eventsSince(db, run.id, 0, 100).filter((e) => e.type === SNAPSHOT_READ);
    expect(reads).toHaveLength(1);
  });

  it('only the READ verb clears it — acting on a page the human edited is not re-reading it', async () => {
    const run = newRun();
    appendRunEventWithTail(db, run.id, { actor: { kind: 'human' }, type: SNAPSHOT_INVALIDATED, payload: { by: 'human', cause: 'input' } });

    await (await begin(run, 'studio_act')).settle?.(ok);
    expect(eventsSince(db, run.id, 0, 100).map((e) => e.type)).not.toContain(SNAPSHOT_READ);
    expect(await footerFor(run, 'studio_act')).toContain('page changed: yes');
  });

  it('a FAILED read does not clear it — the agent did not get the page', async () => {
    const run = newRun();
    appendRunEventWithTail(db, run.id, { actor: { kind: 'human' }, type: SNAPSHOT_INVALIDATED, payload: { by: 'human', cause: 'input' } });

    await (await begin(run, 'studio_observe')).settle?.({ content: [{ type: 'text', text: '{}' }], isError: true });
    expect(await footerFor(run)).toContain('page changed: yes');
  });

  it('a SECOND human edit after a re-read announces again', async () => {
    const run = newRun();
    appendRunEventWithTail(db, run.id, { actor: { kind: 'human' }, type: SNAPSHOT_INVALIDATED, payload: { by: 'human', cause: 'input' } });
    await (await begin(run)).settle?.(ok);
    expect(await footerFor(run)).not.toContain('page changed');

    appendRunEventWithTail(db, run.id, { actor: { kind: 'human' }, type: SNAPSHOT_INVALIDATED, payload: { by: 'human', cause: 'navigation' } });
    expect(await footerFor(run)).toContain('page changed: yes');
  });
});

describe('approval — the run\'s oldest blocking decision, and only while it blocks', () => {
  it('carries the pending prompt, and drops it once the decision resolves', async () => {
    const run = newRun();
    appendRunEventWithTail(db, run.id, {
      actor: { kind: 'daemon' },
      type: 'decision.requested',
      payload: { decisionId: 'd1', kind: 'approval', prompt: 'Allow the purchase?' },
    });
    expect(await footerFor(run)).toContain('approval: Allow the purchase? — resolve from any surface, or answer here');

    appendRunEventWithTail(db, run.id, { actor: { kind: 'human' }, type: 'decision.resolved', payload: { decisionId: 'd1', verdict: 'allow' } });
    expect(await footerFor(run)).not.toContain('approval:');
  });
});

describe('assertion failed — the reserved SD6 slot', () => {
  it('renders nothing today, because nothing writes the rows — never a fabricated verdict', async () => {
    expect(await footerFor(newRun())).not.toContain('assertion failed');
  });

  it('renders the failing assertion the moment a producer writes one, with no grammar change', async () => {
    const run = newRun();
    appendRunEventWithTail(db, run.id, { actor: { kind: 'system' }, type: ASSERTION_FAILED, payload: { which: 'price is visible' } });
    expect(await footerFor(run)).toContain('assertion failed: price is visible');
  });
});
