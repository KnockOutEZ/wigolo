import { describe, it, expect, vi } from 'vitest';
import { checkAgentDrive, type AgentDriveGate } from '../../../src/studio/agent-drive-gate.js';
import { OriginBudget, DEFAULT_ORIGIN_BUDGET, budgetOrigin } from '../../../src/studio/origin-budget.js';
import { PreGrantStore } from '../../../src/studio/pre-grant.js';

/**
 * S9 / D9 — the pacing budget and the authenticated-use grant card.
 *
 * The single most important property under test is the DECOUPLING: the budget applies to every origin and
 * never consults the authenticated-origin predicate, while only the card does. That is what makes an F5
 * false negative cost a prompt instead of an account. A test suite that only exercised the card would let a
 * refactor quietly make the rail depend on the predicate and still pass.
 */

function gate(over: Partial<AgentDriveGate> = {}): AgentDriveGate {
  return { budget: new OriginBudget({ limit: 3 }), ...over };
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
      expect(v.error_reason).toContain('3 of 3');
      expect(v.error_reason).toContain('https://a.example');
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
      { origin: 'https://a.example', used: 2, limit: 5 },
      { origin: 'https://b.example', used: 1, limit: 5 },
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

describe('D9 — the order of the two halves', () => {
  it('the budget is charged BEFORE the predicate is consulted', async () => {
    // If the card ran first, a predicate false negative would skip past both checks. Order is the mechanism
    // that makes the rail independent of the predicate, so it is asserted directly.
    const calls: string[] = [];
    const budget = new OriginBudget({ limit: 5 });
    const spend = budget.spend.bind(budget);
    const g: AgentDriveGate = {
      budget: { ...budget, spend: (u: string) => { calls.push('budget'); return spend(u); }, snapshot: () => budget.snapshot(), totalSpent: budget.totalSpent } as unknown as OriginBudget,
      isAuthenticatedOrigin: () => { calls.push('predicate'); return false; },
    };
    await checkAgentDrive(g, 'https://a.example/');
    expect(calls).toEqual(['budget', 'predicate']);
  });
});
