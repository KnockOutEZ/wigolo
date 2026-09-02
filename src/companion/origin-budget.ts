/**
 * S9 / D9 — the PER-ORIGIN PACING BUDGET.
 *
 * This is the rail that bounds the account-ban blast radius, and the invariant that matters is what
 * CANNOT be lost: the budget applies to EVERY origin the agent drives, authenticated or not, and its
 * limit is always finite. F5 decides whether the human gets a consent CARD; this decides how hard the
 * agent may hit a site. So an F5 false negative — the expensive direction, an SPA holding its session in
 * localStorage that F5 cannot see — costs the prompt and leaves the safety rail standing.
 *
 * TWO LANES, because one number conflated two risks that differ by orders of magnitude. Over-driving an
 * anonymous docs site costs a rate-limit and a retry. Over-driving an origin the human is signed in to
 * costs the human's ACCOUNT — the largest unpriced risk in the program. A single limit had to be set
 * tight enough for the second case, which made ordinary research on public pages fail for no reason.
 *
 * F5 therefore selects WHICH limit, and the selection is FAIL-CLOSED IN ONE DIRECTION ONLY: an absent
 * predicate, a predicate that throws, and any other absence of information all yield the TIGHT limit. A
 * predicate failure can only ever tighten the rail, never loosen it. That is the property the original
 * "the budget never consults F5" rule was protecting, and it is now asserted directly on the failure
 * modes instead of on the call order — which is stronger, because call order was only ever a proxy.
 *
 * It is a FIRST-CLASS, VISIBLE feature, not a hidden throttle. `snapshot()` exists so the counters can be
 * surfaced in status output: a limit the user cannot see is indistinguishable from a bug when it fires.
 *
 * Scope is per-origin, per-session — one instance per session, matching `PreGrantStore`. Per-site would
 * under-protect (`accounts.google.com` and `docs.google.com` are not the same exposure) and per-request
 * would be meaningless.
 *
 * BOTH DEFAULTS ARE STILL PROVISIONAL. Nothing in the program yet knows what a real research task spends
 * on one origin. The split is a correction to a category error, not an answer: the numbers are to be
 * revisited against the escalation-rate counters this same phase collects.
 */

/** Signed-in origins: the tight lane. Unchanged, and the value every unknown falls back to. */
export const DEFAULT_ORIGIN_BUDGET = 20;

/**
 * Anonymous origins: the relaxed lane. A few hundred, because the worst case here is a rate-limit on a
 * public page rather than a flagged account, and a research task that reads 40 pages of one docs site is
 * ordinary rather than abusive.
 */
export const DEFAULT_ANONYMOUS_ORIGIN_BUDGET = 300;

/** Which lane an origin is charged against. `unknown` is charged as `authenticated` — see below. */
export type OriginClass = 'authenticated' | 'anonymous';

export interface OriginBudgetVerdict {
  ok: boolean;
  origin: string;
  used: number;
  limit: number;
  originClass: OriginClass;
}

export interface OriginBudgetEntry {
  origin: string;
  used: number;
  limit: number;
  originClass: OriginClass;
}

/** Reduce a URL to the origin the budget is keyed on. Unparseable ⇒ null (the caller decides). */
export function budgetOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

export class OriginBudget {
  private readonly limit: number;
  private readonly anonymousLimit: number;
  private readonly used = new Map<string, { used: number; originClass: OriginClass }>();

  constructor(opts: { limit?: number; anonymousLimit?: number } = {}) {
    // A non-positive or non-finite configured limit would silently disable the rail. Fall back to the
    // default rather than honouring it: "0" in a config file is far more likely a typo than an intent to
    // block every navigation, and a negative one has no meaning at all.
    this.limit = sane(opts.limit, DEFAULT_ORIGIN_BUDGET);
    // The anonymous lane can never end up TIGHTER than the signed-in one. A config that inverted them
    // would silently make public pages the restricted case, which is the opposite of the intent.
    this.anonymousLimit = Math.max(sane(opts.anonymousLimit, DEFAULT_ANONYMOUS_ORIGIN_BUDGET), this.limit);
  }

  /** The limit that applies to a class. Exposed so status output can print both lanes. */
  limitFor(originClass: OriginClass): number {
    return originClass === 'anonymous' ? this.anonymousLimit : this.limit;
  }

  /**
   * Charge one navigation against `url`'s origin. Returns the verdict AND the live counters, so the caller
   * can put real numbers in the refusal instead of an opaque "budget exceeded".
   *
   * An unparseable URL is NOT charged and NOT refused here: it cannot be attributed to an origin, and the
   * SSRF fence downstream is what rejects a URL the agent should not reach. Silently charging it to some
   * bucket would make the visible counters wrong, which is worse than not counting it.
   */
  spend(url: string, opts: { originClass?: OriginClass } = {}): OriginBudgetVerdict {
    // DEFAULTS TO THE TIGHT LANE. A caller that does not say, or cannot know, gets the signed-in limit —
    // so forgetting to pass the class under-serves rather than over-drives.
    const originClass: OriginClass = opts.originClass === 'anonymous' ? 'anonymous' : 'authenticated';
    const limit = this.limitFor(originClass);
    const origin = budgetOrigin(url);
    if (!origin) return { ok: true, origin: '', used: 0, limit, originClass };
    const used = this.used.get(origin)?.used ?? 0;
    if (used >= limit) return { ok: false, origin, used, limit, originClass };
    // The class is recorded from the CURRENT verdict, so an origin that becomes signed in mid-session
    // (the ledger is sticky) starts being measured against the tight limit from that point on.
    this.used.set(origin, { used: used + 1, originClass });
    return { ok: true, origin, used: used + 1, limit, originClass };
  }

  /** Live counters, highest spend first — for status output and the Studio UI. */
  snapshot(): OriginBudgetEntry[] {
    return [...this.used.entries()]
      .map(([origin, e]) => ({ origin, used: e.used, limit: this.limitFor(e.originClass), originClass: e.originClass }))
      .sort((a, b) => b.used - a.used || a.origin.localeCompare(b.origin));
  }

  /** Total navigations charged this session, across all origins. */
  get totalSpent(): number {
    let n = 0;
    for (const v of this.used.values()) n += v.used;
    return n;
  }
}

function sane(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * The refusal an exhausted budget produces, and the ONLY place its wording is minted. Names the numbers
 * so the agent (and the human) can act on it.
 *
 * K6: `reason` is the stable machine code and `message` is the sentence, and neither is called
 * `error_reason`. That field name means opposite things on the two sides of the envelope seam — the code
 * on a published envelope (docs/rest-api.md "Error shape"), the prose on a producer `StageError` — so a
 * refusal that carried it could be, and was, copied straight into a published envelope with no swap and
 * shipped a sentence as the machine code. Two unambiguous names make that unexpressible instead of
 * merely wrong: a seam has to choose which half it is publishing.
 */
export function budgetRefusal(v: OriginBudgetVerdict): { reason: 'origin_budget_exhausted'; message: string; hint: string } {
  return {
    reason: 'origin_budget_exhausted',
    message: `This session has already made ${v.used} of ${v.limit} allowed requests to ${v.origin}.`,
    hint: 'Pacing protects the account from looking automated. Work with what you have, use a different source, or ask the human to raise the per-origin budget.',
  };
}
