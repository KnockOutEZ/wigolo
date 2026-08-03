import { describe, it, expect, vi } from 'vitest';
import { requestHumanSolve, type HumanSolveBridgeDeps } from '../../../src/studio/human-solve-bridge.js';

/**
 * S9B slice 2 — the human-solve request.
 *
 * The capability is "open this gated page for me now": a human, on their own machine, opens a door an
 * automated fetch could not. Core ALREADY has a human-solve rung (`browser-pool.ts:1433`), but it asks
 * the human to solve in a **Playwright-headful** window — the exact launch mode measured to set
 * `navigator.webdriver === true` and flip BotD to `headless_chrome`. So today the product's answer to
 * "a human must solve this" is *solve it in a browser that already announced itself as automated.*
 * This module re-points that moment at the Studio substrate, which measured clean.
 *
 * Every dependency is injected, exactly as `human-solve.ts` does it: no browser import, no Electron,
 * no store. The tests below encode the ORDER of the gates, because the order is the security property.
 */

function deps(over: Partial<HumanSolveBridgeDeps> = {}): HumanSolveBridgeDeps {
  return {
    origin: 'https://walled.example',
    challengeClass: 'interactive',
    isCredentialContext: vi.fn(async () => false),
    approvalSurfaceAttached: vi.fn(() => true),
    requestApproval: vi.fn(async () => 'approved' as const),
    reclaimToHuman: vi.fn(),
    regrantToAgent: vi.fn(),
    awaitCleared: vi.fn(async () => ({
      cleared: true,
      clearance: { name: 'cf_clearance', value: 'SECRET-TOKEN-VALUE', domain: '.walled.example', expires: 1_800_000_000 },
    })),
    ...over,
  };
}

describe('requestHumanSolve — the class gate', () => {
  // solve-ladder.ts:95-97 returns UNSOLVED before ANY rung for `behavioral` and `none`. There is
  // nothing for a human to click on a behavioral block, so prompting one would be a false promise —
  // and measured on 2026-08-03, behavioral was EVERY hard wall on the walled-target set.
  for (const cls of ['behavioral', 'none'] as const) {
    it(`refuses class '${cls}' without touching the human`, async () => {
      const d = deps({ challengeClass: cls });
      const r = await requestHumanSolve(d);
      expect(r.solved).toBe(false);
      if (!r.solved) expect(r.reason).toBe('not_solvable_class');
      expect(d.requestApproval).not.toHaveBeenCalled();
      expect(d.reclaimToHuman).not.toHaveBeenCalled();
      // Not even the credential probe: an unsolvable class is refused before any host read.
      expect(d.isCredentialContext).not.toHaveBeenCalled();
    });
  }

  for (const cls of ['interactive', 'image'] as const) {
    it(`accepts class '${cls}' — the two classes a human can actually clear`, async () => {
      const r = await requestHumanSolve(deps({ challengeClass: cls }));
      expect(r.solved).toBe(true);
    });
  }
});

describe('requestHumanSolve — the credential boundary is the brightest line in the phase', () => {
  it('refuses a credential context and NEVER shows a card', async () => {
    // Solving a challenge proves you are a person. Logging in proves you are a PARTICULAR person and
    // hands over a credential. The first is delegable with a click; the second is credential.ts's hard
    // refusal and stays refused. Showing a card here would train the human to click through login
    // prompts — the single most expensive habit this program could teach.
    const d = deps({ isCredentialContext: async () => true });
    const r = await requestHumanSolve(d);
    expect(r.solved).toBe(false);
    if (!r.solved) expect(r.reason).toBe('credential_context');
    expect(d.requestApproval).not.toHaveBeenCalled();
    expect(d.reclaimToHuman).not.toHaveBeenCalled();
    expect(d.awaitCleared).not.toHaveBeenCalled();
  });

  it('treats a THROWING credential probe as a credential context — fail-closed, and still no card', async () => {
    // An unreadable page is treated as a login, not as safe. Same rule studio-fetch.ts already applies.
    const d = deps({ isCredentialContext: async () => { throw new Error('page gone'); } });
    const r = await requestHumanSolve(d);
    expect(r.solved).toBe(false);
    if (!r.solved) expect(r.reason).toBe('credential_context');
    expect(d.requestApproval).not.toHaveBeenCalled();
  });

  it('runs the credential probe BEFORE the approval surface check, so a login never reaches a human', async () => {
    // Ordering assertion. If the surface check ran first, an unattended login page would report
    // `unattended` — losing the more specific and stronger credential refusal.
    const calls: string[] = [];
    const d = deps({
      isCredentialContext: async () => { calls.push('credential'); return true; },
      approvalSurfaceAttached: () => { calls.push('surface'); return false; },
    });
    const r = await requestHumanSolve(d);
    expect(calls).toEqual(['credential']);
    if (!r.solved) expect(r.reason).toBe('credential_context');
  });
});

