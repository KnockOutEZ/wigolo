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
 * THE AUTHENTICATED LANE IS A SLIDING WINDOW (SD6-C2, ruling A-17-9). Pin 2 is "60 browser requests /
 * 10 min / authenticated origin", and a pin beats the provisional constant that stood here: a
 * session-cumulative number answers the wrong question. What gets an account flagged is a burst, and a
 * windowless counter both permits an unbounded burst inside its total AND then locks the origin out for
 * the rest of the session once the total is spent — the two failure modes in opposite directions. A
 * window bounds the rate and refills, so a long research task on one signed-in origin stays possible
 * without ever looking automated.
 *
 * THE ANONYMOUS LANE STAYS WINDOWLESS at its session-cumulative 300, deliberately. Pin 2 names only the
 * authenticated lane, and the anonymous constant is parked pending the escalation-rate counters this
 * phase collects; giving it a window would be an unpinned design change dressed up as consistency.
 * Nothing about time passing hands an anonymous origin more requests.
 *
 * THE CLOCK IS INJECTABLE because the property cannot otherwise be tested. Under the real clock every
 * spend in a test lands in the same window, which makes a window that never refills observationally
 * identical to the counter it replaced — and therefore shippable green.
 */

/** Signed-in origins: the tight lane, per window. Pin 2. The value every unknown falls back to. */
export const DEFAULT_ORIGIN_BUDGET = 60;

/**
 * The authenticated lane's window. Pin 2's ten minutes. Only the authenticated lane has one — see the
 * header: `windowMsFor('anonymous')` is `null` and that is the whole difference between the lanes.
 */
export const DEFAULT_ORIGIN_BUDGET_WINDOW_MS = 10 * 60 * 1000;

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

/**
 * What `spend()` actually returns: the verdict plus the structured cap fields the studio gate raises a
 * pending decision from (§5, contract row 5 — "raise window / wait / end run"). A bare `ok: false`
 * could not tell that gate whether waiting is even an option, which is the difference between an
 * answerable pause and a dead end.
 *
 * `allowed` and `ok` are the SAME boolean under two names, minted from one expression. `ok` is the
 * field the extracted domain layer already reads across the `wigolo/companion` seam and cannot be
 * renamed from this side; `allowed` is the name pin 2's cap shape specifies. Two names for one
 * computation is a cost; two independently computed booleans would be a bug, and that is the one
 * `spend()` refuses to make expressible.
 */
export interface OriginBudgetSpendResult extends OriginBudgetVerdict {
  allowed: boolean;
  /** The window this class is paced by, or `null` for the windowless anonymous lane. */
  windowMs: number | null;
  /** Present only on a refusal. The single machine code for "paced, not forbidden". */
  reason?: 'pacing_cap';
  /**
   * Present only when a WINDOW will free a slot. Absent on the anonymous lane, because nothing there
   * refills and offering a wait that never ends would be a lie the gate would faithfully repeat.
   */
  retry_after_ms?: number;
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

/**
 * One origin's charges. BOTH figures are kept for every charge regardless of lane, because the lane an
 * origin is in can change mid-session (the credential ledger is sticky) and the counter the new lane
 * needs has to already exist. `stamps` answers the windowed question, `used` the cumulative one.
 */
interface OriginEntry {
  stamps: number[];
  used: number;
  originClass: OriginClass;
}

export class OriginBudget {
  private readonly limit: number;
  private readonly anonymousLimit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly used = new Map<string, OriginEntry>();

  constructor(opts: { limit?: number; anonymousLimit?: number; windowMs?: number; now?: () => number } = {}) {
    // A non-positive or non-finite configured limit would silently disable the rail. Fall back to the
    // default rather than honouring it: "0" in a config file is far more likely a typo than an intent to
    // block every navigation, and a negative one has no meaning at all.
    this.limit = sane(opts.limit, DEFAULT_ORIGIN_BUDGET);
    // The anonymous lane can never end up TIGHTER than the signed-in one. A config that inverted them
    // would silently make public pages the restricted case, which is the opposite of the intent.
    this.anonymousLimit = Math.max(sane(opts.anonymousLimit, DEFAULT_ANONYMOUS_ORIGIN_BUDGET), this.limit);
    // Same argument as the limit, and one direction worse: a zero-length window holds nothing, so every
    // request would look like the first one and the rail would never fire at all.
    this.windowMs = sane(opts.windowMs, DEFAULT_ORIGIN_BUDGET_WINDOW_MS);
    this.now = opts.now ?? (() => Date.now());
  }

  /** The limit that applies to a class. Exposed so status output can print both lanes. */
  limitFor(originClass: OriginClass): number {
    return originClass === 'anonymous' ? this.anonymousLimit : this.limit;
  }

  /**
   * The window a class is paced by, or `null` when it has none. The single place the lane difference is
   * expressed, so a surface printing "per session" against a windowed lane is a compile-visible mistake
   * rather than stale copy.
   */
  windowMsFor(originClass: OriginClass): number | null {
    return originClass === 'anonymous' ? null : this.windowMs;
  }

