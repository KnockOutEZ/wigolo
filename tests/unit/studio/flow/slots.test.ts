/**
 * S13-3 — parameterised `type` slots, and the boundary they have to hold (G4).
 *
 * A slot is a NAME the recording stores and a VALUE the caller supplies per run. The recording cannot
 * leak what it never held, and the value must not become durable on its way through: not in the sidecar,
 * not in an artifact, not in the audit, not in a log line.
 *
 * The two structural cases are separated on purpose. **Missing slots are refused PRE-FLIGHT**, before any
 * step dispatches, for the same reason the step ceiling is: halting at the type step would leave the
 * earlier steps already executed — a partial sequence run against a live site. Knowing beforehand and
 * refusing beforehand is strictly better than discovering it midway.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../../src/cache/migrations/runner.js';
import { runFlow, requiredSlots } from '../../../../src/studio/flow/run.js';
import { insertFlowStep, listFlowSteps } from '../../../../src/studio/flow/store.js';
import type { FlowStep, FlowTargetSeed } from '../../../../src/studio/flow/store.js';
import type { HealCandidate } from '../../../../src/studio/mark/heal.js';
import { computeFingerprint } from '../../../../src/studio/perception/id.js';
import type { StudioActInput } from '../../../../src/daemon/studio-dispatch.js';

const SENTINEL = 'SLOT_SENTINEL_7c41e9';

function seed(over: Partial<FlowTargetSeed> = {}): FlowTargetSeed {
  const role = over.role ?? 'textbox';
  const name = over.name ?? 'Search orders';
  const attrs = over.attrs ?? { type: 'text' };
  return {
    role,
    name,
    fingerprint: over.fingerprint ?? computeFingerprint({ role, name, attrs }),
    ancestorPath: over.ancestorPath ?? 'html/body/main/form',
    attrs,
  };
}

function step(over: Partial<FlowStep> = {}): FlowStep {
  return {
    flowId: 'flw_slots', sessionId: 's1', seq: 1, auditSeq: 1, action: 'type',
    pageUrl: 'https://ex.com/orders', target: seed(), recordedRef: 'e-rec',
    healTierAtRecord: 'high', slot: 'search_orders', ts: 1, ...over,
  };
}

function candidates(over: Partial<FlowTargetSeed> = {}): HealCandidate[] {
  const s = seed(over);
  return [{ ref: 'e-live', target: { ...s, backendNodeId: 7, trusted: false } }];
}

function fakeAct() {
  const calls: StudioActInput[] = [];
  return {
    calls,
    act: async (input: StudioActInput) => { calls.push(input); return { ok: true } as never; },
  };
}

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

describe('requiredSlots — what a caller must supply before a flow can run', () => {
  it('lists the type steps\' slots in seq order', () => {
    expect(requiredSlots([
      step({ seq: 1, slot: 'query' }),
      step({ seq: 2, action: 'click', slot: undefined, target: seed({ role: 'button' }) }),
      step({ seq: 3, slot: 'city' }),
    ])).toEqual(['query', 'city']);
  });

  it('de-duplicates a slot used by two steps — one name is one parameter', () => {
    // Two fields that take the same value are one question to the caller, not two.
    expect(requiredSlots([step({ seq: 1, slot: 'query' }), step({ seq: 2, slot: 'query' })])).toEqual(['query']);
  });

  it('is empty for a flow with no type steps, so such a flow needs no values at all', () => {
    expect(requiredSlots([step({ action: 'click', slot: undefined, target: seed({ role: 'button' }) })])).toEqual([]);
  });

  it('reads seq order, not array order', () => {
    expect(requiredSlots([step({ seq: 2, slot: 'second' }), step({ seq: 1, slot: 'first' })])).toEqual(['first', 'second']);
  });
});

describe('slot values are validated PRE-FLIGHT, never discovered mid-run (G4)', () => {
  it('refuses before dispatching anything when a required slot has no value', async () => {
    // The point of the pre-flight. Halting at the type step would leave step 1 already executed against
    // a live site — a partial sequence, which is the hazard the ceiling refusal exists to avoid too.
    const f = fakeAct();
    const r = await runFlow({
      steps: [
        step({ seq: 1, action: 'navigate', pageUrl: 'https://ex.com/orders', target: undefined, slot: undefined }),
        step({ seq: 2, slot: 'query' }),
      ],
      act: f.act,
      candidates: async () => candidates(),
    });
    expect(r.ok).toBe(false);
    expect(r.halt).toEqual({ atSeq: 0, reason: 'slot_unfilled', detail: 'query' });
    expect(f.calls).toHaveLength(0); // step 1 was NOT executed
  });

  it('names EVERY missing slot, not just the first — one round trip tells the caller everything', async () => {
    const f = fakeAct();
    const r = await runFlow({
      steps: [step({ seq: 1, slot: 'query' }), step({ seq: 2, slot: 'city' })],
      act: f.act,
      candidates: async () => candidates(),
      values: {},
    });
    expect(r.halt?.detail).toBe('query, city');
    expect(f.calls).toHaveLength(0);
  });

  it('runs when every slot is supplied, passing each value to its own step', async () => {
    const f = fakeAct();
    const r = await runFlow({
      steps: [step({ seq: 1, slot: 'query' }), step({ seq: 2, slot: 'city' })],
      act: f.act,
      candidates: async () => candidates(),
      values: { query: 'boots', city: 'Berlin' },
    });
    expect(r.ok).toBe(true);
    expect(f.calls.map((c) => c.text)).toEqual(['boots', 'Berlin']);
  });

  it('gives two steps sharing a slot the SAME value', async () => {
    const f = fakeAct();
    await runFlow({
      steps: [step({ seq: 1, slot: 'query' }), step({ seq: 2, slot: 'query' })],
      act: f.act,
      candidates: async () => candidates(),
      values: { query: 'boots' },
    });
    expect(f.calls.map((c) => c.text)).toEqual(['boots', 'boots']);
  });

  it('REFUSES a value supplied for a slot the flow does not have', async () => {
    // Fails loudly rather than ignoring it. A caller passing `querry` has misread the flow, and silently
    // running with the real slot unfilled would be the worst of both.
    const f = fakeAct();
    const r = await runFlow({
      steps: [step({ seq: 1, slot: 'query' })],
      act: f.act,
      candidates: async () => candidates(),
      values: { query: 'boots', querry: 'typo' },
    });
    expect(r.ok).toBe(false);
    expect(r.halt).toEqual({ atSeq: 0, reason: 'unknown_slot', detail: 'querry' });
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a malformed type step that carries no slot name at all', async () => {
    // The recorder always names a slot, so this is a corrupt or hand-written row rather than a normal
    // one — refused up front instead of dispatched with no value.
    const f = fakeAct();
    const r = await runFlow({
      steps: [step({ seq: 1, slot: undefined })],
      act: f.act,
      candidates: async () => candidates(),
      values: {},
    });
    expect(r.halt).toMatchObject({ atSeq: 1, reason: 'malformed_step' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('the slot boundary — a value never becomes durable (G4)', () => {
  it('leaves a unique sentinel value in NO table of the database after a run', async () => {
    // The row G4 states as "occurrences across the whole DB: exactly 0". Enumerated over every user
    // table rather than the ones I expect to matter — a search of the tables I thought of would prove
    // only that I thought of them.
    const db = migratedDb();
    const s = step({ seq: 1, slot: 'query' });
    insertFlowStep(db, s);
    const f = fakeAct();
    const r = await runFlow({
      steps: listFlowSteps(db, 'flw_slots'),
      act: f.act,
      candidates: async () => candidates(),
      values: { query: SENTINEL },
    });
    expect(r.ok).toBe(true);
    expect(f.calls[0]?.text).toBe(SENTINEL); // it DID reach the page — otherwise the search is vacuous

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map((t) => t.name);
    expect(tables.length).toBeGreaterThan(3);
    const hits: string[] = [];
    for (const t of tables) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all());
      if (rows.includes(SENTINEL)) hits.push(t);
    }
    expect(hits, `sentinel found in: ${hits.join(', ')}`).toEqual([]);
    db.close();
  });

  it('keeps the slot NAME durable while the value is not — the round trip through the store', async () => {
    // G4's third row asks for an export→import round trip. There is no export surface (flows are
    // deliberately not exportable until the shareability question is answered), so the same property is
    // measured at the boundary that DOES exist: the store's own write→read path. What that can and
    // cannot show is stated in the slice notes rather than left implied — an import path's handling is
    // NOT covered, because there is no import path.
    const db = migratedDb();
    insertFlowStep(db, step({ seq: 1, slot: 'search_orders' }));
    const read = listFlowSteps(db, 'flw_slots');
    expect(read).toHaveLength(1);
    expect(read[0]?.slot).toBe('search_orders');
    expect(JSON.stringify(read)).not.toContain(SENTINEL);
    // And the column set itself offers nowhere to put one.
    const cols = (db.prepare("PRAGMA table_info('studio_flow_steps')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('slot');
    expect(cols.some((c) => /text|value|input|content/i.test(c))).toBe(false);
    db.close();
  });

  it('does not retain or mutate the caller\'s values object', async () => {
    // Ephemeral means the runner holds no copy the caller cannot see the end of.
    const values = Object.freeze({ query: SENTINEL });
    const f = fakeAct();
    const r = await runFlow({
      steps: [step({ seq: 1, slot: 'query' })],
      act: f.act,
      candidates: async () => candidates(),
      values,
    });
    expect(r.ok).toBe(true);
    expect(values).toEqual({ query: SENTINEL });
    expect(JSON.stringify(r)).not.toContain(SENTINEL); // the RESULT carries no value either
  });

  it('carries no slot value in the run result even when a step is refused mid-flow', async () => {
    const calls: StudioActInput[] = [];
    const r = await runFlow({
      steps: [step({ seq: 1, slot: 'query' }), step({ seq: 2, slot: 'query' })],
      act: async (input) => {
        calls.push(input);
        return calls.length === 2 ? ({ error_reason: 'parked_for_review' } as never) : ({ ok: true } as never);
      },
      candidates: async () => candidates(),
      values: { query: SENTINEL },
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
});
