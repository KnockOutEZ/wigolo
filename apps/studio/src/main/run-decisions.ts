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
 */

export interface DecisionRuns {
  runForSession(sessionId: string): string | undefined;
  runForDecision(decisionId: string): string | undefined;
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

  const cancel = (decisionId: string): void => {
    pending.get(decisionId)?.();
    pending.delete(decisionId);
  };

  const settle = async (decisionId: string, outcome: 'approved' | 'denied' | 'auto_denied', by: 'human' | 'system'): Promise<void> => {
    cancel(decisionId);
    const runId = runOf.get(decisionId) ?? deps.runs.runForDecision(decisionId);
    // Already resolved, or never recorded — either way there is nothing true left to write.
    if (!runId) return;
    // Dropped before the append, not after: the link is what makes a second settle for one card
    // write a second resolution, and there is an await between here and the log.
    runOf.delete(decisionId);
    await deps.runs.resolveDecision(runId, decisionId, outcome, by);
  };

  return {
    async parked(notice) {
      const runId = deps.runs.runForSession(notice.session_id);
      if (!runId) return;
      // A re-parked `approval_id` is the SAME card raised again, not a second one. Overwriting the
      // map entry left the timer it replaced running on its own clock, so one decision auto-denied
      // twice — and the second write lands on a card the log has already resolved.
      cancel(notice.approval_id);
      await deps.runs.requestDecision(runId, { decisionId: notice.approval_id, kind: notice.risk, prompt: notice.action });
      runOf.set(notice.approval_id, runId);
      pending.set(
        notice.approval_id,
        setTimer(() => { void settle(notice.approval_id, 'auto_denied', 'system').catch(deps.onError); }, AUTO_DENY_MS),
      );
    },
    resolved: (decisionId, outcome) => settle(decisionId, outcome, 'human'),
    dispose() {
      for (const stop of pending.values()) stop();
      pending.clear();
      runOf.clear();
    },
  };
}