  /**
   * Charge one navigation against `url`'s origin. Returns the verdict AND the live counters, so the caller
   * can put real numbers in the refusal instead of an opaque "budget exceeded".
   *
   * An unparseable URL is NOT charged and NOT refused here: it cannot be attributed to an origin, and the
   * SSRF fence downstream is what rejects a URL the agent should not reach. Silently charging it to some
   * bucket would make the visible counters wrong, which is worse than not counting it.
   */
  spend(url: string, opts: { originClass?: OriginClass } = {}): OriginBudgetSpendResult {
    // DEFAULTS TO THE TIGHT LANE. A caller that does not say, or cannot know, gets the signed-in limit —
    // so forgetting to pass the class under-serves rather than over-drives.
    const originClass: OriginClass = opts.originClass === 'anonymous' ? 'anonymous' : 'authenticated';
    const limit = this.limitFor(originClass);
    const windowMs = this.windowMsFor(originClass);
    const origin = budgetOrigin(url);
    if (!origin) return allow({ origin: '', used: 0, limit, originClass, windowMs });

    const at = this.now();
    const entry = this.used.get(origin) ?? { stamps: [], used: 0, originClass };
    // Drop everything that has aged out. Done on every charge rather than on a timer: there is no clock
    // to schedule against here, and the only moment the count matters is the one it is compared.
    if (windowMs !== null) entry.stamps = entry.stamps.filter((t) => t > at - windowMs);

    // The windowed lane is compared against what is IN the window; the windowless one against the
    // session total. Which figure `used` reports follows the same rule — a visible counter that is not
    // the one the limit is compared against explains nothing when the rail fires (law 11).
    const charged = windowMs === null ? entry.used : entry.stamps.length;
    if (charged >= limit) {
      this.used.set(origin, { ...entry, originClass });
      // The oldest stamp still in the window is what frees the next slot. `Math.max(1, …)` because a
      // retry of 0 reads as "now" to every caller, and coming straight back would earn a second refusal.
      const retry = windowMs !== null && entry.stamps.length > 0
        ? Math.max(1, entry.stamps[0] + windowMs - at)
        : undefined;
      return { ok: false, allowed: false, origin, used: charged, limit, originClass, windowMs, reason: 'pacing_cap', ...(retry !== undefined ? { retry_after_ms: retry } : {}) };
    }

    // The class is recorded from the CURRENT verdict, so an origin that becomes signed in mid-session
    // (the ledger is sticky) starts being measured against the tight limit from that point on — and the
    // stamps it accumulated while it looked anonymous count, because they were requests to the same
    // origin inside the same window.
    entry.stamps.push(at);
    entry.used += 1;
    this.used.set(origin, { ...entry, originClass });
    return allow({ origin, used: windowMs === null ? entry.used : entry.stamps.length, limit, originClass, windowMs });
  }

  /** Live counters, highest spend first — for status output and the Studio UI. */
  snapshot(): OriginBudgetEntry[] {
    const at = this.now();
    return [...this.used.entries()]
      .map(([origin, e]) => {
        const windowMs = this.windowMsFor(e.originClass);
        const used = windowMs === null ? e.used : e.stamps.filter((t) => t > at - windowMs).length;
        return { origin, used, limit: this.limitFor(e.originClass), originClass: e.originClass };
      })
      .sort((a, b) => b.used - a.used || a.origin.localeCompare(b.origin));
  }

  /** Total navigations charged this session, across all origins. Cumulative by definition — not paced. */
  get totalSpent(): number {
    let n = 0;
    for (const v of this.used.values()) n += v.used;
    return n;
  }
}

/** The allowed result, minted in one place so `ok` and `allowed` cannot be set apart. */
function allow(v: Omit<OriginBudgetVerdict, 'ok'> & { windowMs: number | null }): OriginBudgetSpendResult {
  return { ok: true, allowed: true, ...v };
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
export function budgetRefusal(
  v: OriginBudgetVerdict & { windowMs?: number | null; retry_after_ms?: number },
): { reason: 'origin_budget_exhausted'; message: string; hint: string } {
  // The window and the retry are each stated only when they are TRUE of the lane that refused. The
  // anonymous lane has neither, and a sentence that promised a wait there would be a lie the gate
  // would faithfully repeat to the human (law 7's stance, applied to pacing).
  const window = typeof v.windowMs === 'number' && v.windowMs > 0 ? ` in the last ${humanDuration(v.windowMs)}` : '';
  const retry = typeof v.retry_after_ms === 'number'
    ? ` The next request to it is allowed in about ${humanDuration(v.retry_after_ms)}.`
    : '';
  return {
    reason: 'origin_budget_exhausted',
    message: `This session has already made ${v.used} of ${v.limit} allowed requests to ${v.origin}${window}.${retry}`,
    hint: 'Pacing protects the account from looking automated. Work with what you have, use a different source, or ask the human to raise the per-origin budget.',
  };
}

/**
 * The window, as a phrase, minted HERE and nowhere else. `doctor` and `status` both describe the rail
 * and describe it identically; two local formatters would drift the day the default changes, and a
 * surface printing "per session" against a windowed lane is the exact confusion the window introduces.
 */
export function formatPacingWindow(ms: number): string {
  return humanDuration(ms);
}

/** Rounds UP, so a caller that waits the stated time never comes back to a second refusal. */
function humanDuration(ms: number): string {
  if (ms < 60_000) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  const m = Math.ceil(ms / 60_000);
  return `${m} minute${m === 1 ? '' : 's'}`;
}