describe('requestHumanSolve — unattended contexts FAIL FAST', () => {
  it('refuses immediately when no approval surface is attached, and never waits', async () => {
    // §5.1: waiting out a timeout on a card nobody can see is a hang, not a safety property. The agent
    // learns nothing at minute two it did not know in millisecond one, and the caller pays the timeout.
    const d = deps({ approvalSurfaceAttached: () => false });
    const r = await requestHumanSolve(d);
    expect(r.solved).toBe(false);
    if (!r.solved) expect(r.reason).toBe('unattended');
    expect(d.requestApproval).not.toHaveBeenCalled();
    // The proof that nothing waited: the poll was never even armed.
    expect(d.awaitCleared).not.toHaveBeenCalled();
  });

  it('counts an ABSENT surface probe as unattended — fail-closed on an unwired host', async () => {
    const d = deps({ approvalSurfaceAttached: undefined });
    const r = await requestHumanSolve(d);
    expect(r.solved).toBe(false);
    if (!r.solved) expect(r.reason).toBe('unattended');
  });

  it('counts an ABSENT requestApproval as unattended rather than proceeding un-consented', async () => {
    const d = deps({ requestApproval: undefined });
    const r = await requestHumanSolve(d);
    expect(r.solved).toBe(false);
    if (!r.solved) expect(r.reason).toBe('unattended');
    expect(d.reclaimToHuman).not.toHaveBeenCalled();
  });
});

describe('requestHumanSolve — only an explicit approval proceeds', () => {
  for (const decision of ['refused', 'timeout', 'superseded'] as const) {
    it(`treats '${decision}' as a refusal and never reclaims control`, async () => {
      const d = deps({ requestApproval: async () => decision });
      const r = await requestHumanSolve(d);
      expect(r.solved).toBe(false);
      if (!r.solved) expect(r.reason).toBe('not_granted');
      expect(d.reclaimToHuman).not.toHaveBeenCalled();
      expect(d.awaitCleared).not.toHaveBeenCalled();
    });
  }

  it('reclaims to the human on approval and ALWAYS re-grants to the agent afterwards', async () => {
    const d = deps();
    await requestHumanSolve(d);
    expect(d.reclaimToHuman).toHaveBeenCalledTimes(1);
    expect(d.regrantToAgent).toHaveBeenCalledTimes(1);
  });

  it('re-grants even when the solve TIMES OUT — a failed solve must not strand the session with the human', async () => {
    // The failure mode this guards: an un-cleared challenge leaving control parked on the human
    // forever, so every later agent action returns `not_holder` and the session looks wedged.
    const d = deps({ awaitCleared: async () => ({ cleared: false }) });
    const r = await requestHumanSolve(d);
    expect(r.solved).toBe(false);
    if (!r.solved) expect(r.reason).toBe('timeout');
    expect(d.regrantToAgent).toHaveBeenCalledTimes(1);
  });

  it('degrades a THROWING poll to a refusal — and reports it distinctly from a timeout', async () => {
    // This rung is opportunistic. A bridge fault must never turn a clean `blocked_by_challenge` report
    // into a crash for the whole fetch. And the reason is separate from `timeout` because the two call
    // for different next actions: a timeout means the human did not finish, a fault means the session
    // broke and asking again is reasonable.
    const d = deps({ awaitCleared: async () => { throw new Error('cdp died'); } });
    const r = await requestHumanSolve(d);
    expect(r.solved).toBe(false);
    if (!r.solved) expect(r.reason).toBe('solve_failed');
    expect(d.regrantToAgent).toHaveBeenCalledTimes(1);
  });
});

