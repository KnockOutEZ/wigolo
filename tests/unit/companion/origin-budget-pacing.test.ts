import { describe, expect, it } from 'vitest';
import {
  OriginBudget,
  DEFAULT_ORIGIN_BUDGET,
  DEFAULT_ANONYMOUS_ORIGIN_BUDGET,
  DEFAULT_ORIGIN_BUDGET_WINDOW_MS,
  budgetRefusal,
} from '../../../src/companion/origin-budget.js';

/**
 * SD6-C2 (mini-spec §5, ruling A-17-9) — pin 2 replaces the provisional windowless counter on the
 * AUTHENTICATED lane with a sliding 10-minute window at 60. The anonymous lane stays windowless at
 * 300 on purpose: pin 2 names only the authenticated lane and the anonymous constant is parked
 * pending escalation-counter data, so converting it too would be an unpinned design change.
 *
 * A fake clock is the only way to assert the property that matters. With the real clock every spend
 * in a test lands in the same window, so a windowless counter and a windowed one are observationally
 * identical — which is exactly how a window that never refills would ship green.
 */

/** Injectable clock. `advance` is the only thing that moves it, so no test depends on wall time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('OriginBudget — the pin-2 authenticated sliding window', () => {
  it('ships pin 2\'s numbers as the defaults: 60 requests, 10-minute window', () => {
    // The pin is the source of these two, not a local guess. A test that hardcoded them somewhere
    // else would mirror the numbers with nothing keeping the copies in step.
    expect(DEFAULT_ORIGIN_BUDGET).toBe(60);
    expect(DEFAULT_ORIGIN_BUDGET_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(DEFAULT_ANONYMOUS_ORIGIN_BUDGET).toBe(300);
  });

  it('refuses the 61st request inside the window and says when it can be retried', () => {
    const clock = fakeClock();
    const b = new OriginBudget({ now: clock.now });
    // 60 requests spread across the first half of the window — all allowed.
    for (let i = 0; i < 60; i++) {
      const v = b.spend('https://signed.example/a');
      expect(v.allowed).toBe(true);
      clock.advance(1_000);
    }
    const capped = b.spend('https://signed.example/b');
    expect(capped.allowed).toBe(false);
    expect(capped.reason).toBe('pacing_cap');
    expect(capped.used).toBe(60);
    expect(capped.limit).toBe(60);
    // The oldest of the 60 stamps was 60s ago, so a slot frees 9 minutes from now. A refusal that
    // could not say this leaves the studio gate with nothing to offer but "end run".
    expect(capped.retry_after_ms).toBe(DEFAULT_ORIGIN_BUDGET_WINDOW_MS - 60_000);
  });

  it('allows again once the window slides past the oldest request — the window REFILLS', () => {
    const clock = fakeClock();
    const b = new OriginBudget({ limit: 2, windowMs: 10_000, now: clock.now });
    expect(b.spend('https://signed.example/').allowed).toBe(true);
    clock.advance(4_000);
    expect(b.spend('https://signed.example/').allowed).toBe(true);
    const capped = b.spend('https://signed.example/');
    expect(capped.allowed).toBe(false);
    expect(capped.retry_after_ms).toBe(6_000);

    // One millisecond short of the retry the cap still holds — otherwise "refills" would only mean
    // "eventually", and a caller that honoured retry_after_ms would come back to a second refusal.
    clock.advance(5_999);
    expect(b.spend('https://signed.example/').allowed).toBe(false);
    clock.advance(1);
    const after = b.spend('https://signed.example/');
    expect(after.allowed).toBe(true);
    // Exactly ONE slot freed: the second request is still inside the window.
    expect(after.used).toBe(2);
    expect(b.spend('https://signed.example/').allowed).toBe(false);
  });

  it('counts per origin, not per session — one busy origin cannot cap another', () => {
    const clock = fakeClock();
    const b = new OriginBudget({ limit: 1, windowMs: 10_000, now: clock.now });
    expect(b.spend('https://a.example/').allowed).toBe(true);
    expect(b.spend('https://a.example/').allowed).toBe(false);
    expect(b.spend('https://b.example/').allowed).toBe(true);
  });

  it('keeps the anonymous lane windowless at its session-cumulative limit', () => {
    // Parked deliberately (§5): time passing must NOT hand an anonymous origin more requests, or
    // this issue would have silently redesigned the lane it declares a non-goal.
    const clock = fakeClock();
    const b = new OriginBudget({ limit: 2, anonymousLimit: 3, windowMs: 10_000, now: clock.now });
    for (let i = 0; i < 3; i++) {
      expect(b.spend('https://anon.example/', { originClass: 'anonymous' }).allowed).toBe(true);
    }
    const capped = b.spend('https://anon.example/', { originClass: 'anonymous' });
    expect(capped.allowed).toBe(false);
    expect(capped.reason).toBe('pacing_cap');
    // No window to wait for, so no retry is offered: the honest options are raise or end.
    expect(capped.retry_after_ms).toBeUndefined();
    expect(capped.windowMs).toBeNull();
    clock.advance(60 * 60 * 1000);
    expect(b.spend('https://anon.example/', { originClass: 'anonymous' }).allowed).toBe(false);
  });

  it('charges requests made while an origin looked anonymous against the tight window once it does not', () => {
    // The ledger is sticky, so an origin becomes authenticated mid-session. Those earlier requests
    // were still requests to the origin the human is signed in to — dropping them from the window
    // would hand the tight lane a free head start exactly when the account exposure appears.
    const clock = fakeClock();
    const b = new OriginBudget({ limit: 2, anonymousLimit: 10, windowMs: 10_000, now: clock.now });
    b.spend('https://x.example/', { originClass: 'anonymous' });
    b.spend('https://x.example/', { originClass: 'anonymous' });
    const now = b.spend('https://x.example/', { originClass: 'authenticated' });
    expect(now.allowed).toBe(false);
    expect(now.limit).toBe(2);
    expect(now.retry_after_ms).toBe(10_000);
  });
});

describe('OriginBudget — fail-closed direction', () => {
  it('defaults an unstated class to the windowed tight lane, so a caller that cannot know under-serves', () => {
    // This is the F5-absent / F5-throwing case seen from here: the gate charges the budget without a
    // class, and the rail must land on the AUTHENTICATED window rather than the relaxed 300.
    const clock = fakeClock();
    const b = new OriginBudget({ limit: 1, anonymousLimit: 99, windowMs: 10_000, now: clock.now });
    const first = b.spend('https://unknown.example/');
    expect(first.originClass).toBe('authenticated');
    expect(first.limit).toBe(1);
    expect(first.windowMs).toBe(10_000);
    const capped = b.spend('https://unknown.example/');
    expect(capped.allowed).toBe(false);
    expect(capped.retry_after_ms).toBe(10_000);
  });

  it('never lets a configured window make the tight lane looser than the relaxed one', () => {
    // A window is only a tightening. `limitFor` still clamps the lanes, and the anonymous lane
    // must not acquire a window that would let it refill.
    const b = new OriginBudget({ limit: 50, anonymousLimit: 5, windowMs: 10_000 });
    expect(b.limitFor('anonymous')).toBe(50);
    expect(b.windowMsFor('anonymous')).toBeNull();
    expect(b.windowMsFor('authenticated')).toBe(10_000);
  });

  it('falls back to the default window on a zero, negative or non-finite configured one', () => {
    // Same argument as the limit: a "0" in a config file is a typo, and honouring it would make
    // every window empty — a rail that never fires, indistinguishable from a removed one.
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const b = new OriginBudget({ windowMs: bad });
      expect(b.windowMsFor('authenticated')).toBe(DEFAULT_ORIGIN_BUDGET_WINDOW_MS);
    }
  });

  it('falls back to the default limit on a zero or negative configured one', () => {
    expect(new OriginBudget({ limit: 0 }).spend('https://a.example/').limit).toBe(DEFAULT_ORIGIN_BUDGET);
    expect(new OriginBudget({ limit: -5 }).spend('https://a.example/').limit).toBe(DEFAULT_ORIGIN_BUDGET);
    expect(new OriginBudget({ limit: Number.NaN }).spend('https://a.example/').limit).toBe(DEFAULT_ORIGIN_BUDGET);
  });
});

describe('OriginBudget — the structured cap result the studio gate branches on', () => {
  it('carries allowed/reason/retry_after_ms, not a bare refusal', () => {
    // A2/seq:480 raises a pending decision ("raise window / wait / end run") off this shape. A bare
    // `ok: false` cannot tell it whether waiting is even an option.
    const b = new OriginBudget({ limit: 1, windowMs: 10_000, now: () => 5_000 });
    b.spend('https://a.example/');
    const capped = b.spend('https://a.example/');
    expect(capped).toMatchObject({
      allowed: false,
      reason: 'pacing_cap',
      retry_after_ms: 10_000,
      origin: 'https://a.example',
      originClass: 'authenticated',
      windowMs: 10_000,
    });
  });

  it('keeps `ok` in step with `allowed` on both paths — one boolean, two names, no drift', () => {
    // `ok` is the field the extracted domain layer reads across the `wigolo/companion` seam. Both
    // are minted from one expression; this asserts that, because two booleans that can disagree
    // would let a cap be refused on one surface and allowed on another.
    const b = new OriginBudget({ limit: 1, windowMs: 10_000 });
    const ok = b.spend('https://a.example/');
    expect(ok.ok).toBe(ok.allowed);
    expect(ok.reason).toBeUndefined();
    const capped = b.spend('https://a.example/');
    expect(capped.ok).toBe(capped.allowed);
    expect(capped.ok).toBe(false);
  });

  it('does not charge or refuse an unattributable url', () => {
    const b = new OriginBudget({ limit: 1 });
    for (let i = 0; i < 5; i++) expect(b.spend('not a url').allowed).toBe(true);
    expect(b.totalSpent).toBe(0);
  });

  it('reports the window count, not the session total, in the visible counters', () => {
    // Law 11: the counter the human sees has to be the one the limit is compared against, or a
    // rail that fires at 60 while the panel reads 143 looks like a bug.
    const clock = fakeClock();
    const b = new OriginBudget({ limit: 5, windowMs: 10_000, now: clock.now });
    b.spend('https://a.example/');
    b.spend('https://a.example/');
    clock.advance(11_000);
    b.spend('https://a.example/');
    expect(b.snapshot()).toEqual([
      { origin: 'https://a.example', used: 1, limit: 5, originClass: 'authenticated' },
    ]);
    // The session total is a different question and still answers cumulatively.
    expect(b.totalSpent).toBe(3);
  });

  it('reports an anonymous origin cumulatively, because that lane has no window', () => {
    const clock = fakeClock();
    const b = new OriginBudget({ limit: 5, anonymousLimit: 9, windowMs: 10_000, now: clock.now });
    b.spend('https://anon.example/', { originClass: 'anonymous' });
    clock.advance(11_000);
    b.spend('https://anon.example/', { originClass: 'anonymous' });
    expect(b.snapshot()).toEqual([
      { origin: 'https://anon.example', used: 2, limit: 9, originClass: 'anonymous' },
    ]);
  });
});

describe('budgetRefusal — the sentence a capped run shows', () => {
  it('adds the retry to the sentence when a window will refill it', () => {
    const r = budgetRefusal({
      ok: false, origin: 'https://a.example', used: 60, limit: 60,
      originClass: 'authenticated', retry_after_ms: 4 * 60 * 1000 + 30_000,
    });
    expect(r.reason).toBe('origin_budget_exhausted');
    expect(r.message).toContain('60 of 60');
    expect(r.message).toMatch(/5 minutes/);
    expect('error_reason' in r).toBe(false);
  });

  it('leaves the sentence alone when nothing will refill — the anonymous lane', () => {
    const r = budgetRefusal({ ok: false, origin: 'https://a.example', used: 3, limit: 3, originClass: 'anonymous' });
    expect(r.message).toContain('3 of 3');
    expect(r.message).not.toMatch(/minute/);
  });
});
