import { AUTO_DENY_MS } from 'wigolo/studio';
import { unrefTimer } from './run-view-model';
import type { ParkedApprovalNotice } from './studio-host';

/**
 * The approval card, mirrored into the run's log.
 *
 * The card itself is unchanged and still fails closed on its own timeout — this only makes the RUN
 * know about it. Without that, `needs_you` is a status nothing can ever reach, and the dock badge
 * (pin 5's attention affordance, and the only one a fully withheld window has) can never fire.
 *
 * The auto-deny is mirrored too, on the same two-minute clock the approval broker uses and the store
 * already derives `autoDenyAt` from. They are two facts about one card: the broker refuses the ACTION,
 * and the log has to stop saying the run needs a human at the same moment — otherwise the badge stays
 * lit over a card nobody can answer any more.
 *
 * ── Durability before release ──
 *
 * The answer is written BEFORE the parked action is let go, not alongside it. It used to be the other
 * way round: the release was synchronous and the append was fired off behind it, so a run store that
 * could not take the write left the log holding `decision.requested` with no resolution of any kind
 * — the auto-deny that would eventually have written one had just been cancelled — while the approved
 * action was already running. One stderr line, no retry, and a repeat answer had nothing left to
 * write against. The run log is law 1's source of truth and what every other surface reads; a log that
 * omits an approval a human gave and an action already took is the worst shape it can be in.
 *
 * So `resolved` reports DURABILITY rather than nothing, retries a failed append on a bounded schedule
 * that closes inside the card's own two-minute life, keeps the card→run link until the write lands,
 * and is idempotent by `decisionId` against a repeat answer, against the timer, and against an append
 * that committed and lost its reply. `createApprovalDecider` is the ordering: durable, then release.
 */

export interface DecisionRuns {
  runForSession(sessionId: string): string | undefined;
  runForDecision(decisionId: string): string | undefined;
  lastSeqOf(runId: string): number;
  resolutionLanded(runId: string, decisionId: string, since: number): Promise<boolean>;
  requestDecision(runId: string, input: { decisionId: string; kind: string; prompt: string }): Promise<void>;
  resolveDecision(runId: string, decisionId: string, outcome: 'approved' | 'denied' | 'auto_denied', by: 'human' | 'system'): Promise<void>;
}

export interface DecisionMirrorDeps {
  runs: DecisionRuns;
  onError(err: unknown): void;
  /** Injectable so the two-minute clock is drivable; defaults to an unref'd timer. */
  setTimer?(cb: () => void, ms: number): () => void;
}

/**
 * Whether the answer reached the DURABLE log — the one thing a caller about to release a parked
 * action has to know, and the one thing the old `Promise<void>` could not tell it.
 *
 * `durable: true` also covers the answers there was nothing true to write for (an unknown card, a run
 * that has already ended): those are recorded as fully as they can be, and a caller that treated them
 * as failures would refuse to release an action over a log that is already correct.
 */
export type DecisionDurability = { durable: true } | { durable: false; reason: string };

export interface DecisionMirror {
  parked(notice: ParkedApprovalNotice): Promise<void>;
  resolved(decisionId: string, outcome: 'approved' | 'denied'): Promise<DecisionDurability>;
  dispose(): void;
}

/**
 * The append is retried on the mirror's own injected clock: six attempts over 15.5s of backoff.
 *
 * Not a generic retry framework — a run-store respawn is the failure this is sized for, and a respawn
 * that has not happened in fifteen seconds is one the human should be told about rather than one a
 * longer sleep would fix. The real wall clock is longer than the backoff, because a HUNG store costs
 * a per-call timeout per attempt rather than an immediate rejection.
 *
 * Correctness does NOT depend on the window closing inside `AUTO_DENY_MS`, and it deliberately must
 * not: `projectRun` drops an expired card from `pendingDecisions`, so anything that located the card
 * through the projection would stop being able to place the answer at the two-minute mark. Both of the
 * things this retry needs are independent of expiry instead — the card→run link is held here, and the
 * lost-reply probe reads the durable log rather than the projection. The row that pins that is "still
 * knows which run an unrecorded card belongs to after its deadline has passed".
 */
export const APPEND_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