describe('requestHumanSolve — the clearance VALUE is structurally unreachable from the return', () => {
  it('never returns the cookie value, only its expiry facts', async () => {
    // STRUCTURAL, not habitual. The harvested cookie leaves through the injected `onClearance` sink,
    // so a caller shaping an agent-facing payload CANNOT accidentally include the token: it was never
    // in the value this function returned. Same move F5 makes by giving CookieFacts no `value` field.
    const r = await requestHumanSolve(deps());
    expect(r.solved).toBe(true);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('SECRET-TOKEN-VALUE');
    expect(serialized).not.toContain('cf_clearance');
  });

  it('hands the cookie to the host-only sink so the store can record it', async () => {
    const onClearance = vi.fn();
    const r = await requestHumanSolve(deps({ onClearance }));
    expect(r.solved).toBe(true);
    expect(onClearance).toHaveBeenCalledTimes(1);
    expect(onClearance.mock.calls[0][0]).toMatchObject({ name: 'cf_clearance', value: 'SECRET-TOKEN-VALUE' });
  });

  it('surfaces the expiry as DATA — an ISO instant and integer seconds, read never derived', async () => {
    const r = await requestHumanSolve(deps());
    expect(r.solved).toBe(true);
    if (r.solved) {
      expect(r.expiry?.expires_at).toBe(new Date(1_800_000_000_000).toISOString());
      expect(Number.isInteger(r.expiry?.seconds_remaining)).toBe(true);
      // Measured 2026-08-03: Cloudflare re-evaluates on a ~12.5-minute cadence and may re-challenge
      // long before the cookie's stated expiry (one zone's cookie claimed 365 DAYS). So expires_at is
      // an upper bound on a horizon, never a guarantee, and the flag says so as data rather than prose.
      expect(r.expiry?.revalidates).toBe(true);
    }
  });

  it('OMITS the expiry rather than defaulting it when the cookie carries no usable expiry', async () => {
    // Never guess, and never default to 30 minutes: the 1d measurement found a zone whose cookie
    // claimed a year. A fabricated horizon is worse than an absent one, because a planner would trust it.
    const d = deps({
      awaitCleared: async () => ({ cleared: true, clearance: { name: 'cf_clearance', value: 'v', domain: 'd', expires: -1 } }),
    });
    const r = await requestHumanSolve(d);
    expect(r.solved).toBe(true);
    if (r.solved) expect(r.expiry).toBeUndefined();
  });

  it('still counts as solved when the challenge cleared but no clearance cookie was found', async () => {
    // The DOM can clear without a cf_clearance being readable (a non-Cloudflare wall, or a jar read
    // that failed). The page is open either way — refusing here would throw away a successful solve.
    const onClearance = vi.fn();
    const d = deps({ awaitCleared: async () => ({ cleared: true }), onClearance });
    const r = await requestHumanSolve(d);
    expect(r.solved).toBe(true);
    if (r.solved) expect(r.expiry).toBeUndefined();
    expect(onClearance).not.toHaveBeenCalled();
  });
});

describe('requestHumanSolve — a solve is NOT a login', () => {
  it('exposes no ledger writer at all, so a solve can never mark an origin authenticated', async () => {
    // The authenticated-origin ledger is F5 clause (a): "a human logged into this origin". A solved
    // challenge is not a login, and if a solve wrote that entry it would silently promote the origin to
    // the tight D9 lane AND make every later agent visit card-gated — punishing the user for a wall
    // they cleared. Asserted STRUCTURALLY: the dependency does not exist on the interface.
    const d = deps();
    expect(Object.keys(d)).not.toContain('recordAuthenticatedOrigin');
    const r = await requestHumanSolve(d);
    expect(r.solved).toBe(true);
  });
});

describe('requestHumanSolve — D10(a) counters', () => {
  it('counts the card and its outcome without recording the origin', async () => {
    const bump = vi.fn();
    await requestHumanSolve(deps({ bump }));
    expect(bump).toHaveBeenCalledWith('cardShown');
    expect(bump).toHaveBeenCalledWith('cardApproved');
    // Aggregate integers only — no origin ever reaches the counter file (D10(a)).
    for (const call of bump.mock.calls) expect(call[0]).not.toContain('walled.example');
  });

  it('counts an unattended refusal distinctly from a human refusal', async () => {
    const unattended = vi.fn();
    await requestHumanSolve(deps({ approvalSurfaceAttached: () => false, bump: unattended }));
    expect(unattended).toHaveBeenCalledWith('cardUnattended');
    expect(unattended).not.toHaveBeenCalledWith('cardShown');

    const refused = vi.fn();
    await requestHumanSolve(deps({ requestApproval: async () => 'refused', bump: refused }));
    expect(refused).toHaveBeenCalledWith('cardShown');
    expect(refused).toHaveBeenCalledWith('cardRefused');
  });
});
