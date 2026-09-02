import { describe, it, expect, vi } from 'vitest';
import { createSessionDrive, type SessionDriveDeps, type DriveControlToken } from '../../../src/studio/session-drive.js';
import { createActHandler } from '../../../src/studio/act.js';
import { OriginBudget } from '../../../src/companion/origin-budget.js';
import { PreGrantStore } from '../../../src/studio/pre-grant.js';
import type { AgentDriveGate } from '../../../src/studio/agent-drive-gate.js';
import { runSessionFetch } from '../../../src/tools/session-target.js';
import type { StudioSessionsAccessor } from '../../../src/studio/session-drive.js';
import type { FetchInput } from '../../../src/types.js';
import type { ResolveResult } from '../../../src/studio/perception/resolve.js';

/**
 * S9 / D9 — the SEAM tests. The gate is unit-tested elsewhere; what these assert is that its verdict
 * actually reaches the agent, through BOTH navigation lanes, with its own words intact.
 *
 * This matters because the alternative failure is silent and awful: a budget refusal reported as a generic
 * "navigation did not complete" reads as a bug in the bridge, so the human debugs the wrong thing and the
 * "first-class, visible feature" is invisible in practice.
 */

const token: DriveControlToken = {
  holder: 'agent',
  epoch: 1,
  assertCanDrive: () => ({ ok: true }),
};

function exhaustedGate(): AgentDriveGate {
  const budget = new OriginBudget({ limit: 1 });
  budget.spend('https://a.example/');
  return { budget };
}

function driveDeps(gate: AgentDriveGate, navigate = vi.fn(async () => ({ ok: true }))): SessionDriveDeps {
  return {
    browser: { navigate } as unknown as SessionDriveDeps['browser'],
    controlToken: token,
    grant: { humanAllowPrivate: true, agentAllowPrivate: true },
    currentUrl: () => 'https://a.example/',
    readHtml: async () => '<html>x</html>',
    insert: async () => ({ id: 1, inserted: true, contentHash: 'x' }) as never,
    isCredentialContext: async () => false,
    driveGate: gate,
  };
}

describe('D9 through the session-drive seam (bridge + fetch(session_id) + crawl)', () => {
  it('refuses the navigation and NEVER reaches the browser', async () => {
    const navigate = vi.fn(async () => ({ ok: true }));
    const drive = createSessionDrive(driveDeps(exhaustedGate(), navigate));
    const r = await drive.gatedNavigate('https://a.example/next');
    expect(r.ok).toBe(false);
    // The whole point of pacing is that the request does not go out. A refusal that still navigated would be
    // decoration.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('carries the reason and hint, not a bare reason code', async () => {
    const drive = createSessionDrive(driveDeps(exhaustedGate()));
    const r = await drive.gatedNavigate('https://a.example/next');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('origin_budget_exhausted');
      expect(r.error_reason).toContain('1 of 1');
      expect(r.hint).toBeTruthy();
    }
  });

  it('charges the budget AFTER the control gate — a nav the human already vetoed must not spend it', async () => {
    const budget = new OriginBudget({ limit: 5 });
    const held: DriveControlToken = { holder: 'human', epoch: 2, assertCanDrive: () => ({ ok: false, reason: 'not_holder', currentEpoch: 2 }) };
    const drive = createSessionDrive({ ...driveDeps({ budget }), controlToken: held });
    const r = await drive.gatedNavigate('https://a.example/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_holder');
    expect(budget.totalSpent).toBe(0);
  });

  it('surfaces through the fetch tool with the counters visible, not as "navigation did not complete"', async () => {
    const drive = createSessionDrive(driveDeps(exhaustedGate()));
    const accessor: StudioSessionsAccessor = { getSessionDrive: () => drive };
    const r = await runSessionFetch(accessor, { url: 'https://a.example/next', session_id: 's1' } as FetchInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // K6: `runSessionFetch` is a PRODUCER — `src/server.ts:533-535` routes it through
      // `stageErrorEnvelope`, which swaps these two fields on the way out. So the code belongs in
      // `error` and the prose in `error_reason` HERE, and the agent still sees the code under
      // `error_reason` on the wire. This is the opposite of the broker's `runStudioFetch`, which
      // publishes directly; the two look like duplicates and deliberately are not.
      expect(r.error).toBe('origin_budget_exhausted');
      expect(r.error_reason).toContain('1 of 1');
    }
  });
});

