/**
 * S13-2 — the ATTENDED RUNNER: re-run one recorded linear flow, halting at the first divergence.
 *
 * ── THE ONE STRUCTURAL DECISION THE WHOLE SAFETY ENVELOPE HANGS OFF (§5.1) ───────────────────────
 * Every replayed step is dispatched through `createActHandler`'s returned function, unmodified. This
 * module imports **no CDP surface, no input channel, and no resolver of its own** — the act handler and
 * a live candidate set are injected. Taken this way, a replay inherits, with no new code and no tests
 * of its own for any of them: the control-token gate and epoch fence, the drive gate and origin budget,
 * SSRF nav policy, the live occluded/ambiguous resolve refusals, the hard credential refusal, the risk
 * gate and park, and an audit row per action — so a replay is exactly as forensically visible as a first
 * run, which it must be.
 *
 * The negative is asserted on the transitive IMPORT GRAPH, not by grepping this file: a grep cannot see
 * a re-export (§9, T8).
 *
 * ── WHAT A RECORDING DOES NOT CARRY (§5.2) ──────────────────────────────────────────────────────
 * Authorization and risk are re-derived at run time, and this module could not do otherwise if it
 * wanted to: migration `013` gives `studio_flow_steps` **no risk column and no approval column**, so
 * `FlowStep` has no field to read. A stored pre-grant would have been a durable, file-portable,
 * agent-readable authorization token for money/credential/destructive actions. The absence is the
 * design, and it makes T9/T10 structural rather than behavioural.
 *
 * ── WHAT BOUNDS A RUN (§5.4, and A176) ──────────────────────────────────────────────────────────
 * A replay walks a stored, finite list and cannot loop, so it needs no constant to terminate. The
 * ceiling exists only to refuse an absurdly long recording, and it therefore **refuses the run before
 * the first dispatch rather than truncating it mid-flow**: a run stopped at step k has already executed
 * a partial sequence, which is the hazard the ceiling was added to prevent. The origin budget bounds
 * navigation volume, and first-divergence halt is what actually catches a page that changed underneath.
 */
import { resolveFlowStep, type StepDegraded } from './resolve-step.js';
import type { FlowStep } from './store.js';
import type { HealCandidate } from '../mark/heal.js';
// TYPE-ONLY on purpose: these are erased at build, so naming the act contract here cannot pull the
// dispatch path (or anything it reaches) into this module's runtime import graph. T8 is asserted on
// that graph, so an ordinary import of these would be the thing it exists to catch.
import type { StudioActInput, StudioActOutput, StudioToolError } from '../../daemon/studio-dispatch.js';

/**
 * The per-run step ceiling (**A176**). PROVISIONAL, in the same sense the origin-budget defaults are:
 * nothing yet knows how long a real recorded flow is.
 *
 * NOT derived from the corpus, and the reason is worth keeping: G1's committed length distribution
 * (min 2, median 6, max 8) is an artifact of its own harness, which builds every flow as
 * `1 navigate + 4 links + 2 fields + 1 scroll`. Its maximum IS that arithmetic, so a ceiling taken from
 * it would be "a constant from a sample max" in the purest form.
 *
 * Reasoned from what this slice IS instead: S13-2 is the **attended** run, so the bound is what a human
 * plausibly supervises in one sitting. Deliberately not operator-tunable upward.
 */
export const MAX_REPLAY_STEPS = 200;

/** Verbs a recording can contain, and therefore the only verbs a run will dispatch. */
const TARGETED_ACTIONS = new Set(['click', 'type']);

export type RunHaltReason =
  /** Pre-flight: the recording is longer than a run may be. Nothing was dispatched. */
  | 'too_long'
  /** Pre-flight: nothing to run. */
  | 'empty_flow'
  /** The step resolver declined — carries its own typed reason (§5.3). */
  | 'missing_seed'
  | 'unresolved_target'
  | 'ambiguous_target'
  | 'role_changed'
  /**
   * A `type` step's slot has no value for this run. Raised PRE-FLIGHT (`atSeq: 0`) with every missing
   * name, so a caller learns all of them in one round trip. Values are per-run and never stored (§6).
   */
  | 'slot_unfilled'
  /** A value was supplied for a slot this flow does not have — a caller has misread the flow. */
  | 'unknown_slot'
  /** A `type` step carrying no slot name: a corrupt or hand-written row, never one the recorder wrote. */
  | 'malformed_step'
  /** The act handler refused or failed. Its own reason travels in `detail`. */
  | 'act_refused';

export interface RunStepOutcome {
  seq: number;
  action: string;
  /**
   * Set when the step resolved BELOW its recorded tier (§5.3 as amended, A174). The run continues — the
   * reach is available — and the lower confidence is on the record, which is what makes A174's reversal
   * condition observable.
   */
  degraded?: StepDegraded;
}

export interface RunHalt {
  /** The `seq` of the step that halted. `0` for a pre-flight refusal, which belongs to no step. */
  atSeq: number;
  reason: RunHaltReason;
  /** The underlying typed reason when the act handler is the one that refused. */
  detail?: string;
}

export interface RunResult {
  ok: boolean;
  /** Steps whose dispatch was ATTEMPTED and returned without a refusal. */
  dispatched: RunStepOutcome[];
  halt?: RunHalt;
}

