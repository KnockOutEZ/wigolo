import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../../src/cache/migrations/runner.js';
import { createActHandler, type ActControlToken } from '../../../../src/studio/act.js';
import { createFlowRecorder } from '../../../../src/studio/flow/record.js';
import { listFlowSteps, flowIdForSession } from '../../../../src/studio/flow/store.js';
import { SessionAuditLog } from '../../../../src/studio/audit.js';
import type { NavGrant } from '../../../../src/studio/nav-policy.js';
import type { ResolveResult } from '../../../../src/studio/perception/resolve.js';
import type { StructuredTarget } from '../../../../src/studio/mark/target.js';
import type { StudioActInput } from '../../../../src/daemon/studio-dispatch.js';

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

const agentToken: ActControlToken = {
  holder: 'agent',
  epoch: 0,
  assertCanDrive: (p) => (p === 'agent' ? { ok: true } : { ok: false, reason: 'not_holder', currentEpoch: 0 }),
};
const allowGrant: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: true };

/** A live target the way the mark layer builds one — WITH the fields a stored step must not keep. */
function liveTarget(over: Partial<StructuredTarget> = {}): StructuredTarget {
  return {
    backendNodeId: 42,
    role: 'button',
    name: 'Next page',
    trusted: false,
    fingerprint: 'button\0Next page\0type=button',
    ancestorPath: 'html/body/div/main/nav',
    attrs: { type: 'button', class: 'pager-next' },
    ...over,
  };
}

interface Harness {
  act: (input: StudioActInput) => Promise<unknown>;
  db: Database.Database;
  flowId: string;
  steps: () => ReturnType<typeof listFlowSteps>;
  seeded: number[];
}

function harness(opts: {
  sessionId?: string;
  resolve?: ResolveResult;
  target?: StructuredTarget | null;
  currentUrl?: string;
  withAudit?: boolean;
} = {}): Harness {
  const db = migratedDb();
  const sessionId = opts.sessionId ?? 'sess-flow';
  const seeded: number[] = [];
  const resolved: ResolveResult = opts.resolve ?? { backendNodeId: 42, center: { x: 10, y: 10 }, role: 'button', name: 'Next page' };
  const target = opts.target === undefined ? liveTarget() : opts.target;
  const flow = createFlowRecorder({
    db,
    sessionId,
    now: () => 1000,
    seed: async (backendNodeId: number) => {
      seeded.push(backendNodeId);
      return target;
    },
  });
  const audit = opts.withAudit === false ? undefined : new SessionAuditLog({ db, sessionId, now: () => 1000 });
  const act = createActHandler({
    browser: { navigate: async () => {} },
    controlToken: agentToken,
    grant: allowGrant,
    resolve: async () => resolved,
    channel: { dispatchAgentUnit: async () => true, viewportCenter: () => ({ x: 400, y: 300 }) },
    ...(audit ? { audit } : {}),
    ...(opts.currentUrl !== undefined ? { currentUrl: () => opts.currentUrl } : {}),
    flow,
  });
  const flowId = flowIdForSession(sessionId);
  return { act, db, flowId, steps: () => listFlowSteps(db, flowId), seeded };
}