export function createDecisionMirror(deps: DecisionMirrorDeps): DecisionMirror {
  const setTimer = deps.setTimer ?? unrefTimer;
  const pending = new Map<string, () => void>();
  /**
   * Which run each parked card belongs to, recorded when the card is parked.
   *
   * This used to ask the projection, and the projection is the one thing that cannot answer at the
   * moment the timer fires: `projectRun` drops a card the instant the clock passes `autoDenyAt`,
   * which is the same instant the two-minute timer runs. So `runForDecision` returned `undefined`,
   * `settle` returned, and the auto-deny resolution this module's contract promises was never
   * written for any card that actually reached its deadline — the only ones it is for. The mirror
   * owns the card from parking it to settling it, so it owns the link too, and the projection stays
   * the fallback for a card some other writer recorded.
   */
  const runOf = new Map<string, string>();
  /**
   * One turn at a time PER CARD, because every check this module makes is against state that only
   * settles after an await — and both of the ways that broke wrote a durable log contradicting what
   * actually happened.
   *
   * A human double-submit: `settle` dropped the `runOf` link and then awaited the append, and the
   * second submit inside that await missed the link but still found the card pending in the
   * projection — because the first fold had not landed — so it appended a SECOND `decision.resolved`
   * for one card, and `resolveDecision` appends unconditionally so nothing downstream deduped it.
   * Serialised, the second submit runs after the first append has folded, finds neither the link nor
   * a pending card, and writes nothing.
   *
   * And the mirror image: `parked` records `runOf` only AFTER its own round-trip, but the renderer is
   * told about the card BEFORE `parked` even runs. A resolve in that window found neither the link nor
   * a projection entry, returned without writing, and two minutes later the log said `auto_denied`
   * for a card the broker had approved. Serialised, that resolve waits for the request to land and
   * then settles it — the answer wins rather than being dropped.
   *
   * Per card, not global, so one slow append never holds up another card's answer.
   */
  const chain = new Map<string, Promise<unknown>>();
  /**
   * Cards whose resolution is IN the durable log. Idempotence by `decisionId`, and it is the set
   * rather than the `runOf` link that provides it now.
   *
   * The link used to be dropped before the append for exactly this job, which worked only while a
   * failed append was a fact nobody acted on: dropping it is also what erased the card from this
   * module, so the answer to a broker that was down at the append could never be retried and a repeat
   * answer had nothing left to write against. The link now survives until the write lands, and this
   * set — which only ever grows on a COMMITTED write — is what a second settle for one card checks.
   */
  const settled = new Set<string>();
  /** Wake-ups for retry backoffs in flight, so `dispose` never leaves one sleeping. */
  const waiting = new Set<() => void>();
  let disposed = false;

  const queue = (decisionId: string, work: () => Promise<DecisionDurability>): Promise<DecisionDurability> => {
    const queued = (chain.get(decisionId) ?? Promise.resolve()).then(work, work);
    const tail = queued.then(
      () => { if (chain.get(decisionId) === tail) chain.delete(decisionId); },
      () => { if (chain.get(decisionId) === tail) chain.delete(decisionId); },
    );
    chain.set(decisionId, tail);
    return queued;
  };

  const cancel = (decisionId: string): void => {
    pending.get(decisionId)?.();
    pending.delete(decisionId);
  };

  /** A cancellable pause on the injected clock. Resolves early on `dispose`, so teardown is prompt. */
  const pause = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    const wake = (): void => { waiting.delete(wake); stop(); resolve(); };
    const stop = setTimer(() => { waiting.delete(wake); resolve(); }, ms);
    waiting.add(wake);
  });

  /**
   * Did the append that just failed actually COMMIT? A broker round-trip can lose the reply after the
   * write landed, and a retry that cannot tell that apart writes a second resolution for one card.
   * A probe rides the same broker as the append, so a probe that throws is not evidence of anything —
   * it is answered "not landed", and the retry it permits is bounded by the same schedule.
   */
  const landed = async (runId: string, decisionId: string, since: number): Promise<boolean> => {
    try {
      return await deps.runs.resolutionLanded(runId, decisionId, since);
    } catch {
      return false;
    }
  };

  const settle = async (decisionId: string, outcome: 'approved' | 'denied' | 'auto_denied', by: 'human' | 'system'): Promise<DecisionDurability> => {
    // The auto-deny dies the instant an answer is ACCEPTED, not the instant it is durable. An answer
    // whose append is being retried is an answered card, and a contradictory `auto_denied` landing
    // during that window would be a second resolution for one decision — the ordering this pins.
    cancel(decisionId);
    if (settled.has(decisionId)) return { durable: true };
    const runId = runOf.get(decisionId) ?? deps.runs.runForDecision(decisionId);
    // Already resolved, or never recorded — either way there is nothing true left to write, and the
    // caller may release: the log is as correct as it can be made.
    if (!runId) return { durable: true };
    // Whether the run is still open is NOT decided here. This module read `snapshot(runId)?.status`
    // and then awaited the append, and the gap between the two is a round-trip: a card whose run was
    // closing read a projection `endRun`'s append had not moved yet, passed, and the store committed
    // `decision.resolved` after `run.completed`. A check on one side of a race is not a check, and a
    // second copy of it here would only be a second way to be wrong — the refusal lives at the append,
    // on the lane the terminal event is written on. See `RunViewModel.resolveDecision`.
    //
    // The floor for the lost-reply probe, read BEFORE the first attempt so the window it opens starts
    // strictly below the envelope it is looking for.
    const since = deps.runs.lastSeqOf(runId);
    let attempt = 0;
    for (;;) {
      try {
        await deps.runs.resolveDecision(runId, decisionId, outcome, by);
        // Committed — or legally refused on the run lane, which is the same durable outcome from here.
        settled.add(decisionId);
        runOf.delete(decisionId);
        return { durable: true };
      } catch (err) {
        if (await landed(runId, decisionId, since)) {
          settled.add(decisionId);
          runOf.delete(decisionId);
          return { durable: true };
        }
        if (disposed || attempt >= APPEND_RETRY_DELAYS_MS.length) {
          // The link is KEPT. A repeat answer has to be able to write what this could not, and the
          // projection cannot supply it — `runForDecision` reads `pendingDecisions`, which drops the
          // card at its deadline, so past two minutes this module is the only thing that still knows
          // which run the card belongs to.
          return { durable: false, reason: err instanceof Error ? err.message : String(err) };
        }
        deps.onError(err);
        await pause(APPEND_RETRY_DELAYS_MS[attempt++]!);
      }
    }
  };

  return {
    async parked(notice) {
      const runId = deps.runs.runForSession(notice.session_id);
      if (!runId) return;
      await queue(notice.approval_id, async () => {
        // A re-parked `approval_id` is the SAME card raised again, not a second one. Overwriting the
        // map entry left the timer it replaced running on its own clock, so one decision auto-denied
        // twice — and the second write lands on a card the log has already resolved.
        cancel(notice.approval_id);
        // A card raised AGAIN after its earlier answer landed is a fresh question, and it needs a
        // fresh resolution: leaving the id in `settled` would make this module answer "already
        // durable" to an answer it never wrote.
        settled.delete(notice.approval_id);
        await deps.runs.requestDecision(runId, { decisionId: notice.approval_id, kind: notice.risk, prompt: notice.action });
        runOf.set(notice.approval_id, runId);
        pending.set(
          notice.approval_id,
          setTimer(
            () => {
              void queue(notice.approval_id, () => settle(notice.approval_id, 'auto_denied', 'system'))
                .then((d) => { if (!d.durable) deps.onError(new Error(`the auto-deny of ${notice.approval_id} could not be recorded: ${d.reason}`)); })
                .catch(deps.onError);
            },
            AUTO_DENY_MS,
          ),
        );
        return { durable: true } as const;
      });
    },
    resolved: (decisionId, outcome) => queue(decisionId, () => settle(decisionId, outcome, 'human')),
    dispose() {
      disposed = true;
      for (const stop of pending.values()) stop();
      pending.clear();
      for (const wake of [...waiting]) wake();
      waiting.clear();
      runOf.clear();
      chain.clear();
      settled.clear();
    },
  };
}

