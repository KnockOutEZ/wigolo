import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../../src/cache/migrations/runner.js';
import { createActHandler, type ActControlToken } from '../../../../src/studio/act.js';
import { createFlowRecorder, isRecordableAct, narrowPageUrl } from '../../../../src/studio/flow/record.js';
import { redactCredentialParams, CREDENTIAL_PARAM_NAMES } from '../../../../src/studio/credential.js';
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
  /** Reuse an existing DB — the restart case, where a SECOND recorder opens the SAME store. */
  db?: Database.Database;
} = {}): Harness {
  const db = opts.db ?? migratedDb();
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

  it('drops the query string and fragment from a NON-navigate page URL, and keeps a navigate URL whole', async () => {
    // The audit stores NO url for click/type/scroll, so for those verbs the sidecar is the only
    // place a URL exists — and it is the LIVE, post-redirect, SERVER-authored one, which is where
    // a session-bearing parameter lands. The credential-URL guard does not catch it: it matches
    // login words as PATH segments, so `?sso_session=` is invisible to it.
    const live = 'https://app.example.com/reports?sso_session=eyJhbGciOiJIUzI1NiJ9.SECRET#tab=2';
    const h = harness({ currentUrl: live });
    await h.act({ action: 'click', ref: 'e1' });
    await h.act({ action: 'scroll', direction: 'down', amount: 100 });
    await h.act({ action: 'navigate', url: 'https://app.example.com/reports?tab=archive' });
    const [click, scroll, navigate] = h.steps();
    expect(click.pageUrl).toBe('https://app.example.com/reports');
    expect(scroll.pageUrl).toBe('https://app.example.com/reports');
    // A navigate URL is agent-authored and IS the instruction — it stays whole, and it is byte-
    // identical to the audit's own target_url for the same act, so it adds no exposure.
    expect(navigate.pageUrl).toBe('https://app.example.com/reports?tab=archive');
    const auditUrl = h.db
      .prepare("SELECT target_url FROM studio_audit WHERE action = 'navigate'")
      .get() as { target_url: string };
    expect(navigate.pageUrl).toBe(auditUrl.target_url);
    // Nothing anywhere in the sidecar retains the secret.
    const dump = JSON.stringify(h.steps());
    expect(dump).not.toContain('sso_session');
    expect(dump).not.toContain('SECRET');
  });

  it('records NO step for an act that resolved but was then REFUSED', async () => {
    // The guard at the record call site is `!('error_reason' in result)`. The existing
    // refused-act test resolves to `element_occluded`, which returns BEFORE a seed is built — so
    // `TARGETED_ACTIONS && !target` short-circuits and the outcome condition is never reached.
    // A credential-field refusal is the case that gets all the way past resolve WITH a seed: the
    // page is not login-shaped, so the recorder's own credential refusal does not fire either, and
    // the outcome check is the only thing standing between a refused act and a stored step
    // carrying a password field's seed and `slot: "password"`.
    const h = harness({
      currentUrl: 'https://example.com/settings',
      resolve: {
        backendNodeId: 42,
        center: { x: 1, y: 1 },
        role: 'textbox',
        name: 'Password',
        semantics: { tag: 'input', type: 'password' },
      },
      target: liveTarget({ role: 'textbox', name: 'Password' }),
    });
    const result = await h.act({ action: 'type', ref: 'e1', text: 'hunter2' });
    expect(result).toMatchObject({ error_reason: 'credential_field_refused' });
    expect(h.steps()).toHaveLength(0);
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

  it('resumes numbering after a restart rather than dropping the middle of the flow', async () => {
    // The restart case only exists if BOTH recorders open the same store — a fresh `:memory:` DB
    // per recorder is two unrelated flows and can never collide. Sharing it makes the
    // `SELECT MAX(seq)` recovery load-bearing: without it the second recorder restarts at seq 1,
    // and `INSERT OR IGNORE` on the unique (flow_id, seq) index SILENTLY drops the colliding row.
    // The flow would then be missing its middle, which is the exact failure the resume prevents.
    const shared = migratedDb();
    const a = harness({ sessionId: 'sess-resume', currentUrl: 'https://example.com/a', db: shared });
    await a.act({ action: 'click', ref: 'e1' });
    await a.act({ action: 'navigate', url: 'https://example.com/b' });
    const b = harness({ sessionId: 'sess-resume', currentUrl: 'https://example.com/a', db: shared });
    await b.act({ action: 'navigate', url: 'https://example.com/c' });
    // Three acts, three steps, contiguous — no seq reused and nothing swallowed.
    expect(b.steps().map((s) => [s.seq, s.pageUrl])).toEqual([
      [1, 'https://example.com/a'],
      [2, 'https://example.com/b'],
      [3, 'https://example.com/c'],
    ]);
  });
});

describe('the recorder — a secret-shaped parameter is REDACTED from a navigate URL, and the step is kept (A175)', () => {
  it('removes ?token= and keeps the rest of the URL', () => {
    expect(narrowPageUrl('navigate', 'https://ex.com/reset?token=SECRET')).toBe('https://ex.com/reset');
  });

  it('removes ?sso_session= while leaving its BENIGN siblings byte-intact — the case that decides the design', () => {
    // Stripping the whole query would break every search and filtered-list flow, which is most of what
    // is worth replaying. Removing the one named parameter keeps the navigation replayable.
    expect(narrowPageUrl('navigate', 'https://shop.com/search?q=shoes&page=2&sso_session=SECRET'))
      .toBe('https://shop.com/search?q=shoes&page=2');
  });

  it('removes ?api_key= — matched on the WHOLE name normalised, which the parts alone would miss', () => {
    // `api_key` is credential-shaped only as `apikey`; `sso_session` only in its `session` part. Either
    // matching rule alone leaves a real name uncovered.
    expect(narrowPageUrl('navigate', 'https://ex.com/x?api_key=S&view=grid')).toBe('https://ex.com/x?view=grid');
  });

  it('NEVER DROPS THE STEP — a navigate whose only parameter is a secret still records', () => {
    // The property this design turns on. Refusing the step would leave the sequence numbers contiguous
    // while the recording silently lost its navigation, and replay would then run the following clicks
    // against whatever page was already open. A flow missing its navigate is worse than a stored token.
    expect(isRecordableAct({ action: 'navigate', auditSeq: 1, pageUrl: 'https://ex.com/reset?token=SECRET' })).toBe(true);
  });

  it('leaves a benign query-parameterised navigate completely alone', () => {
    expect(narrowPageUrl('navigate', 'https://shop.com/search?q=shoes&page=2')).toBe('https://shop.com/search?q=shoes&page=2');
  });

  it('does not fire on ?author= — the guard is a name test, not a substring test', () => {
    // A substring test matches `auth` inside `author` and would quietly rewrite a URL because a page
    // listed articles by author.
    expect(narrowPageUrl('navigate', 'https://blog.com/posts?author=jane')).toBe('https://blog.com/posts?author=jane');
  });

  it('redacts a secret out of the FRAGMENT too, because that is where the OAuth implicit flow puts it', () => {
    // `#tab=2` and `#access_token=…` are the same syntax; only the name tells them apart. A
    // search-params-only guard would miss the most common secret-in-a-URL shape on the web.
    expect(narrowPageUrl('navigate', 'https://cb.ex.com/cb#access_token=SECRET&state=xyz')).toBe('https://cb.ex.com/cb#state=xyz');
    expect(narrowPageUrl('navigate', 'https://docs.ex.com/guide#installation')).toBe('https://docs.ex.com/guide#installation');
  });

  it('drops an UNPARSEABLE navigate url rather than storing it raw', () => {
    // There is no way to redact a string that cannot be parsed, and returning it unchanged would pass a
    // secret straight through the function whose job is removing it.
    expect(redactCredentialParams('h ttp://%%%not-a-url?token=S')).toBe('');
    expect(narrowPageUrl('navigate', 'h ttp://%%%not-a-url?token=S')).toBeUndefined();
  });

  it('leaves the NON-navigate verbs to the existing narrowing, which already drops search and hash', () => {
    // Asymmetric on purpose: no other verb keeps a query string, so no other verb needs this guard.
    expect(narrowPageUrl('click', 'https://ex.com/reset?token=SECRET#x')).toBe('https://ex.com/reset');
    expect(isRecordableAct({ action: 'click', auditSeq: 1, pageUrl: 'https://ex.com/reset?token=SECRET', target: liveTarget() })).toBe(true);
  });

  it('keys on a FIXED constant, so re-tuning risk policy cannot widen what gets stored', () => {
    for (const n of ['token', 'session', 'secret', 'password', 'apikey', 'authorization', 'jwt']) {
      expect(CREDENTIAL_PARAM_NAMES.has(n), `${n} must be treated as credential-shaped`).toBe(true);
    }
    expect(CREDENTIAL_PARAM_NAMES.has('author')).toBe(false);
    expect(CREDENTIAL_PARAM_NAMES.has('page')).toBe(false);
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
