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

/**
 * The same auto-deny, on a clock that has actually REACHED the deadline.
 *
 * The rows above fire the timer callback with the wall clock still at parking time, and that is the
 * one ordering under which the shipped code worked: `settle` asked `runForDecision`, which asks the
 * PROJECTION, and a projection drops a card the instant the clock passes `autoDenyAt` — the same
 * instant the two-minute timer runs. In the app the two always coincide, so `runForDecision`
 * answered `undefined`, `settle` returned, and `decision.resolved {outcome: auto_denied}` was never
 * written for any card that reached its deadline. The badge then stayed lit forever, because the
 * only event that could clear it was the one nothing wrote.
 *
 * So these rows advance the clock FIRST and fire second. That is the real ordering, and it is the
 * ordering the fixture above could not produce.
 */
describe('the auto-deny, at the moment the clock actually reaches it', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;
  let mirror: DecisionMirror;
  let timers: Array<{ ms: number; fire: () => void }>;
  let vmTimers: Array<{ ms: number; fire: () => void }>;
  let runId: string;
  let nowMs: number;

  const collect = (into: Array<{ ms: number; fire: () => void }>) => (cb: () => void, ms: number): (() => void) => {
    const t = { ms, fire: cb };
    into.push(t);
    return () => { const at = into.indexOf(t); if (at >= 0) into.splice(at, 1); };
  };

  beforeEach(async () => {
    nowMs = Date.now();
    store = new FakeRunStore();
    timers = [];
    vmTimers = [];
    vm = new RunViewModel(store, () => new Date(nowMs), collect(vmTimers));
    await vm.hydrate();
    mirror = createDecisionMirror({ runs: vm, onError: () => {}, setTimer: collect(timers) });
    runId = (await vm.createRun({ task: 'buy the thing', sessionId: 'sess-1' })).id;
    store.appends.length = 0;
  });

  /** Advance past the deadline, then fire what the deadline was for — in that order. */
  const reachTheDeadline = async (): Promise<void> => {
    nowMs += 120_000 + 1_000;
    for (const t of [...timers]) t.fire();
    await new Promise((r) => setImmediate(r));
  };

  it('writes the resolution, on a projection that has already dropped the card', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    expect(vm.snapshot(runId)!.status).toBe('needs_you');
    store.appends.length = 0;

    await reachTheDeadline();

    // Not "the status reads running" — that was already true from the clock alone. The claim is that
    // the LOG says so, which is what every other surface and every later replay reads.
    expect(store.appends).toEqual([
      { runId, type: 'decision.resolved', payload: { decisionId: 'ap-1', outcome: 'auto_denied', by: 'system' } },
    ]);
    expect(vm.snapshot(runId)!.status).toBe('running');
  });

  it('fans that resolution out to a subscribed listener, with no other event landing', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    store.appends.length = 0;
    const seen: string[] = [];
    vm.onChange(() => seen.push(vm.snapshot(runId)!.status));

    await reachTheDeadline();

    // The tray, the dock badge and the presentation controller all redraw off this callback and
    // nothing else; a transition nobody announced is a transition they never make.
    expect(seen).toContain('running');
    expect(store.appends.map((a) => a.type)).toEqual(['decision.resolved']);
  });

  it('re-parking one approval id leaves exactly one timer, and writes exactly one resolution', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    store.appends.length = 0;

    // The stale timer used to survive its replacement, on its own earlier clock, and auto-deny a card
    // the log had already resolved — a second resolution for one decision.
    expect(timers).toHaveLength(1);

    await reachTheDeadline();

    expect(store.appends).toEqual([
      { runId, type: 'decision.resolved', payload: { decisionId: 'ap-1', outcome: 'auto_denied', by: 'system' } },
    ]);
  });
});
