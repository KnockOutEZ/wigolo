import { AUTO_DENY_MS, type Run } from 'wigolo/studio';
import { isTerminal, unrefTimer } from './run-view-model';
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
 */

export interface DecisionRuns {
  runForSession(sessionId: string): string | undefined;
  runForDecision(decisionId: string): string | undefined;
  /**
   * Read only to ask whether the run is over, through the same `isTerminal` every other seam here
   * uses — so "over" has one definition rather than a second one this module keeps in step.
   */
  snapshot(runId: string): Run | undefined;
  requestDecision(runId: string, input: { decisionId: string; kind: string; prompt: string }): Promise<void>;
  resolveDecision(runId: string, decisionId: string, outcome: 'approved' | 'denied' | 'auto_denied', by: 'human' | 'system'): Promise<void>;
}

export interface DecisionMirrorDeps {
  runs: DecisionRuns;
  onError(err: unknown): void;
  /** Injectable so the two-minute clock is drivable; defaults to an unref'd timer. */
  setTimer?(cb: () => void, ms: number): () => void;
}

export interface DecisionMirror {
  parked(notice: ParkedApprovalNotice): Promise<void>;
  resolved(decisionId: string, outcome: 'approved' | 'denied'): Promise<void>;
  dispose(): void;
}

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
  const chain = new Map<string, Promise<void>>();

  const queue = (decisionId: string, work: () => Promise<void>): Promise<void> => {
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

  const settle = async (decisionId: string, outcome: 'approved' | 'denied' | 'auto_denied', by: 'human' | 'system'): Promise<void> => {
    cancel(decisionId);
    const runId = runOf.get(decisionId) ?? deps.runs.runForDecision(decisionId);
    // Already resolved, or never recorded — either way there is nothing true left to write.
    if (!runId) return;
    // The run is over. `endRun` has no channel into this module, so a card parked when the run ended
    // still holds a two-minute timer, and firing it appends `decision.resolved` AFTER
    // `run.completed`/`run.failed` — an out-of-order fact in an append-only log, and on a condensed
    // run a forced full re-read to absorb an event that should not exist. Refused at the write rather
    // than announced at the call site, so every path in (timer, human, broker) is covered by one
    // check instead of by remembering to notify.
    if (isTerminal(deps.runs.snapshot(runId)?.status ?? 'running')) {
      runOf.delete(decisionId);
      return;
    }
    // Dropped before the append, not after: the link is what makes a second settle for one card
    // write a second resolution, and there is an await between here and the log.
    runOf.delete(decisionId);
    await deps.runs.resolveDecision(runId, decisionId, outcome, by);
  };

  return {
    parked(notice) {
      const runId = deps.runs.runForSession(notice.session_id);
      if (!runId) return Promise.resolve();
      return queue(notice.approval_id, async () => {
        // A re-parked `approval_id` is the SAME card raised again, not a second one. Overwriting the
        // map entry left the timer it replaced running on its own clock, so one decision auto-denied
        // twice — and the second write lands on a card the log has already resolved.
        cancel(notice.approval_id);
        await deps.runs.requestDecision(runId, { decisionId: notice.approval_id, kind: notice.risk, prompt: notice.action });
        runOf.set(notice.approval_id, runId);
        pending.set(
          notice.approval_id,
          setTimer(
            () => { void queue(notice.approval_id, () => settle(notice.approval_id, 'auto_denied', 'system')).catch(deps.onError); },
            AUTO_DENY_MS,
          ),
        );
      });
    },
    resolved: (decisionId, outcome) => queue(decisionId, () => settle(decisionId, outcome, 'human')),
    dispose() {
      for (const stop of pending.values()) stop();
      pending.clear();
      runOf.clear();
      chain.clear();
    },
  };
}
