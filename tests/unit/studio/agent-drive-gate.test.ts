import { describe, it, expect, vi } from 'vitest';
import { checkAgentDrive, type AgentDriveGate } from '../../../src/studio/agent-drive-gate.js';
import { OriginBudget, DEFAULT_ORIGIN_BUDGET, budgetOrigin } from '../../../src/companion/origin-budget.js';
import { PreGrantStore } from '../../../src/studio/pre-grant.js';

/**
 * S9 / D9 — the pacing budget and the authenticated-use grant card.
 *
 * The single most important property under test is that THE RAIL CANNOT BE LOST: the budget is charged for
 * every origin, on every path, with a finite limit, whatever the authenticated-origin predicate does —
 * including when it is absent or throws. Only the card is gated on the predicate's verdict. That is what
 * makes an F5 false negative cost a prompt instead of an account.
 *
 * The predicate now also selects WHICH budget lane applies (signed-in tight, anonymous relaxed), so the
 * older "the budget never consults the predicate" phrasing no longer holds literally. The property it stood
 * for does, and is asserted directly on the failure modes further down: absent, throwing, and any other
 * ignorance all resolve to the TIGHT lane, so a broken predicate can only tighten the rail, never loosen it.
 */

function gate(over: Partial<AgentDriveGate> = {}): AgentDriveGate {
  // Both lanes set to the same small number, so these tests exercise "the budget applies at all" without
  // also depending on which lane an origin lands in — that split has its own describe block below.
  return { budget: new OriginBudget({ limit: 3, anonymousLimit: 3 }), ...over };
}

describe('D9 budget — applies to EVERY origin', () => {
  it('paces an anonymous origin: the rail does not wait for the predicate to say "signed in"', async () => {
    // MUTATION CHECK: if a refactor moved the budget behind `if (authenticated)`, this goes green→red.
    const g = gate({ isAuthenticatedOrigin: () => false });
    for (let i = 0; i < 3; i++) expect((await checkAgentDrive(g, 'https://anon.example/p')).ok).toBe(true);
    const v = await checkAgentDrive(g, 'https://anon.example/p');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('origin_budget_exhausted');
  });

  it('paces with NO predicate wired at all', async () => {
    const g = gate();
    for (let i = 0; i < 3; i++) await checkAgentDrive(g, 'https://anon.example/');
    expect((await checkAgentDrive(g, 'https://anon.example/')).ok).toBe(false);
  });

  it('budgets are per-origin: exhausting one leaves the others untouched', async () => {
    const g = gate();
    for (let i = 0; i < 3; i++) await checkAgentDrive(g, 'https://a.example/');
    expect((await checkAgentDrive(g, 'https://a.example/')).ok).toBe(false);
    expect((await checkAgentDrive(g, 'https://b.example/')).ok).toBe(true);
  });

  it('scheme and port are part of the origin — accounts.example and docs.example are not one exposure', async () => {
    expect(budgetOrigin('https://accounts.example/x')).toBe('https://accounts.example');
    expect(budgetOrigin('https://docs.example/x')).toBe('https://docs.example');
    expect(budgetOrigin('https://a.example:8443/x')).toBe('https://a.example:8443');
  });

  it('names the live counters in the refusal — an opaque "budget exceeded" is not a visible budget', async () => {
    const g = gate();
    for (let i = 0; i < 3; i++) await checkAgentDrive(g, 'https://a.example/');
    const v = await checkAgentDrive(g, 'https://a.example/');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      // K6: the counters live in `message`; `error_reason` is gone from the producer verdict entirely so a
      // seam cannot copy it into a published envelope without swapping.
      expect(v.message).toContain('3 of 3');
      expect(v.message).toContain('https://a.example');
    }
  });

  it('counts the refusal locally so the placeholder default can be revisited with numbers', async () => {
    const bump = vi.fn();
    const g = gate({ bump });
    for (let i = 0; i < 3; i++) await checkAgentDrive(g, 'https://a.example/');
    await checkAgentDrive(g, 'https://a.example/');
    expect(bump).toHaveBeenCalledWith('budgetRefused');
  });

  it('an unparseable url is neither charged nor refused — the SSRF fence is what rejects those', async () => {
    const g = gate();
    for (let i = 0; i < 10; i++) expect((await checkAgentDrive(g, 'not a url')).ok).toBe(true);
    expect(g.budget.totalSpent).toBe(0);
  });
});