describe('D9 through the act-navigate lane', () => {
  const actDeps = (gate: AgentDriveGate, navigate = vi.fn(async () => ({ ok: true }))) => ({
    browser: { navigate } as never,
    controlToken: token,
    grant: { humanAllowPrivate: true, agentAllowPrivate: true },
    // Mirrors ResolvedTarget (src/studio/perception/resolve.ts:30-34): the click point is NESTED
    // under `center`, and there is no `ref` — that is the resolver's INPUT, never its output.
    // Written flat, act.ts:328 would read `resolved.center` as undefined.
    resolve: async (): Promise<ResolveResult> => ({ backendNodeId: 1, center: { x: 0, y: 0 } }),
    channel: { dispatchAgentUnit: async () => true, viewportCenter: () => ({ x: 0, y: 0 }) },
    driveGate: gate,
  });

  it('refuses studio_act navigate on an exhausted budget without navigating', async () => {
    const navigate = vi.fn(async () => ({ ok: true }));
    const act = createActHandler(actDeps(exhaustedGate(), navigate));
    const r = await act({ action: 'navigate', url: 'https://a.example/next' });
    expect('error_reason' in r).toBe(true);
    // K6: studio_act's published refusal keys on the code; the counters ride `error`.
    if ('error_reason' in r) {
      expect(r.error_reason).toBe('origin_budget_exhausted');
      expect(r.error).toContain('1 of 1');
    }
    expect(navigate).not.toHaveBeenCalled();
  });

  it('uses the SAME gate object as the drive seam, so the two lanes share one budget', async () => {
    // A per-lane budget would let an agent double its real allowance just by alternating verbs.
    const budget = new OriginBudget({ limit: 2 });
    const gate: AgentDriveGate = { budget };
    const drive = createSessionDrive(driveDeps(gate));
    const act = createActHandler(actDeps(gate));

    expect((await drive.gatedNavigate('https://a.example/1')).ok).toBe(true);
    expect('ok' in (await act({ action: 'navigate', url: 'https://a.example/2' }))).toBe(true);
    const third = await drive.gatedNavigate('https://a.example/3');
    expect(third.ok).toBe(false);
  });

  it('a grant card that resolves after a human reclaim does not navigate — the epoch fence still holds', async () => {
    // D9's card is the first thing that can hold this path open for a long time, so the fence that was a
    // backstop is now the primary protection. If gateEpoch were captured after the await, this goes green.
    let epoch = 1;
    let holder: 'human' | 'agent' = 'agent';
    const flipping: DriveControlToken = {
      get holder() { return holder; },
      get epoch() { return epoch; },
      assertCanDrive: () => (holder === 'agent' ? { ok: true } : { ok: false, reason: 'not_holder', currentEpoch: epoch }),
    };
    const navigate = vi.fn(async () => ({ ok: true }));
    const gate: AgentDriveGate = {
      budget: new OriginBudget({ limit: 5 }),
      preGrant: new PreGrantStore(),
      isAuthenticatedOrigin: () => true,
      approvalSurfaceAttached: () => true,
      requestApproval: async () => {
        // The human reclaims while the card is open and then hands the wheel back. Holder is 'agent' again,
        // so the holder check alone cannot catch this — only the ADVANCED epoch can. That is precisely the
        // scenario the fence exists for, and the only one that isolates it from the holder check.
        epoch = 2;
        holder = 'agent';
        return 'approved';
      },
    };
    const act = createActHandler({ ...actDeps(gate, navigate), controlToken: flipping });
    const r = await act({ action: 'navigate', url: 'https://signed.example/' });
    expect('error_reason' in r).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });
});
