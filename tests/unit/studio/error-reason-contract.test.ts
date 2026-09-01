import { describe, it, expect, vi } from 'vitest';
import { createActHandler } from '../../../src/studio/act.js';
import { OriginBudget, budgetRefusal } from '../../../src/studio/origin-budget.js';
import { PreGrantStore } from '../../../src/studio/pre-grant.js';
import { checkAgentDrive, type AgentDriveGate } from '../../../src/studio/agent-drive-gate.js';
import { runStudioFetch, type StudioFetchDeps } from '../../../src/studio/studio-fetch.js';
import { dispatchStudioTool, type StudioHostHandlers, type McpToolResult } from '../../../src/daemon/studio-dispatch.js';
import type { SessionDrive, StudioSessionsAccessor, DriveControlToken } from '../../../src/studio/session-drive.js';
import type { ResolveResult } from '../../../src/studio/perception/resolve.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * K6 — `error_reason` is a STABLE MACHINE CODE on every published studio envelope.
 *
 * The verdict this file encodes (recorded in DECISIONS-AUTO under #28): the studio envelope shares the
 * core contract. `docs/rest-api.md:176` states it; `stageErrorEnvelope` (src/server.ts) and
 * `stageFailure` (src/daemon/rest/dispatch.ts) are the two published-envelope assembly points and both
 * SWAP the producer orientation for exactly this reason; and `extractErrorReason` (src/server.ts:105)
 * reads this field off a STUDIO result for the D10 audit while documenting it as "a typed reason string
 * … not user content — safe to audit".
 *
 * The two D9 refusals used to publish an English sentence there — with an interpolated origin and live
 * counters in it — which makes the audit column unaggregatable and forces every consumer to key on free
 * text that changes whenever the copy does. The prose is not deleted: it moves to `error`, the same
 * field the core published envelope uses for the same thing.
 *
 * MACHINE_CODE is the mechanically-checkable rule. A sentence fails it on the space alone; it is
 * deliberately stricter than "not empty" so a future refusal cannot half-comply.
 */
const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

const token: DriveControlToken = { holder: 'agent', epoch: 1, assertCanDrive: () => ({ ok: true }) };

/** A budget with its single allowance already spent on the origin under test. */
function exhaustedGate(): AgentDriveGate {
  const budget = new OriginBudget({ limit: 1 });
  budget.spend('https://a.example/');
  return { budget };
}

/** A signed-in origin with no approval surface attached ⇒ the `blocked_by_challenge` grant refusal. */
function ungrantedGate(): AgentDriveGate {
  return {
    budget: new OriginBudget({ limit: 50 }),
    preGrant: new PreGrantStore(),
    isAuthenticatedOrigin: () => true,
    approvalSurfaceAttached: () => false,
  };
}

const actDeps = (gate: AgentDriveGate, navigate = vi.fn(async () => ({ ok: true }))) => ({
  browser: { navigate } as never,
  controlToken: token,
  grant: { humanAllowPrivate: true, agentAllowPrivate: true },
  resolve: async (): Promise<ResolveResult> => ({ backendNodeId: 1, center: { x: 0, y: 0 } }),
  channel: { dispatchAgentUnit: async () => true, viewportCenter: () => ({ x: 0, y: 0 }) },
  driveGate: gate,
});

describe('D9 refusals — the gate publishes a code, never a sentence (K6)', () => {
  it('origin_budget_exhausted: studio_act returns the code in error_reason and the counters in error', async () => {
    const act = createActHandler(actDeps(exhaustedGate()));
    const r = await act({ action: 'navigate', url: 'https://a.example/next' });
    expect('error_reason' in r).toBe(true);
    if (!('error_reason' in r)) return;
    expect(r.error_reason).toBe('origin_budget_exhausted');
    expect(r.error_reason).toMatch(MACHINE_CODE);
    // The prose is KEPT, not dropped — a budget the agent cannot read the numbers off is not "visible".
    expect(r.error).toContain('1 of 1');
    expect(r.error).toContain('a.example');
    expect(r.hint).toBeTruthy();
  });

  it('blocked_by_challenge: studio_act returns the code in error_reason and the why in error', async () => {
    const act = createActHandler(actDeps(ungrantedGate()));
    const r = await act({ action: 'navigate', url: 'https://signed.example/' });
    expect('error_reason' in r).toBe(true);
    if (!('error_reason' in r)) return;
    expect(r.error_reason).toBe('blocked_by_challenge');
    expect(r.error_reason).toMatch(MACHINE_CODE);
    expect(r.error).toContain('signed.example');
    expect(r.error).toContain('nobody is attached to approve it');
    expect(r.hint).toBeTruthy();
  });

  it('the gate itself no longer has a field named error_reason — the copy-straight-across is unexpressible', async () => {
    // This is the actual defect class, not a spelling preference. `act.ts` forwarded the producer verdict
    // straight into a PUBLISHED envelope with no swap, which is only possible while the producer owns a
    // field of that name. Removing the name removes the seam's ability to get it wrong silently: the
    // forward now has to name `reason` (the code) and `message` (the prose) separately.
    const budget = await checkAgentDrive(exhaustedGate(), 'https://a.example/next');
    expect(budget.ok).toBe(false);
    if (budget.ok) return;
    expect('error_reason' in budget).toBe(false);
    expect(budget.reason).toBe('origin_budget_exhausted');
    expect(budget.message).toContain('1 of 1');

    const grant = await checkAgentDrive(ungrantedGate(), 'https://signed.example/');
    expect(grant.ok).toBe(false);
    if (grant.ok) return;
    expect('error_reason' in grant).toBe(false);
    expect(grant.reason).toBe('blocked_by_challenge');
    expect(grant.message).toContain('signed.example');
  });

  it('budgetRefusal mints the same shape as the gate — one refusal, not two that can drift', () => {
    const r = budgetRefusal({ ok: false, origin: 'https://a.example', used: 3, limit: 3, originClass: 'authenticated' });
    expect(r.reason).toBe('origin_budget_exhausted');
    expect(r.reason).toMatch(MACHINE_CODE);
    expect(r.message).toContain('3 of 3');
    expect('error_reason' in r).toBe(false);
  });
});

describe('D9 refusals through the published MCP envelope (studio_act)', () => {
  let dir: string;
  const hostFor = (act: StudioHostHandlers['act']): StudioHostHandlers => ({
    observe: async () => ({ id: 's', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
    act,
    marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
    capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
    spawn: async () => ({ session_id: 'bg-1' }),
    close: async (i) => ({ closed: true as const, session_id: i.session_id ?? '' }),
    list: async () => ({ sessions: [] }),
    say: async () => ({ posted: true, posted_at: 0 }),
    extractSet: async () => ({ columns: [], rows: [], pages_followed: 0 }),
  });
  const body = (r: McpToolResult) => JSON.parse(r.content[0].text) as { error_reason?: string; error?: string; hint?: string };

  it('the bytes on the wire carry the code, the message and the hint as three separate fields', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-k6-'));
    try {
      const handler = createActHandler(actDeps(exhaustedGate()));
      const r = await dispatchStudioTool(
        'studio_act',
        { action: 'navigate', url: 'https://a.example/next' },
        hostFor(handler as StudioHostHandlers['act']),
        dir,
      );
      expect(r.isError).toBe(true);
      const b = body(r);
      // What an audit or a switch statement keys on.
      expect(b.error_reason).toBe('origin_budget_exhausted');
      // What a human reads. Both present, neither doing the other's job.
      expect(b.error).toContain('1 of 1');
      expect(b.hint).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `runStudioFetch` is a PUBLISHED envelope, not a producer: its only consumer,
 * `src/daemon/studio-mcp-server.ts:55`, serializes the body verbatim and never routes it through
 * `stageErrorEnvelope`. So it owes the published orientation on every failure path, and the near-identical
 * `src/tools/session-target.ts` — which DOES reach `stageErrorEnvelope` (src/server.ts:533-535) — owes the
 * opposite one. The two files read as duplicates and deliberately differ.
 */
describe('runStudioFetch — every failure path publishes a machine code (K6 class guard)', () => {
  const liveDrive = (over: Partial<SessionDrive> = {}): SessionDrive => ({
    currentUrl: () => 'https://example.com/',
    gatedNavigate: vi.fn(async () => ({ ok: true as const })),
    readCurrentPage: vi.fn(async () => ({ url: 'https://example.com/', html: '<html><body>real</body></html>' })),
    insertTrusted0: vi.fn(async () => ({ id: 1, inserted: true, contentHash: 'h' })),
    isCredentialContext: vi.fn(async () => false),
    ...over,
  });

  const depsWith = (d: SessionDrive): StudioFetchDeps => ({
    sessions: { getSessionDrive: () => d } as StudioSessionsAccessor,
    host: {
      list: async () => ({ sessions: [{ id: 's1', status: 'live', clients: 0, createdAt: 0, lastActiveAt: 0 }] }),
      spawn: async () => ({ session_id: 's1' }),
    },
  });

  const CF_SHELL =
    '<html><head><title>Just a moment...</title></head><body>' +
    '<div id="cf-wrapper"><div class="cf-browser-verification"></div></div>' +
    '<script>window._cfChlOpt={cvId:"3"};</script></body></html>';

  const noSession: StudioFetchDeps = {
    sessions: { getSessionDrive: () => undefined } as StudioSessionsAccessor,
    host: { list: async () => ({ sessions: [] }), spawn: async () => ({ error_reason: 'session_cap', hint: 'close one' }) },
  };

  const cases: Array<[string, () => Promise<{ ok: boolean }>, string]> = [
    ['invalid_url', () => runStudioFetch(depsWith(liveDrive()), { url: '   ' }), 'invalid_url'],
    ['studio_no_drive', () => runStudioFetch(noSession, { url: 'https://a.example/' }), 'studio_no_drive'],
    [
      'not_holder',
      () => runStudioFetch(depsWith(liveDrive({ gatedNavigate: async () => ({ ok: false, reason: 'not_holder' }) })), { url: 'https://a.example/' }),
      'not_holder',
    ],
    [
      'navigation_blocked',
      () => runStudioFetch(depsWith(liveDrive({ gatedNavigate: async () => ({ ok: false, reason: 'navigation_blocked' }) })), { url: 'https://a.example/' }),
      'navigation_blocked',
    ],
    [
      'a generic nav failure',
      () => runStudioFetch(depsWith(liveDrive({ gatedNavigate: async () => ({ ok: false, reason: 'nav_timeout' }) })), { url: 'https://a.example/' }),
      'nav_timeout',
    ],
    [
      'capture_refused',
      () => runStudioFetch(depsWith(liveDrive({ isCredentialContext: async () => true })), { url: 'https://a.example/' }),
      'capture_refused',
    ],
    [
      'blocked_by_challenge',
      () => runStudioFetch(depsWith(liveDrive({ readCurrentPage: async () => ({ url: 'https://walled.example/', html: CF_SHELL }) })), { url: 'https://walled.example/' }),
      'blocked_by_challenge',
    ],
  ];

  for (const [name, run, code] of cases) {
    it(`${name} publishes error_reason as a code`, async () => {
      const r = (await run()) as { ok: boolean; error_reason?: string; error?: string };
      expect(r.ok).toBe(false);
      expect(r.error_reason).toBe(code);
      expect(r.error_reason).toMatch(MACHINE_CODE);
      // Every one of these carried a sentence in `error_reason` before K6; the sentence is now in `error`.
      expect(typeof r.error).toBe('string');
      expect(r.error).not.toBe(r.error_reason);
    });
  }

  it('a D9 budget refusal reaches the broker envelope with its counters intact, under the code', async () => {
    const d = liveDrive({
      gatedNavigate: async () => ({ ok: false, reason: 'origin_budget_exhausted', error_reason: 'This session has already made 1 of 1 allowed requests to https://a.example.', hint: 'pace' }),
    });
    const r = (await runStudioFetch(depsWith(d), { url: 'https://a.example/next' })) as { ok: boolean; error_reason?: string; error?: string; hint?: string };
    expect(r.ok).toBe(false);
    expect(r.error_reason).toBe('origin_budget_exhausted');
    expect(r.error).toContain('1 of 1');
    expect(r.hint).toBe('pace');
  });
});
