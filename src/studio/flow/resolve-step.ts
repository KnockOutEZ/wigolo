/**
 * S13-1 — the offline resolver: a recorded step's seed → `heal` → a live snapshot `ref`.
 *
 * PURE, and deliberately so (spec §10): the resolver is made observable and counted on the drift
 * corpus BEFORE it is wired to an action, so the go/no-go on healed targets is decided on real
 * classification behaviour and a wrong resolver costs a revert of a pure function rather than a
 * revert of a dispatch path. Nothing here dispatches, navigates, or touches a browser surface —
 * S13-2 owns that, and it will call this.
 *
 * The resolver is a CALLER of `heal`, never a reimplementation of it (§4.3). It enumerates only
 * the two confidences that HALT; every other confidence is accepted. So if `heal` ever gains a
 * tier, this module picks it up with no change — which is the property `HEAL_HALT_CONFIDENCES`
 * exists to make checkable, and the reason no tier NAME appears below.
 */
import { heal, type HealConfidence, type HealCandidate, type HealResult } from '../mark/heal.js';
import type { FlowStep, RecordedHealTier } from './store.js';

/**
 * The confidences that stop a run. `heal.ts` — *ask, never guess* — and a replay is where guessing
 * is most expensive, because the action fires without a human reading the result first.
 *
 * Written as the HALT set rather than the accept set on purpose: the accept set is the complement,
 * so a confidence this module has never heard of is accepted rather than silently dropped.
 */
export const HEAL_HALT_CONFIDENCES: ReadonlySet<HealConfidence> = new Set<HealConfidence>(['low', 'none']);

type HaltConfidence = 'low' | 'none';
type AcceptConfidence = Exclude<HealConfidence, HaltConfidence>;

/** A predicate rather than a bare `.has`, so the accept branch NARROWS instead of needing a cast. */
function halts(confidence: HealConfidence): confidence is HaltConfidence {
  return HEAL_HALT_CONFIDENCES.has(confidence);
}

export type StepHaltReason =
  /** The step carries no locator seed (a `navigate`/`scroll` step, or a rejected read). */
  | 'missing_seed'
  /** `heal` found nothing. Not found is never a wrong element. */
  | 'unresolved_target'
  /** `heal` found several. The caller re-observes or asks; it does not pick one. */
  | 'ambiguous_target'
  /** A different role is a different control — the cheapest structural check available (§5.3). */
  | 'role_changed';
// `confidence_degraded` was a halt reason until 2026-08-19 (A174). It is deliberately ABSENT rather
// than retained-and-unused, so every consumer that switched on it is a type error rather than a
// silently dead branch.

/**
 * A step that resolved BELOW the confidence its recording achieved (§5.3 as amended, **A174**).
 *
 * `from` is always the stronger of the two — the resolver only sets this when the observed rank is
 * strictly lower — so a reader never has to compare them to learn which direction it moved.
 */
export interface StepDegraded {
  from: RecordedHealTier;
  to: AcceptConfidence;
}

export interface StepResolved {
  ok: true;
  /** The LIVE ref, from the fresh candidate set. A recorded ref is a control, never a locator. */
  ref: string;
  confidence: AcceptConfidence;
  /** Passed through from `heal` for reporting only — never a decision input here. */
  tier?: HealResult['tier'];
  /**
   * Set ONLY when this step resolved below its recorded tier. **Absent means "held", never
   * "unknown"** — a step with no `healTierAtRecord` has nothing to degrade from and is not marked.
   *
   * This used to be a halt. The halt could not pass on any input: every recordable seed records at
   * `high` (the live resolver refuses ambiguity, so every capturable element is uniquely
   * fingerprinted) and every `heal` recovery is `medium` (`high` ⟺ tier 1), so it made 100% of
   * healing's reach unreachable. **A174's reversal condition — a wrong action traced to a step that
   * ran below its recorded confidence — is only observable because this marker is carried.**
   */
  degraded?: StepDegraded;
}

export interface StepHalted {
  ok: false;
  reason: StepHaltReason;
  confidence?: HealConfidence;
  // `confidenceAtRecord` was declared here and REMOVED with A174: its only writer was the
  // degradation halt, so it would have survived as a field no producer sets — the same
  // declared-with-no-producer shape this program has already recorded twice (K19, F4).
  /** For an ambiguous halt: how many candidates matched at the deciding tier. */
  candidates?: number;
  observedRole?: string;
  recordedRole?: string;
}

export type StepResolution = StepResolved | StepHalted;

/** Strongest → weakest. Only used to compare an observed confidence against the recorded one. */
const CONFIDENCE_RANK: Record<HealConfidence, number> = { high: 3, medium: 2, low: 1, none: 0 };

/**
 * Resolve one recorded step against a fresh page's candidates.
 *
 * The candidate set is the caller's: S13-2 builds it from a live snapshot, and the drift benchmark
 * builds it from mutated frozen HTML. That is what makes the same resolver measurable offline and
 * usable online without a second lane.
 */
export function resolveFlowStep(step: FlowStep, candidates: HealCandidate[]): StepResolution {
  const seed = step.target;
  if (!seed) return { ok: false, reason: 'missing_seed' };

  const result = heal(seed, candidates);

  if (halts(result.confidence)) {
    // `heal` reports a candidate count only for an ambiguous verdict; a miss has none.
    const reason: StepHaltReason = result.candidates == null ? 'unresolved_target' : 'ambiguous_target';
    return {
      ok: false,
      reason,
      confidence: result.confidence,
      ...(result.candidates != null ? { candidates: result.candidates } : {}),
    };
  }

  const confidence: AcceptConfidence = result.confidence;
  // A confident verdict always carries a ref (`heal.ts`); refusing rather than asserting keeps a
  // future tier that forgets to set one from resolving to `undefined`.
  if (!result.ref) return { ok: false, reason: 'unresolved_target', confidence };

  const match = candidates.find((c) => c.ref === result.ref);
  if (!match || match.target.role !== seed.role) {
    return {
      ok: false,
      reason: 'role_changed',
      confidence,
      ...(match ? { observedRole: match.target.role } : {}),
      recordedRole: seed.role,
    };
  }

  // §5.3 as amended (A174): a weaker-than-recorded resolution is REPORTED, not refused. The three
  // conditions that stop an agent — a halting confidence, a role change, a typed refusal — are all
  // handled above and none of them route through here.
  const atRecord = step.healTierAtRecord;
  const degraded: StepDegraded | undefined =
    atRecord && CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[atRecord]
      ? { from: atRecord, to: confidence }
      : undefined;

  return {
    ok: true,
    ref: result.ref,
    confidence,
    ...(result.tier ? { tier: result.tier } : {}),
    ...(degraded ? { degraded } : {}),
  };
}