export interface FlowRunDeps {
  /** The recording, in `seq` order. The caller reads it through the store's own allow-list. */
  steps: FlowStep[];
  /** `createActHandler`'s returned function, unmodified. There is no second lane (§5.1). */
  act(input: StudioActInput): Promise<StudioActOutput | StudioToolError>;
  /**
   * A live candidate set, rebuilt per targeted step because a click can change the page. The host binds
   * this to the same privileged AX⋈DOM path a human mark resolves through.
   */
  candidates(): Promise<HealCandidate[]>;
  /**
   * Per-run slot values (§6). **S13-2 exposes no caller-facing surface for these** — no MCP tool and no
   * CLI verb yet — and they are never written to the sidecar, an artifact, a log line or the audit.
   * A `type` step with no value halts rather than typing an empty string, because a step that reports
   * success while typing nothing is a silently wrong replay.
   */
  values?: Readonly<Record<string, string>>;
}

/**
 * The slot names a caller must supply before this flow can run, in `seq` order, de-duplicated.
 *
 * De-duplicated because a slot is a NAMED PARAMETER, not a position: two fields that take the same value
 * are one question to ask, not two. Ordered by `seq` so a prompt follows the flow rather than the array.
 */
export function requiredSlots(steps: readonly FlowStep[]): string[] {
  const out: string[] = [];
  for (const step of [...steps].sort((a, b) => a.seq - b.seq)) {
    if (step.action !== 'type' || step.slot === undefined) continue;
    if (!out.includes(step.slot)) out.push(step.slot);
  }
  return out;
}

/** `error_reason` is how every refusal and failure arrives from the act handler. */
function refused(out: StudioActOutput | StudioToolError): string | undefined {
  return typeof out === 'object' && out !== null && 'error_reason' in out
    ? String((out as { error_reason?: unknown }).error_reason)
    : undefined;
}

/**
 * Run one recorded flow, attended, stopping at the first divergence.
 *
 * There is no skip-and-continue: after a halt, **zero** further steps are dispatched (§5.3, T13). A
 * runner that logged a divergence and carried on would be acting on a page it has already failed to
 * recognise.
 */
export async function runFlow(deps: FlowRunDeps): Promise<RunResult> {
  const dispatched: RunStepOutcome[] = [];
  const steps = [...deps.steps].sort((a, b) => a.seq - b.seq);

  if (steps.length === 0) return { ok: false, dispatched, halt: { atSeq: 0, reason: 'empty_flow' } };
  // Pre-flight, before anything is dispatched — see the ceiling's note above.
  if (steps.length > MAX_REPLAY_STEPS) {
    return { ok: false, dispatched, halt: { atSeq: 0, reason: 'too_long', detail: String(steps.length) } };
  }

  // ── Slot pre-flight (S13-3) ────────────────────────────────────────────────────────────────────
  // Validated BEFORE the first dispatch, for the same reason the ceiling refuses up front: discovering a
  // missing value at step 7 leaves steps 1-6 already executed against a live site. Everything knowable
  // in advance is checked in advance.
  const malformed = steps.find((s) => s.action === 'type' && s.slot === undefined);
  if (malformed) {
    return { ok: false, dispatched, halt: { atSeq: malformed.seq, reason: 'malformed_step', detail: 'type step carries no slot' } };
  }
  const needed = requiredSlots(steps);
  const supplied = deps.values ?? {};
  const missing = needed.filter((name) => supplied[name] === undefined);
  if (missing.length > 0) {
    // Every missing name, not just the first: one round trip should tell a caller everything it must ask.
    return { ok: false, dispatched, halt: { atSeq: 0, reason: 'slot_unfilled', detail: missing.join(', ') } };
  }
  const unknown = Object.keys(supplied).find((name) => !needed.includes(name));
  if (unknown !== undefined) {
    // Loudly, rather than ignoring it. A caller that passed `querry` has misread the flow, and running
    // with the real slot unfilled would be the worst of both outcomes.
    return { ok: false, dispatched, halt: { atSeq: 0, reason: 'unknown_slot', detail: unknown } };
  }

  for (const step of steps) {
    let ref: string | undefined;
    let degraded: StepDegraded | undefined;

    if (TARGETED_ACTIONS.has(step.action)) {
      // Re-resolved against a FRESH candidate set every time. The recorded ref is a control for the
      // comparison, never the locator (§4.3).
      const resolution = resolveFlowStep(step, await deps.candidates());
      if (!resolution.ok) {
        return { ok: false, dispatched, halt: { atSeq: step.seq, reason: resolution.reason } };
      }
      ref = resolution.ref;
      degraded = resolution.degraded;
    }

    let input: StudioActInput;
    switch (step.action) {
      case 'navigate':
        input = { action: 'navigate', url: step.pageUrl } as StudioActInput;
        break;
      case 'click':
        input = { action: 'click', ref } as StudioActInput;
        break;
      case 'type':
        // `step.slot` is present and `supplied[slot]` is defined: both were established by the pre-flight
        // above, so there is no second check here. A duplicate guard on the same predicate would read as
        // depth while being one decision, and would leave a branch no input can reach.
        input = { action: 'type', ref, text: supplied[step.slot as string] } as StudioActInput;
        break;
      case 'scroll':
        input = { action: 'scroll', direction: step.direction, amount: step.amount } as StudioActInput;
        break;
      default:
        // A verb the recorder could not have written. Refused rather than dispatched blind.
        return { ok: false, dispatched, halt: { atSeq: step.seq, reason: 'act_refused', detail: `unknown_action:${step.action}` } };
    }

    const out = await deps.act(input);
    const reason = refused(out);
    if (reason !== undefined) {
      // Every typed refusal exists to stop an agent. A runner that stepped over one would be a bypass.
      return { ok: false, dispatched, halt: { atSeq: step.seq, reason: 'act_refused', detail: reason } };
    }
    dispatched.push({ seq: step.seq, action: step.action, ...(degraded ? { degraded } : {}) });
  }

  return { ok: true, dispatched };
}