describe('OriginBudget — configuration and visibility', () => {
  it('exposes live counters, highest spend first, for status output', () => {
    const b = new OriginBudget({ limit: 5 });
    b.spend('https://a.example/');
    b.spend('https://a.example/2');
    b.spend('https://b.example/');
    expect(b.snapshot()).toEqual([
      { origin: 'https://a.example', used: 2, limit: 5, originClass: 'authenticated' },
      { origin: 'https://b.example', used: 1, limit: 5, originClass: 'authenticated' },
    ]);
  });

  it('falls back to the default on a zero or negative configured limit', () => {
    // A "0" in a config file is far more likely a typo than an intent to block every navigation, and
    // honouring it would silently brick every session while looking like a bug in the bridge.
    expect(new OriginBudget({ limit: 0 }).spend('https://a.example/').limit).toBe(DEFAULT_ORIGIN_BUDGET);
    expect(new OriginBudget({ limit: -5 }).spend('https://a.example/').limit).toBe(DEFAULT_ORIGIN_BUDGET);
    expect(new OriginBudget({ limit: Number.NaN }).spend('https://a.example/').limit).toBe(DEFAULT_ORIGIN_BUDGET);
  });
});

describe('D9 card — fires only for an authenticated origin', () => {
  it('does NOT fire for an anonymous origin, even with an approval surface attached', async () => {
    const requestApproval = vi.fn(async () => 'approved' as const);
    const g = gate({ isAuthenticatedOrigin: () => false, approvalSurfaceAttached: () => true, requestApproval });
    expect((await checkAgentDrive(g, 'https://anon.example/')).ok).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('fires ONCE per origin per session, not once per request', async () => {
    // Nag fatigue is the failure mode: a card on every request trains the human to click Allow without
    // reading, which is strictly worse than no card.
    const requestApproval = vi.fn(async () => 'approved' as const);
    const g = gate({
      isAuthenticatedOrigin: () => true,
      preGrant: new PreGrantStore(),
      approvalSurfaceAttached: () => true,
      requestApproval,
    });
    expect((await checkAgentDrive(g, 'https://signed.example/a')).ok).toBe(true);
    expect((await checkAgentDrive(g, 'https://signed.example/b')).ok).toBe(true);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('a refusal degrades to blocked_by_challenge plus a summon hint — the human always keeps a result path', async () => {
    const g = gate({
      isAuthenticatedOrigin: () => true,
      preGrant: new PreGrantStore(),
      approvalSurfaceAttached: () => true,
      requestApproval: async () => 'refused',
    });
    const v = await checkAgentDrive(g, 'https://signed.example/');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe('blocked_by_challenge');
      expect(v.hint).toContain('open the browser session');
    }
  });

  it('a timeout or a supersede is NOT an approval — only an explicit approve fires', async () => {
    for (const decision of ['timeout', 'superseded'] as const) {
      const g = gate({
        isAuthenticatedOrigin: () => true,
        preGrant: new PreGrantStore(),
        approvalSurfaceAttached: () => true,
        requestApproval: async () => decision,
      });
      expect((await checkAgentDrive(g, 'https://signed.example/')).ok).toBe(false);
    }
  });

  it('a refusal does NOT record a grant, so the next attempt asks again rather than inheriting a no', async () => {
    const preGrant = new PreGrantStore();
    const g = gate({ isAuthenticatedOrigin: () => true, preGrant, approvalSurfaceAttached: () => true, requestApproval: async () => 'refused' });
    await checkAgentDrive(g, 'https://signed.example/');
    expect(preGrant.hasAuthenticatedUse('https://signed.example')).toBe(false);
  });

  it('the budget is charged even when the card refuses — a refused card must not be a free retry loop', async () => {
    const g = gate({ isAuthenticatedOrigin: () => true, preGrant: new PreGrantStore(), approvalSurfaceAttached: () => true, requestApproval: async () => 'refused' });
    await checkAgentDrive(g, 'https://signed.example/');
    expect(g.budget.totalSpent).toBe(1);
  });
});

describe('D9 card — unattended contexts fail fast (§5.1, amended)', () => {
  it('refuses IMMEDIATELY with no approval surface attached, instead of waiting out a timeout nobody can answer', async () => {
    const requestApproval = vi.fn(async () => { throw new Error('must not be asked'); });
    const g = gate({
      isAuthenticatedOrigin: () => true,
      preGrant: new PreGrantStore(),
      approvalSurfaceAttached: () => false,
      requestApproval: requestApproval as unknown as (o: string) => Promise<'approved'>,
    });
    const v = await checkAgentDrive(g, 'https://signed.example/');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('blocked_by_challenge');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('treats an UNWIRED attachment probe as unattended — guessing "attached" is what causes the hang', async () => {
    const g = gate({ isAuthenticatedOrigin: () => true, preGrant: new PreGrantStore(), requestApproval: async () => 'approved' });
    expect((await checkAgentDrive(g, 'https://signed.example/')).ok).toBe(false);
  });

  it('counts the skipped card locally — background runs are the normal case for this path, not an edge case', async () => {
    const bump = vi.fn();
    const g = gate({ isAuthenticatedOrigin: () => true, preGrant: new PreGrantStore(), approvalSurfaceAttached: () => false, bump });
    await checkAgentDrive(g, 'https://signed.example/');
    expect(bump).toHaveBeenCalledWith('cardUnattended');
  });
});

describe('D9 — PreGrantStore keeps its human-only-writer bright line under the extension', () => {
  it('an agent-spawned session starts EMPTY and stays empty until a human grants', () => {
    const s = new PreGrantStore();
    expect(s.hasAuthenticatedUse('https://signed.example')).toBe(false);
    expect(s.authenticatedUseSnapshot()).toEqual([]);
  });

  it('the authenticated-use set lives on the SAME store as the action grants, so clear() revokes both', () => {
    const s = new PreGrantStore();
    s.add({ domain: 'shop.example', actionType: 'click', riskTier: 'money' });
    s.allowAuthenticatedUse('https://signed.example');
    s.clear();
    expect(s.size).toBe(0);
    expect(s.hasAuthenticatedUse('https://signed.example')).toBe(false);
  });

  it('is revocable per origin', () => {
    const s = new PreGrantStore();
    s.allowAuthenticatedUse('https://a.example');
    s.allowAuthenticatedUse('https://b.example');
    s.revokeAuthenticatedUse('https://a.example');
    expect(s.authenticatedUseSnapshot()).toEqual(['https://b.example']);
  });

  it('an empty origin never matches — fail-closed on an unreadable url', () => {
    const s = new PreGrantStore();
    s.allowAuthenticatedUse('');
    expect(s.hasAuthenticatedUse('')).toBe(false);
  });
});

describe('D9 — the invariant the old call-order assertion was a proxy for', () => {
  /**
   * The order changed on purpose: the predicate now runs first, because it selects WHICH budget lane
   * applies. The property the order assertion protected — that the rail cannot be lost to a bad or broken
   * predicate — is asserted here directly on the failure modes, which is what actually matters.
   */
  const spying = (over: Partial<AgentDriveGate> = {}): { gate: AgentDriveGate; calls: string[] } => {
    const calls: string[] = [];
    const budget = new OriginBudget({ limit: 2, anonymousLimit: 4 });
    const spend = budget.spend.bind(budget);
    return {
      calls,
      gate: {
        budget: {
          ...budget,
          spend: (u: string, o?: { originClass?: 'authenticated' | 'anonymous' }) => { calls.push(`budget:${o?.originClass ?? 'default'}`); return spend(u, o); },
          limitFor: (c: 'authenticated' | 'anonymous') => budget.limitFor(c),
          snapshot: () => budget.snapshot(),
          totalSpent: budget.totalSpent,
        } as unknown as OriginBudget,
        ...over,
      },
    };
  };

  it('charges the budget even when the predicate THROWS — an instrumentation or cookie-jar failure must never be a way to spend an origin for free', async () => {
    const { gate, calls } = spying({ isAuthenticatedOrigin: () => { throw new Error('jar unavailable'); } });
    await checkAgentDrive(gate, 'https://a.example/');
    expect(calls.some((c) => c.startsWith('budget:'))).toBe(true);
  });

  it('charges a THROWING predicate against the TIGHT lane: ignorance can only tighten the rail, never loosen it', async () => {
    const { gate, calls } = spying({ isAuthenticatedOrigin: () => { throw new Error('jar unavailable'); } });
    await checkAgentDrive(gate, 'https://a.example/');
    expect(calls).toContain('budget:authenticated');
  });

  it('charges an ABSENT predicate against the tight lane too — with no way to classify an origin there is no basis to relax pacing on it', async () => {
    const { gate, calls } = spying();
    await checkAgentDrive(gate, 'https://a.example/');
    expect(calls).toContain('budget:authenticated');
  });

  it('does NOT fire a card when the predicate threw, even though it charged the tight lane: prompting a human off a failed read would nag on every transient error and teach them to click through', async () => {
    let asked = 0;
    const { gate } = spying({
      isAuthenticatedOrigin: () => { throw new Error('jar unavailable'); },
      approvalSurfaceAttached: () => true,
      requestApproval: async () => { asked += 1; return 'approved'; },
    });
    expect((await checkAgentDrive(gate, 'https://a.example/')).ok).toBe(true);
    expect(asked).toBe(0);
  });

  it('BOUNDS a predicate that never settles: it reads a live cookie jar and evaluates script in the tab, and a read that stalls rather than rejects would wedge the navigation this gate is gating — measured, it did, in a live e2e', async () => {
    const started = Date.now();
    const g: AgentDriveGate = {
      budget: new OriginBudget({ limit: 5, anonymousLimit: 500 }),
      isAuthenticatedOrigin: () => new Promise<boolean>(() => {}),
      predicateTimeoutMs: 40,
    };
    expect((await checkAgentDrive(g, 'https://a.example/')).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('charges a STALLED predicate against the tight lane and fires no card — a stall is just another way of not knowing, so it resolves like every other unknown', async () => {
    const g: AgentDriveGate = {
      budget: new OriginBudget({ limit: 1, anonymousLimit: 500 }),
      isAuthenticatedOrigin: () => new Promise<boolean>(() => {}),
      predicateTimeoutMs: 30,
      approvalSurfaceAttached: () => true,
      requestApproval: async () => 'approved',
    };
    expect((await checkAgentDrive(g, 'https://a.example/')).ok).toBe(true);
    // Tight lane of 1 ⇒ the second hop is refused. Had the stall fallen to the anonymous lane it would pass.
    const v = await checkAgentDrive(g, 'https://a.example/');
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('origin_budget_exhausted');
  });

  it('evaluates the predicate exactly ONCE per navigation — two reads of a live cookie jar can disagree, and a hop charged as anonymous but carded as signed in is incoherent', async () => {
    let calls = 0;
    const gate: AgentDriveGate = {
      budget: new OriginBudget({ limit: 5 }),
      isAuthenticatedOrigin: () => { calls += 1; return true; },
    };
    await checkAgentDrive(gate, 'https://a.example/');
    expect(calls).toBe(1);
  });
});

describe('D9 — the two budget lanes', () => {
  it('gives an anonymous origin the relaxed limit: over-driving a public docs site costs a rate-limit, and capping ordinary research at the signed-in number failed users for nothing', async () => {
    const g: AgentDriveGate = {
      budget: new OriginBudget({ limit: 2, anonymousLimit: 5 }),
      isAuthenticatedOrigin: () => false,
    };
    for (let i = 0; i < 5; i++) expect((await checkAgentDrive(g, 'https://docs.example/p')).ok, `hop ${i}`).toBe(true);
    expect((await checkAgentDrive(g, 'https://docs.example/p')).ok).toBe(false);
  });

  it('keeps a signed-in origin on the tight limit — over-driving one costs the human\'s ACCOUNT, which is the largest unpriced risk in the program', async () => {
    const g: AgentDriveGate = {
      budget: new OriginBudget({ limit: 2, anonymousLimit: 500 }),
      isAuthenticatedOrigin: () => true,
      preGrant: new PreGrantStore(),
      approvalSurfaceAttached: () => true,
      requestApproval: async () => 'approved',
    };
    expect((await checkAgentDrive(g, 'https://signed.example/a')).ok).toBe(true);
    expect((await checkAgentDrive(g, 'https://signed.example/b')).ok).toBe(true);
    const v = await checkAgentDrive(g, 'https://signed.example/c');
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('origin_budget_exhausted');
  });

  it('tracks the two lanes per origin, so a heavily-read public site cannot consume a signed-in site\'s allowance', async () => {
    const g: AgentDriveGate = {
      budget: new OriginBudget({ limit: 1, anonymousLimit: 3 }),
      isAuthenticatedOrigin: (o) => o === 'https://signed.example',
      preGrant: new PreGrantStore(),
      approvalSurfaceAttached: () => true,
      requestApproval: async () => 'approved',
    };
    for (let i = 0; i < 3; i++) expect((await checkAgentDrive(g, 'https://anon.example/')).ok).toBe(true);
    expect((await checkAgentDrive(g, 'https://anon.example/')).ok).toBe(false);
    expect((await checkAgentDrive(g, 'https://signed.example/')).ok).toBe(true);
  });

  it('re-classifies on the CURRENT verdict, so an origin the human signs into mid-session starts being measured against the tight limit from that point', () => {
    const b = new OriginBudget({ limit: 2, anonymousLimit: 10 });
    b.spend('https://x.example/', { originClass: 'anonymous' });
    b.spend('https://x.example/', { originClass: 'anonymous' });
    const now = b.spend('https://x.example/', { originClass: 'authenticated' });
    expect(now.ok).toBe(false);
    expect(now.limit).toBe(2);
  });

  it('never lets a misconfigured anonymous limit end up TIGHTER than the signed-in one — inverting them would make public pages the restricted case', () => {
    const b = new OriginBudget({ limit: 50, anonymousLimit: 5 });
    expect(b.limitFor('anonymous')).toBe(50);
    expect(b.limitFor('authenticated')).toBe(50);
  });

  it('defaults an unspecified class to the tight lane, so a caller that forgets under-serves rather than over-drives', () => {
    const b = new OriginBudget({ limit: 3, anonymousLimit: 99 });
    expect(b.spend('https://x.example/').limit).toBe(3);
    expect(b.spend('https://x.example/').originClass).toBe('authenticated');
  });

  it('reports each origin\'s lane in the snapshot, because a visible counter against an invisible limit explains nothing', () => {
    const b = new OriginBudget({ limit: 2, anonymousLimit: 7 });
    b.spend('https://anon.example/', { originClass: 'anonymous' });
    b.spend('https://signed.example/', { originClass: 'authenticated' });
    const snap = b.snapshot();
    expect(snap.find((e) => e.origin === 'https://anon.example')).toMatchObject({ originClass: 'anonymous', limit: 7 });
    expect(snap.find((e) => e.origin === 'https://signed.example')).toMatchObject({ originClass: 'authenticated', limit: 2 });
  });
});
