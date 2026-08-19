/**
 * G3 — does the safety envelope hold? The exit gate for S13-2, and the only one that can fail
 * catastrophically.
 *
 * The runner is driven against the **real** `createActHandler`, because §5.1's whole claim is that a
 * replay is a CALLER of that handler and therefore inherits its gates rather than re-implementing them.
 * A test that injected a fake act handler could not tell the difference between inheriting a gate and
 * having none — which is why the unit arm and this file are both needed and neither is sufficient.
 *
 * Every row asserts the gate fired AND that the page was never touched: the channel's `dispatchAgentUnit`
 * is counted, so "refused" and "refused after doing it anyway" cannot be confused.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { createActHandler, type ActControlToken } from '../../src/studio/act.js';
import { runFlow } from '../../src/studio/flow/run.js';
import type { FlowStep, FlowTargetSeed } from '../../src/studio/flow/store.js';
import type { HealCandidate } from '../../src/studio/mark/heal.js';
import { SessionAuditLog } from '../../src/studio/audit.js';
import { PreGrantStore } from '../../src/studio/pre-grant.js';
import { OriginBudget } from '../../src/studio/origin-budget.js';
import { computeFingerprint } from '../../src/studio/perception/id.js';
import type { NavGrant } from '../../src/studio/nav-policy.js';
import type { FieldSemantics } from '../../src/studio/credential.js';
import type { StudioActInput } from '../../src/daemon/studio-dispatch.js';

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

const allowGrant: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: true };

function seed(over: Partial<FlowTargetSeed> = {}): FlowTargetSeed {
  const role = over.role ?? 'button';
  const name = over.name ?? 'Next page';
  const attrs = over.attrs ?? { type: 'button' };
  return {
    role,
    name,
    fingerprint: over.fingerprint ?? computeFingerprint({ role, name, attrs }),
    ancestorPath: over.ancestorPath ?? 'html/body/main/nav',
    attrs,
  };
}

function step(over: Partial<FlowStep> = {}): FlowStep {
  return {
    flowId: 'flw_g3', sessionId: 'g3', seq: 1, auditSeq: 1, action: 'click',
    pageUrl: 'https://shop.example.com/cart', target: seed(), recordedRef: 'e-rec',
    healTierAtRecord: 'high', ts: 1, ...over,
  };
}

function candidates(over: Partial<FlowTargetSeed> = {}): HealCandidate[] {
  const s = seed(over);
  return [{ ref: 'e-live', target: { ...s, backendNodeId: 42, trusted: false } }];
}

interface Rig {
  act: (input: StudioActInput) => Promise<unknown>;
  /** Units the input channel was actually asked to dispatch — the page-touching count. */
  dispatches: number;
  parked: string[];
  auditCount: () => number;
  setHolder: (h: 'agent' | 'human') => void;
}

function rig(opts: {
  semantics?: FieldSemantics;
  currentUrl?: string;
  preGrant?: PreGrantStore;
  driveGate?: boolean;
  approvalSurfaceAttached?: boolean;
  isAuthenticatedOrigin?: boolean;
  db?: Database.Database;
} = {}): Rig {
  const db = opts.db ?? migratedDb();
  const sessionId = 'g3';
  const state = { holder: 'agent' as 'agent' | 'human', epoch: 0, dispatches: 0 };
  const parked: string[] = [];
  const controlToken: ActControlToken = {
    get holder() { return state.holder; },
    get epoch() { return state.epoch; },
    assertCanDrive: (p) =>
      p === state.holder ? { ok: true } : { ok: false, reason: 'not_holder', currentEpoch: state.epoch },
  } as ActControlToken;
  const audit = new SessionAuditLog({ db, sessionId, now: () => 1000 });
  const act = createActHandler({
    browser: { navigate: async () => {} },
    controlToken,
    grant: allowGrant,
    resolve: async () => ({
      backendNodeId: 42, center: { x: 10, y: 10 }, role: 'button', name: 'Next page',
      ...(opts.semantics ? { semantics: opts.semantics } : {}),
    }) as never,
    channel: {
      dispatchAgentUnit: async () => { state.dispatches += 1; return true; },
      viewportCenter: () => ({ x: 400, y: 300 }),
    },
    audit,
    ...(opts.currentUrl !== undefined ? { currentUrl: () => opts.currentUrl } : {}),
    ...(opts.preGrant ? { preGrant: opts.preGrant } : {}),
    ...(opts.driveGate
      ? {
          driveGate: {
            budget: new OriginBudget({}),
            isAuthenticatedOrigin: () => opts.isAuthenticatedOrigin === true,
            approvalSurfaceAttached: () => opts.approvalSurfaceAttached === true,
          },
        }
      : {}),
    park: (item) => { parked.push(String(item.action)); },
  });
  return {
    act: act as unknown as Rig['act'],
    get dispatches() { return state.dispatches; },
    parked,
    auditCount: () => (db.prepare('SELECT COUNT(*) AS n FROM studio_audit').get() as { n: number }).n,
    setHolder: (h) => { state.holder = h; state.epoch += 1; },
  };
}

