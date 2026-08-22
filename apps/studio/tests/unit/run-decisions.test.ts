import { describe, it, expect, beforeEach } from 'vitest';
import { RunViewModel } from '../../src/main/run-view-model';
import { createDecisionMirror, type DecisionMirror } from '../../src/main/run-decisions';
import { FakeRunStore } from '../helpers/fake-run-store';

/**
 * The approval card already exists and already fails closed. What did not exist is the run knowing
 * about it — and without that, `needs_you` is a status nothing can ever reach, so the dock badge
 * (pin 5's attention affordance, and the only one a withheld window has) could never fire.
 *
 * This mirrors the card into the run's log: parked → `decision.requested`, answered →
 * `decision.resolved`. The auto-deny is here rather than only in the approval broker because the two
 * are different facts — the broker refuses the ACTION at two minutes, and the log has to stop saying
 * the run needs a human at the same moment, or the badge stays lit over a card nobody can answer.
 */
describe('the approval card, mirrored into the run log', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;
  let mirror: DecisionMirror;
  let timers: Array<{ ms: number; fire: () => void }>;
  let runId: string;

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
    timers = [];
    mirror = createDecisionMirror({
      runs: vm,
      onError: () => {},
      setTimer: (cb, ms) => { const t = { ms, fire: cb }; timers.push(t); return () => { timers = timers.filter((x) => x !== t); }; },
    });
    runId = (await vm.createRun({ task: 'buy the thing', sessionId: 'sess-1' })).id;
    store.appends.length = 0;
  });

  const fireAll = async (): Promise<void> => {
    for (const t of [...timers]) t.fire();
    await new Promise((r) => setImmediate(r));
  };

  it('records a parked card as a pending decision on the run that asked for it', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });

    expect(store.appends).toEqual([
      { runId, type: 'decision.requested', payload: { decisionId: 'ap-1', kind: 'money', prompt: 'pay $40' } },
    ]);
    const run = vm.snapshot(runId)!;
    expect(run.pendingDecisions.map((d) => d.decisionId)).toEqual(['ap-1']);
    // The whole point: a run with a card waiting is a run that needs a human.
    expect(run.status).toBe('needs_you');
  });

  it('clears it when the human answers, and says which way', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    store.appends.length = 0;

    await mirror.resolved('ap-1', 'approved');

    expect(store.appends).toEqual([
      { runId, type: 'decision.resolved', payload: { decisionId: 'ap-1', outcome: 'approved', by: 'human' } },
    ]);
    expect(vm.snapshot(runId)!.status).toBe('running');
  });

  // Pin 3, in the log: an unanswered card auto-denies at two minutes. Without this the badge stays lit
  // forever over a card the approval broker has already refused on its own fail-closed timeout.
  it('auto-denies an unanswered card on the same two-minute clock, and stops needing a human', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    expect(timers.map((t) => t.ms)).toEqual([120_000]);
    store.appends.length = 0;

    await fireAll();

    expect(store.appends).toEqual([
      { runId, type: 'decision.resolved', payload: { decisionId: 'ap-1', outcome: 'auto_denied', by: 'system' } },
    ]);
    expect(vm.snapshot(runId)!.status).toBe('running');
  });

  it('does not auto-deny a card the human already answered', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    await mirror.resolved('ap-1', 'denied');
    store.appends.length = 0;

    await fireAll();

    expect(store.appends).toEqual([]); // the timer was cancelled, and a second resolve would be a lie
  });

  it('writes nothing for a card that belongs to no run', async () => {
    await mirror.parked({ approval_id: 'ap-2', action: 'pay $40', risk: 'money', session_id: 'no-such-session' });
    await mirror.resolved('ap-2', 'approved');

    expect(store.appends).toEqual([]);
    expect(timers).toEqual([]);
  });

  it('finds the run from the decision alone, so answering needs no session bookkeeping', async () => {
    const other = await vm.createRun({ task: 'unrelated', sessionId: 'sess-2' });
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    store.appends.length = 0;

    await mirror.resolved('ap-1', 'approved');

    expect(store.appends.map((a) => a.runId)).toEqual([runId]);
    expect(vm.snapshot(other.id)!.status).toBe('running');
  });

  it('lets go of every pending timer when it is torn down', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    mirror.dispose();
    store.appends.length = 0;

    await fireAll();

    // A timer that outlives the window would append to a run's log after the app stopped watching it.
    expect(store.appends).toEqual([]);
  });
});
