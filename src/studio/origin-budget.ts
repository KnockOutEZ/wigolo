/**
 * S9 / D9 — the PER-ORIGIN PACING BUDGET.
 *
 * This is the rail that bounds the account-ban blast radius, and the most important thing about it is
 * WHAT IT DOES NOT DEPEND ON: it applies to every origin the agent drives, authenticated or not, and it
 * never consults the F5 predicate. That decoupling is load-bearing. F5 decides whether the human gets a
 * consent CARD; this decides how hard the agent may hit a site. So an F5 false negative — the expensive
 * direction, an SPA holding its session in localStorage that F5 cannot see — costs the prompt and leaves
 * the safety rail fully intact.
 *
 * It is a FIRST-CLASS, VISIBLE feature, not a hidden throttle. `snapshot()` exists so the counters can be
 * surfaced in status output: a limit the user cannot see is indistinguishable from a bug when it fires.
 *
 * Scope is per-origin, per-session — one instance per session, matching `PreGrantStore`. Per-site would
 * under-protect (`accounts.google.com` and `docs.google.com` are not the same exposure) and per-request
 * would be meaningless.
 *
 * THE DEFAULT IS DELIBERATELY PROVISIONAL. Nothing in the program yet knows what a real research task
 * spends on one origin, so the number below is a conservative placeholder to be revisited against the
 * escalation-rate counters this same phase starts collecting — not a considered answer.
 */

/** Conservative placeholder: agent-driven navigations per origin per session. Revisit with real data. */
export const DEFAULT_ORIGIN_BUDGET = 20;

export interface OriginBudgetVerdict {
  ok: boolean;
  origin: string;
  used: number;
  limit: number;
}

export interface OriginBudgetEntry {
  origin: string;
  used: number;
  limit: number;
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
  private readonly used = new Map<string, number>();

  constructor(opts: { limit?: number } = {}) {
    // A non-positive or non-finite configured limit would silently disable the rail. Fall back to the
    // default rather than honouring it: "0" in a config file is far more likely a typo than an intent to
    // block every navigation, and a negative one has no meaning at all.
    const l = opts.limit;
    this.limit = typeof l === 'number' && Number.isFinite(l) && l > 0 ? Math.floor(l) : DEFAULT_ORIGIN_BUDGET;
  }

  /**
   * Charge one navigation against `url`'s origin. Returns the verdict AND the live counters, so the caller
   * can put real numbers in the refusal instead of an opaque "budget exceeded".
   *
   * An unparseable URL is NOT charged and NOT refused here: it cannot be attributed to an origin, and the
   * SSRF fence downstream is what rejects a URL the agent should not reach. Silently charging it to some
   * bucket would make the visible counters wrong, which is worse than not counting it.
   */
  spend(url: string): OriginBudgetVerdict {
    const origin = budgetOrigin(url);
    if (!origin) return { ok: true, origin: '', used: 0, limit: this.limit };
    const used = this.used.get(origin) ?? 0;
    if (used >= this.limit) return { ok: false, origin, used, limit: this.limit };
    this.used.set(origin, used + 1);
    return { ok: true, origin, used: used + 1, limit: this.limit };
  }

  /** Live counters, highest spend first — for status output and the Studio UI. */
  snapshot(): OriginBudgetEntry[] {
    return [...this.used.entries()]
      .map(([origin, used]) => ({ origin, used, limit: this.limit }))
      .sort((a, b) => b.used - a.used || a.origin.localeCompare(b.origin));
  }

  /** Total navigations charged this session, across all origins. */
  get totalSpent(): number {
    let n = 0;
    for (const v of this.used.values()) n += v;
    return n;
  }
}

/** The refusal an exhausted budget produces. Names the numbers so the agent (and the human) can act on it. */
export function budgetRefusal(v: OriginBudgetVerdict): { error: string; error_reason: string; hint: string } {
  return {
    error: 'origin_budget_exhausted',
    error_reason: `This session has already made ${v.used} of ${v.limit} allowed requests to ${v.origin}.`,
    hint: 'Pacing protects the account from looking automated. Work with what you have, use a different source, or ask the human to raise the per-origin budget.',
  };
}