describe('G3-b — a recording carries NO authorization; a risky step parks in a fresh session', () => {
  it('parks a risky replayed step against an EMPTY pre-grant store, and touches the page 0 times', async () => {
    // §5.2: a recording that could carry `approval:'pre-grant'` forward would be a durable, portable,
    // agent-readable authorization token for a destructive action. It cannot: the table has no such
    // column, so a replay meets the same gate a first run meets and gets the same answer.
    const r = rig({ currentUrl: 'https://shop.example.com/checkout/delete-account', preGrant: new PreGrantStore() });
    const out = await runFlow({
      steps: [step({ action: 'click', target: seed({ name: 'Delete account' }) })],
      act: r.act as never,
      candidates: async () => candidates({ name: 'Delete account' }),
    });
    expect(out.ok).toBe(false);
    expect(out.halt?.reason).toBe('act_refused');
    expect(out.halt?.detail).toBe('parked_for_review');
    expect(r.parked).toHaveLength(1);
    expect(r.dispatches).toBe(0);
  });
});

describe('G3-c — a replayed type onto a credential field is refused', () => {
  it('refuses with credential_field_refused and types 0 times', async () => {
    // The refusal is the act handler's, decided on TRUE pierced-DOM semantics before focus. The runner
    // gets it by being a caller — it neither re-implements nor can bypass it.
    const r = rig({ semantics: { tag: 'input', type: 'password' } as FieldSemantics, currentUrl: 'https://shop.example.com/settings' });
    const out = await runFlow({
      steps: [step({ action: 'type', slot: 'pw', target: seed({ role: 'textbox', name: 'Password' }) })],
      act: r.act as never,
      candidates: async () => candidates({ role: 'textbox', name: 'Password' }),
      values: { pw: 'hunter2' },
    });
    expect(out.halt).toMatchObject({ atSeq: 1, reason: 'act_refused', detail: 'credential_field_refused' });
    expect(r.dispatches).toBe(0);
  });

  it('does not leak the slot value into the audit on a refusal', async () => {
    const db = migratedDb();
    const r = rig({ semantics: { tag: 'input', type: 'password' } as FieldSemantics, currentUrl: 'https://shop.example.com/settings', db });
    await runFlow({
      steps: [step({ action: 'type', slot: 'pw', target: seed({ role: 'textbox', name: 'Password' }) })],
      act: r.act as never,
      candidates: async () => candidates({ role: 'textbox', name: 'Password' }),
      values: { pw: 'SENTINEL_VALUE_9f2a' },
    });
    const rows = JSON.stringify(db.prepare('SELECT * FROM studio_audit').all());
    expect(rows).not.toContain('SENTINEL_VALUE_9f2a');
  });
});