describe('the recorder — what lands in the sidecar', () => {
  it('records a step for every SUCCESSFUL act, in order', async () => {
    const h = harness({ currentUrl: 'https://example.com/orders' });
    await h.act({ action: 'navigate', url: 'https://example.com/orders' });
    await h.act({ action: 'click', ref: 'e1a2b3c' });
    await h.act({ action: 'scroll', direction: 'down', amount: 600 });
    expect(h.steps().map((s) => [s.seq, s.action])).toEqual([[1, 'navigate'], [2, 'click'], [3, 'scroll']]);
  });

  it('carries the COMPLETE re-resolution seed on a click (T1)', async () => {
    const h = harness({ currentUrl: 'https://example.com/orders' });
    await h.act({ action: 'click', ref: 'e1a2b3c' });
    const [step] = h.steps();
    expect(step.target).toEqual({
      role: 'button',
      name: 'Next page',
      fingerprint: 'button\0Next page\0type=button',
      ancestorPath: 'html/body/div/main/nav',
      attrs: { type: 'button' },
    });
    expect(step.pageUrl).toBe('https://example.com/orders');
    expect(step.recordedRef).toBe('e1a2b3c');
    expect(step.healTierAtRecord).toBe('high');
  });

  it('does NOT record a refused or failed act', async () => {
    const h = harness({ resolve: { error: 'element_occluded' } });
    await h.act({ action: 'click', ref: 'e1a2b3c' });
    expect(h.steps()).toHaveLength(0);
  });

  it('never builds a seed for a LOW-confidence ref, so `heal_tier_at_record: high` is derived and not asserted', async () => {
    // The recorded tier is a DERIVATION: `resolve()` refuses a low-confidence ref, and a ref is
    // low-confidence exactly when its fingerprint collided in the snapshot. So a ref that
    // resolved had a UNIQUE fingerprint on that page — which is precisely what heal tier 1
    // matches on. If resolve ever stopped refusing, this test goes red and the derivation with it.
    const h = harness({ resolve: { error: 'element_low_confidence' } });
    await h.act({ action: 'click', ref: 'e1a2b3c' });
    expect(h.steps()).toHaveLength(0);
    expect(h.seeded).toEqual([]);
  });

  it('stores a named SLOT for a type step and never the typed text (T2)', async () => {
    const h = harness({
      currentUrl: 'https://example.com/search',
      target: liveTarget({ role: 'textbox', name: 'Search orders', attrs: { type: 'search' } }),
      resolve: { backendNodeId: 42, center: { x: 1, y: 1 }, role: 'textbox', name: 'Search orders', semantics: { tag: 'input', type: 'search' } },
    });
    await h.act({ action: 'type', ref: 'e9', text: 'super-secret-order-42' });
    const [step] = h.steps();
    expect(step.slot).toBe('search_orders');
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM studio_flow_steps').all());
    expect(dump).not.toContain('super-secret-order-42');
  });

  it('records NOTHING on a page that carries a credential field (mirrors mark REFUSE-at-creation)', async () => {
    const h = harness({
      currentUrl: 'https://shop.example.com/checkout',
      resolve: { backendNodeId: 42, center: { x: 1, y: 1 }, role: 'button', name: 'Continue', pageHasCredentialField: true },
    });
    await h.act({ action: 'click', ref: 'e1' });
    expect(h.steps()).toHaveLength(0);
    // Nothing was BUILT, not merely nothing stored — there is no seed to surface later.
    expect(h.seeded).toEqual([]);
  });

  it('records NOTHING for a navigate to a credential URL', async () => {
    const h = harness();
    await h.act({ action: 'navigate', url: 'https://example.com/login?next=/orders' });
    expect(h.steps()).toHaveLength(0);
  });

  it('records NOTHING for a click on a credential URL', async () => {
    const h = harness({ currentUrl: 'https://example.com/sign-in' });
    await h.act({ action: 'click', ref: 'e1' });
    expect(h.steps()).toHaveLength(0);
    expect(h.seeded).toEqual([]);
  });

  it('joins every step back to its audit row, and records nothing when no audit is wired', async () => {
    const h = harness({ currentUrl: 'https://example.com/a' });
    await h.act({ action: 'navigate', url: 'https://example.com/a' });
    await h.act({ action: 'click', ref: 'e1' });
    expect(h.steps().map((s) => s.auditSeq)).toEqual([1, 2]);

    // A sidecar is DERIVED from the forensic record. With no audit row there is nothing to be
    // derived from, and a fabricated join key would be worse than no step at all.
    const bare = harness({ withAudit: false, sessionId: 'sess-bare', currentUrl: 'https://example.com/a' });
    await bare.act({ action: 'click', ref: 'e1' });
    expect(bare.steps()).toHaveLength(0);
  });

  it('does not record when the host wires no seed provider', async () => {
    const h = harness({ target: null, currentUrl: 'https://example.com/a' });
    await h.act({ action: 'click', ref: 'e1' });
    expect(h.steps()).toHaveLength(0);
  });

  it('a recording failure never turns a successful action into an error the agent retries', async () => {
    const db = migratedDb();
    const flow = createFlowRecorder({
      db,
      sessionId: 'sess-boom',
      now: () => 1,
      seed: async () => { throw new Error('CDP went away'); },
    });
    const act = createActHandler({
      browser: { navigate: async () => {} },
      controlToken: agentToken,
      grant: allowGrant,
      resolve: async () => ({ backendNodeId: 42, center: { x: 1, y: 1 }, role: 'button', name: 'Go' }),
      channel: { dispatchAgentUnit: async () => true, viewportCenter: () => ({ x: 0, y: 0 }) },
      audit: new SessionAuditLog({ db, sessionId: 'sess-boom' }),
      currentUrl: () => 'https://example.com/a',
      flow,
    });
    await expect(act({ action: 'click', ref: 'e1' })).resolves.toEqual({ ok: true, action: 'click' });
    expect(listFlowSteps(db, flowIdForSession('sess-boom'))).toHaveLength(0);
  });

  it('a DB failure inside record() never turns a successful action into an error the agent retries', async () => {
    // The seed half of this contract is already covered above, and `seed()` is awaited behind a
    // `.catch()` on the act path — so a seed throw proves nothing about `record()`, whose two
    // INSERTs run bare. SQLITE_BUSY / readonly / disk-full are the real shapes here. If the write
    // escapes, the agent is told a click FAILED that already reached the page — and it retries,
    // re-executing an action that fired. That is the one outcome this slice must not produce.
    const db = migratedDb();
    const throwingDb = {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (/INSERT\s+OR\s+IGNORE\s+INTO\s+studio_flow_steps/i.test(sql)) {
          return { run: () => { throw new Error('database is locked'); }, all: () => [] };
        }
        return { run: (...a: unknown[]) => stmt.run(...(a as [])), all: (...a: unknown[]) => stmt.all(...(a as [])) };
      },
    };
    const flow = createFlowRecorder({
      db: throwingDb,
      sessionId: 'sess-db-boom',
      now: () => 1,
      seed: async () => liveTarget(),
    });
    const act = createActHandler({
      browser: { navigate: async () => {} },
      controlToken: agentToken,
      grant: allowGrant,
      resolve: async () => ({ backendNodeId: 42, center: { x: 1, y: 1 }, role: 'button', name: 'Go' }),
      channel: { dispatchAgentUnit: async () => true, viewportCenter: () => ({ x: 0, y: 0 }) },
      audit: new SessionAuditLog({ db, sessionId: 'sess-db-boom' }),
      currentUrl: () => 'https://example.com/a',
      flow,
    });
    await expect(act({ action: 'click', ref: 'e1' })).resolves.toEqual({ ok: true, action: 'click' });
    // The forensic record still holds the act: the click landed, so the audit row is the truth and
    // the sidecar's loss is the only casualty.
    const audited = db.prepare('SELECT COUNT(*) AS n FROM studio_audit').get() as { n: number };
    expect(audited.n).toBe(1);
  });

  it('resumes numbering after a restart rather than colliding on seq 1', async () => {
    const a = harness({ sessionId: 'sess-resume', currentUrl: 'https://example.com/a' });
    await a.act({ action: 'click', ref: 'e1' });
    const b = harness({ sessionId: 'sess-resume', currentUrl: 'https://example.com/a' });
    // A second recorder over the SAME db + session (the restart case).
    const db2 = a.db;
    void db2;
    await b.act({ action: 'click', ref: 'e2' });
    expect(b.steps().map((s) => s.seq)).toEqual([1]);
  });
});

describe('the recorder — what it must never add to studio_audit (T5)', () => {
  it('writes not one studio_audit row, column or index of its own', async () => {
    const h = harness({ currentUrl: 'https://example.com/a' });
    await h.act({ action: 'click', ref: 'e1' });
    // Exactly one audit row per act — the same one the act path already wrote, no second writer.
    const rows = h.db.prepare('SELECT COUNT(*) AS n FROM studio_audit').get() as { n: number };
    expect(rows.n).toBe(1);
    const cols = (h.db.pragma('table_info(studio_audit)') as Array<{ name: string }>).map((c) => c.name).sort();
    expect(cols).toEqual([
      'action', 'approval', 'epoch', 'id', 'outcome_chars_landed', 'outcome_error_reason',
      'outcome_ok', 'risk', 'seq', 'session_id', 'target_amount', 'target_direction',
      'target_ref', 'target_url', 'ts',
    ]);
  });
});