/** What the surface that answered a card gets back, and the only place a durability failure can be read. */
export type ApprovalDecideReply = { recorded: true } | { recorded: false; reason: string };

export interface ApprovalDeciderDeps {
  decisions: Pick<DecisionMirror, 'resolved'>;
  /** The host's synchronous release of the parked action — reached only once the answer is durable. */
  release(approvalId: string, decision: 'allow' | 'deny'): void;
  /**
   * Durability failed: the action was NOT released, so the card is still unanswered and still parked
   * in the host. Putting it back in front of the human is what makes that visible — a card that
   * vanished from the surface it was answered on and left no record anywhere is the silent loss.
   */
  resurface(approvalId: string, reason: string): void;
  onError(err: unknown): void;
}

/**
 * The human's card click, ordered so the log cannot lie about it.
 *
 * Durable first, release second, and fail CLOSED: an answer that could not be recorded releases
 * nothing. The action stays parked, the card comes back to the human, and the caller gets a structured
 * refusal rather than a stderr line nobody reads. The alternative — release first and hope the write
 * lands — is the defect this replaces, and it is unfixable by any amount of retrying, because the
 * action has already run by the time the first attempt fails.
 *
 * Nothing here waits on another run: `resolved` takes the queue of ONE card, and the retry sleeps off
 * the run lane entirely, so a card whose broker is down blocks its own run and no other.
 */
export function createApprovalDecider(deps: ApprovalDeciderDeps) {
  return async (approvalId: string, decision: 'allow' | 'deny'): Promise<ApprovalDecideReply> => {
    const durability = await deps.decisions.resolved(approvalId, decision === 'allow' ? 'approved' : 'denied');
    if (!durability.durable) {
      deps.onError(new Error(`the answer to ${approvalId} could not be recorded on its run: ${durability.reason}`));
      deps.resurface(approvalId, durability.reason);
      return { recorded: false, reason: durability.reason };
    }
    deps.release(approvalId, decision);
    return { recorded: true };
  };
}