describe('G3-d — unattended, on an authenticated origin, refuses immediately', () => {
  it('refuses without touching the page when no approval surface is attached', async () => {
    // §5.5: the policy is already written and S13 must not write a second one. An UNKNOWN attachment
    // state counts as unattended, so this fails closed in milliseconds rather than hanging on a card.
    const r = rig({
      driveGate: true, isAuthenticatedOrigin: true, approvalSurfaceAttached: false,
      currentUrl: 'https://app.example.com/dash',
    });
    const out = await runFlow({
      steps: [step({ seq: 1, action: 'navigate', pageUrl: 'https://app.example.com/dash', target: undefined })],
      act: r.act as never,
      candidates: async () => [],
    });
    expect(out.ok).toBe(false);
    expect(out.halt?.reason).toBe('act_refused');
    expect(r.dispatches).toBe(0);
  });

  it('the runner sets no approvalSurfaceAttached and passes no isAuthenticatedOrigin of its own (T12)', () => {
    // Asserted on the source, because the failure would be the runner ARGUING it is attended.
    const src = readFileSync('src/studio/flow/run.ts', 'utf-8');
    expect(src).not.toMatch(/approvalSurfaceAttached/);
    expect(src).not.toMatch(/isAuthenticatedOrigin/);
    expect(src).not.toMatch(/preGrant/);
  });
});

describe('G3-i — a human reclaim between steps drops the next step', () => {
  it('halts as not_holder and dispatches nothing further', async () => {
    const r = rig({ currentUrl: 'https://shop.example.com/cart' });
    let n = 0;
    const out = await runFlow({
      steps: [step({ seq: 1 }), step({ seq: 2 }), step({ seq: 3 })],
      act: r.act as never,
      candidates: async () => {
        // The human takes the wheel between step 1 and step 2.
        if (++n === 2) r.setHolder('human');
        return candidates();
      },
    });
    expect(out.dispatched.map((d) => d.seq)).toEqual([1]);
    expect(out.halt).toMatchObject({ atSeq: 2, reason: 'act_refused' });
    expect(r.dispatches).toBe(1);
  });
});

describe('G3-j — a replay is as forensically visible as a first run', () => {
  it('writes exactly one audit row per dispatched step', async () => {
    const r = rig({ currentUrl: 'https://shop.example.com/cart' });
    const out = await runFlow({
      steps: [
        step({ seq: 1, action: 'navigate', pageUrl: 'https://shop.example.com/cart', target: undefined }),
        step({ seq: 2, action: 'click' }),
        step({ seq: 3, action: 'scroll', direction: 'down', amount: 200, target: undefined }),
      ],
      act: r.act as never,
      candidates: async () => candidates(),
    });
    expect(out.ok).toBe(true);
    expect(r.auditCount()).toBe(3);
  });

  it('writes an audit row even for a step the gate REFUSED — a refusal is forensic too', async () => {
    const r = rig({ currentUrl: 'https://shop.example.com/checkout/delete-account', preGrant: new PreGrantStore() });
    await runFlow({
      steps: [step({ target: seed({ name: 'Delete account' }) })],
      act: r.act as never,
      candidates: async () => candidates({ name: 'Delete account' }),
    });
    expect(r.auditCount()).toBe(1);
  });
});

describe('G3-k — risk is re-classified from the live page, never read from the recording', () => {
  it('classifies the SAME recorded step differently when the live URL differs', async () => {
    // The decisive shape: one step, two runs, two verdicts. A runner reading a stored verdict would
    // produce the same answer twice — and `classifyRisk` weights the host-observed live URL first, so a
    // stored verdict from a previous page is not evidence about this one.
    const risky = rig({ currentUrl: 'https://shop.example.com/checkout/delete-account', preGrant: new PreGrantStore() });
    const benign = rig({ currentUrl: 'https://shop.example.com/products', preGrant: new PreGrantStore() });
    const s = [step({ target: seed({ name: 'Delete account' }) })];

    const a = await runFlow({ steps: s, act: risky.act as never, candidates: async () => candidates({ name: 'Delete account' }) });
    const b = await runFlow({ steps: s, act: benign.act as never, candidates: async () => candidates({ name: 'Delete account' }) });

    expect(a.ok).toBe(false);
    expect(a.halt?.detail).toBe('parked_for_review');
    expect(b.ok).toBe(true);
    expect(benign.dispatches).toBe(1);
    expect(risky.dispatches).toBe(0);
  });
});
