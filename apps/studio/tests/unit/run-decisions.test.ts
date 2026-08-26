import { describe, it, expect, beforeEach } from 'vitest';
import type { RunEvent } from 'wigolo/studio';
import { RunViewModel } from '../../src/main/run-view-model';
import {
  APPEND_RETRY_DELAYS_MS,
  createApprovalDecider,
  createDecisionMirror,
  type DecisionDurability,
  type DecisionMirror,
} from '../../src/main/run-decisions';
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

/**
 * Every check this module makes is against state that only settles after an await, and the rows above
 * cannot see that: `FakeRunStore` commits the instant it is asked, so no second caller ever arrives
 * while an append is in flight. The app's do — `IPC.approvalDecide` fires per click, and the renderer
 * is told about a parked card on a different turn from the one that records it.
 *
 * So this fixture PARKS the append. `gate()` holds the next store write open until the test releases
 * it, which is the one window in which the shipped code wrote a durable log contradicting what
 * actually happened: a second `decision.resolved` for one card, or none at all for a card the human
 * answered.
 */
describe('the decision mirror, with an append still in flight', () => {
  let store: GatedRunStore;
  let vm: RunViewModel;
  let mirror: DecisionMirror;
  let timers: Array<{ ms: number; fire: () => void }>;
  let runId: string;
  let nowMs: number;

  /** A store whose next N appends park until released, so a second caller lands mid-round-trip. */
  class GatedRunStore extends FakeRunStore {
    private held: Array<() => void> = [];
    private gated = 0;
    /** Park the next `n` appends. */
    gate(n: number): void { this.gated = n; }
    /** Let every parked append through, and let their folds land. */
    async release(): Promise<void> {
      const held = this.held;
      this.held = [];
      for (const go of held) go();
      await new Promise((r) => setImmediate(r));
    }
    override async appendEvent(runId: string, event: Parameters<FakeRunStore['appendEvent']>[1]): ReturnType<FakeRunStore['appendEvent']> {
      if (this.gated > 0) {
        this.gated -= 1;
        await new Promise<void>((resolve) => this.held.push(resolve));
      }
      return super.appendEvent(runId, event);
    }
  }

  const collect = (into: Array<{ ms: number; fire: () => void }>) => (cb: () => void, ms: number): (() => void) => {
    const t = { ms, fire: cb };
    into.push(t);
    return () => { const at = into.indexOf(t); if (at >= 0) into.splice(at, 1); };
  };

  beforeEach(async () => {
    nowMs = Date.now();
    store = new GatedRunStore();
    timers = [];
    vm = new RunViewModel(store, () => new Date(nowMs), collect([]));
    await vm.hydrate();
    mirror = createDecisionMirror({ runs: vm, onError: () => {}, setTimer: collect(timers) });
    runId = (await vm.createRun({ task: 'buy the thing', sessionId: 'sess-1' })).id;
    store.appends.length = 0;
  });

  const settled = (): Promise<void> => new Promise((r) => setImmediate(r));

  /**
   * A human double-submit, with the first answer's append still open.
   *
   * `settle` dropped the `runOf` link and THEN awaited the append, so the second click missed the link
   * — and the `runForDecision` fallback still found the card pending, because the first fold had not
   * landed. `resolveDecision` appends unconditionally, so the log ended up with two resolutions for
   * one card and nothing downstream deduped them.
   */
  it('writes exactly one resolution when the human submits twice into one open append', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    store.appends.length = 0;

    store.gate(1);
    const first = mirror.resolved('ap-1', 'approved');
    await settled(); // the first append is now parked, mid-round-trip
    const second = mirror.resolved('ap-1', 'approved');
    await store.release();
    await Promise.all([first, second]);

    expect(store.appends).toEqual([
      { runId, type: 'decision.resolved', payload: { decisionId: 'ap-1', outcome: 'approved', by: 'human' } },
    ]);
    expect(vm.snapshot(runId)!.status).toBe('running');
  });

  /**
   * The answer that arrives while the card is still being recorded.
   *
   * `runOf` is set only after `requestDecision`'s round-trip, and the renderer used to be told about
   * the card BEFORE `parked` ran at all — so a fast click found neither the link nor a projection
   * entry, returned without writing, and two minutes later the log recorded `auto_denied` for a card
   * the broker had approved.
   */
  it('applies an answer that lands while the card is still being recorded, rather than dropping it', async () => {
    store.gate(1);
    const parked = mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    await settled(); // `decision.requested` is parked, mid-round-trip
    const answer = mirror.resolved('ap-1', 'approved');
    await store.release();
    await Promise.all([parked, answer]);

    expect(store.appends).toEqual([
      { runId, type: 'decision.requested', payload: { decisionId: 'ap-1', kind: 'money', prompt: 'pay $40' } },
      { runId, type: 'decision.resolved', payload: { decisionId: 'ap-1', outcome: 'approved', by: 'human' } },
    ]);

    // And the auto-deny it would otherwise have been left to: the answer took the card's turn, so the
    // timer is gone and the deadline writes nothing.
    nowMs += 120_000 + 1_000;
    for (const t of [...timers]) t.fire();
    await settled();
    expect(store.appends.map((a) => a.payload.outcome)).toEqual([undefined, 'approved']);
  });

  /**
   * A card that outlived its run.
   *
   * `endRun` has no channel into the mirror, so the two-minute timer of a card parked when the run
   * ended still fired — appending `decision.resolved` AFTER `run.completed`. That is an out-of-order
   * fact in an append-only log, and on a condensed run it forces a full re-read to absorb an event
   * that should not exist.
   */
  it('writes nothing at the deadline for a card whose run has already ended', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    await vm.endRun(runId, 'completed');
    store.appends.length = 0;

    nowMs += 120_000 + 1_000;
    for (const t of [...timers]) t.fire();
    await settled();

    expect(store.appends).toEqual([]);
    expect(vm.snapshot(runId)!.status).toBe('done');
  });

  /**
   * The same card, one round-trip earlier — the row above proves nothing about this one.
   *
   * There, `endRun` had already landed, so the projection the deadline read was already terminal. The
   * refusal that covered it was a check-then-act in `settle`: read `snapshot(runId)?.status`, then
   * await the append. Between those two sits a round-trip, and this is the interleaving inside it —
   * the session closing while a two-minute clock runs out. The auto-deny reads a projection
   * `run.completed` has not moved yet, passes, and the store commits both in arrival order, so the
   * append-only log ends up carrying a card's resolution AFTER the run that owned it finished. No
   * replay repairs that: every surface reading the log afterwards — here, over REST, in a replay, in
   * the audit — sees a finished run answering a question.
   *
   * Only the TERMINAL append is parked, and that is deliberate: park the resolution too and it stays
   * parked past the assertion, which would make this row pass because nothing was written rather than
   * because the write was refused — a test that cannot fail. With one gate the deadline's append is
   * free to commit, so the refusal is the only thing standing between this log and an out-of-order
   * envelope. Release the guard at `RunViewModel.resolveDecision` and this row goes red with that
   * envelope in it.
   */
  it('writes nothing for a deadline that fires while the run\'s terminal append is still in flight', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    store.appends.length = 0;

    store.gate(1);
    const ending = vm.endRun(runId, 'completed');
    await settled(); // `run.completed` is on the wire; nothing is committed, so the projection still says running

    nowMs += 120_000 + 1_000;
    for (const t of [...timers]) t.fire();
    await settled(); // the auto-deny has now decided, against that not-yet-terminal projection

    await store.release();
    await ending;

    // The log's ORDER is the claim, not just the count: nothing may follow the terminal event.
    expect(store.log.get(runId)!.map((e) => e.type)).toEqual(['run.created', 'decision.requested', 'run.completed']);
    expect(store.appends.map((a) => a.type)).toEqual(['run.completed']);
    expect(vm.snapshot(runId)!.status).toBe('done');
  });

  /**
   * The vacuous half of the same guard: `settle` defaulted a missing status to `running`, so a run
   * that had fallen out of the projection entirely passed the check it knew least about and got an
   * append anyway. The store is the wrong place to find that out — a blind write to a run this process
   * is not holding is a write it cannot say is legal.
   */
  it('writes nothing for a card whose run this process is not holding', async () => {
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    store.appends.length = 0;

    await vm.resolveDecision('rZZZ', 'ap-1', 'approved', 'human');

    expect(store.appends).toEqual([]);
  });

  /**
   * The card, not its answer — the same race one event earlier, and the worse half of it. A run that
   * has ended cannot need a human, and `decision.requested` is the one event that projects to
   * `needs_you`: parked past the terminal event it would relight the dock badge over a finished run
   * and leave it lit, because the answer that would clear it is refused.
   */
  it('parks no card on a run whose terminal append was already in flight', async () => {
    store.gate(1);
    const ending = vm.endRun(runId, 'completed');
    await settled();

    const parking = mirror.parked({ approval_id: 'ap-late', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    await settled();

    await store.release();
    await Promise.all([ending, parking]);

    expect(store.appends.map((a) => a.type)).toEqual(['run.completed']);
    expect(vm.snapshot(runId)!.status).toBe('done');
  });
});

/**
 * The store that cannot take the write.
 *
 * SD1 exit-16: the approval handler released the parked action synchronously and fired the append off
 * behind it, so a broker that was down at that moment left the run log holding `decision.requested`
 * with no resolution of ANY kind — the two-minute timer that would eventually have written
 * `auto_denied` had just been cancelled by the answer — while the approved action was already
 * running. One stderr line, nothing retried, and a repeat answer had nothing left to write against
 * because `settle` dropped the card→run link before the append and the projection drops the card at
 * its deadline. The run log is law 1's source of truth and what REST and the SSE tail both serve, so
 * a log that omits an approval a human gave and an action already took is the worst shape it can be
 * in.
 *
 * These rows force that failure rather than describe it: the append rejects until the test heals it.
 */
describe('a human answer whose run store is down at the append', () => {
  let store: BrokerDownRunStore;
  let vm: RunViewModel;
  let mirror: DecisionMirror;
  let timers: Array<{ ms: number; fire: () => void }>;
  let errors: unknown[];
  let runId: string;
  let nowMs: number;

  /**
   * Two distinct failures, because a retry that cannot tell them apart is a defect of its own:
   *  - `down` — the round-trip never reached the log. Retrying is the only way the answer lands.
   *  - `loseReplyFor` — the append COMMITTED and its reply was lost. Retrying double-writes.
   * Reads fail while `down` too, which is what a dead broker child actually looks like: the
   * lost-reply probe rides the same pipe as the append, so it cannot be assumed to answer.
   */
  class BrokerDownRunStore extends FakeRunStore {
    down = false;
    loseReplyFor = 0;
    override async appendEvent(runId: string, event: Parameters<FakeRunStore['appendEvent']>[1]): ReturnType<FakeRunStore['appendEvent']> {
      if (this.loseReplyFor > 0) {
        this.loseReplyFor -= 1;
        await super.appendEvent(runId, event);
        throw new Error('broker: the reply was lost');
      }
      if (this.down) throw new Error('broker: not running');
      return super.appendEvent(runId, event);
    }
    override async eventsSince(runId: string, since = 0, limit?: number): Promise<RunEvent[]> {
      if (this.down) throw new Error('broker: not running');
      return super.eventsSince(runId, since, limit);
    }
  }

  const collect = (into: Array<{ ms: number; fire: () => void }>) => (cb: () => void, ms: number): (() => void) => {
    const t = { ms, fire: cb };
    into.push(t);
    return () => { const at = into.indexOf(t); if (at >= 0) into.splice(at, 1); };
  };

  beforeEach(async () => {
    nowMs = Date.now();
    store = new BrokerDownRunStore();
    timers = [];
    errors = [];
    vm = new RunViewModel(store, () => new Date(nowMs), collect([]));
    await vm.hydrate();
    mirror = createDecisionMirror({ runs: vm, onError: (e) => errors.push(e), setTimer: collect(timers) });
    runId = (await vm.createRun({ task: 'buy the thing', sessionId: 'sess-1' })).id;
    await mirror.parked({ approval_id: 'ap-1', action: 'pay $40', risk: 'money', session_id: 'sess-1' });
    store.appends.length = 0;
  });

  /** Drain the microtask queue. Two hops, because a failed attempt probes before it sleeps. */
  const settled = async (): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  const fireAll = async (): Promise<void> => {
    for (const t of [...timers]) t.fire();
    await settled();
  };

  const resolutions = (): Array<Record<string, unknown>> =>
    store.appends.filter((a) => a.type === 'decision.resolved').map((a) => a.payload);

  it('lands exactly one resolution once the store heals, and the projection agrees', async () => {
    store.down = true;
    const answering = mirror.resolved('ap-1', 'approved');
    await settled();

    // The append failed, and the ONLY timer left is the retry — the two-minute auto-deny is already
    // gone, cancelled by the answer rather than by the answer landing.
    expect(timers.map((t) => t.ms)).toEqual([APPEND_RETRY_DELAYS_MS[0]]);
    expect(resolutions()).toEqual([]);
    expect(vm.snapshot(runId)!.status).toBe('needs_you');

    store.down = false;
    await fireAll();

    expect(await answering).toEqual({ durable: true });
    expect(resolutions()).toEqual([{ decisionId: 'ap-1', outcome: 'approved', by: 'human' }]);
    // The projection is the second half of the claim: a log nothing folded is a log no surface reads.
    expect(vm.snapshot(runId)!.pendingDecisions).toEqual([]);
    expect(vm.snapshot(runId)!.status).toBe('running');
  });

  /**
   * The half a retry gets WRONG unless it asks the durable log.
   *
   * The append committed and only its reply was lost, so the projection has already folded the
   * resolution off the live tail — and a retry that trusted "the call threw" would append a second
   * `decision.resolved` for one card. `pendingDecisions` cannot answer it either: it drops a card at
   * its two-minute deadline as well as at its resolution, so "no longer pending" conflates the two.
   */
  it('writes no second resolution when the append committed and its reply was lost', async () => {
    store.loseReplyFor = 1;
    const answering = mirror.resolved('ap-1', 'approved');
    await settled();

    expect(await answering).toEqual({ durable: true });
    expect(resolutions()).toEqual([{ decisionId: 'ap-1', outcome: 'approved', by: 'human' }]);
    // And no retry was ever armed, because there was nothing left to write.
    expect(timers).toEqual([]);
  });

  /**
   * Pin the ORDERING the reproduction turned on: the answer cancels the auto-deny at the moment it is
   * ACCEPTED, so no `auto_denied` can be written for a card a human has answered — not even while the
   * answer's append is still being retried past the card's own deadline. The clock is advanced past
   * `AUTO_DENY_MS` here on purpose: that is the point at which the projection stops listing the card,
   * so the run→card link this module keeps is the only thing that can still place the resolution.
   */
  it('never writes a contradictory auto-deny while a human answer is still being retried', async () => {
    store.down = true;
    const answering = mirror.resolved('ap-1', 'approved');
    await settled();

    nowMs += 120_000 + 1_000; // past the deadline: the card is gone from the projection
    expect(vm.snapshot(runId)!.pendingDecisions).toEqual([]);
    store.down = false;
    await fireAll();

    expect(await answering).toEqual({ durable: true });
    expect(resolutions()).toEqual([{ decisionId: 'ap-1', outcome: 'approved', by: 'human' }]);
  });

  /**
   * Contract row "an approval pending blocks THAT run only" — during the retry window as well as
   * during the wait. The retry sleeps on the mirror's own clock and never holds the run lane, so a
   * second run raises and answers a card of its own while the first one's answer is still in the air.
   */
  it('lets other runs raise and answer their own cards while one card is retrying', async () => {
    const other = await vm.createRun({ task: 'unrelated', sessionId: 'sess-2' });
    store.down = true;
    const answering = mirror.resolved('ap-1', 'approved');
    await settled();
    store.down = false;

    await mirror.parked({ approval_id: 'ap-2', action: 'pay $9', risk: 'money', session_id: 'sess-2' });
    expect(vm.snapshot(other.id)!.status).toBe('needs_you');
    expect(await mirror.resolved('ap-2', 'denied')).toEqual({ durable: true });
    expect(vm.snapshot(other.id)!.status).toBe('running');

    await fireAll();
    expect(await answering).toEqual({ durable: true });
    expect(resolutions()).toEqual([
      { decisionId: 'ap-2', outcome: 'denied', by: 'human' },
      { decisionId: 'ap-1', outcome: 'approved', by: 'human' },
    ]);
  });

  /**
   * The bound, and what survives it. An answer the schedule could not land is reported as UNRECORDED
   * rather than swallowed — and the card→run link is kept, so the repeat answer that used to write
   * nothing writes the resolution the first attempt could not.
   */
  it('reports an unrecordable answer, and lets a repeat answer land it after the heal', async () => {
    store.down = true;
    const answering = mirror.resolved('ap-1', 'approved');
    for (let i = 0; i < APPEND_RETRY_DELAYS_MS.length; i += 1) {
      await settled();
      await fireAll();
    }

    const failure = await answering;
    expect(failure.durable).toBe(false);
    expect(resolutions()).toEqual([]);
    // Beyond stderr is the whole point, but the attempts are logged too — a silent retry loop is a
    // silent failure with extra steps.
    expect(errors.length).toBeGreaterThan(0);

    store.down = false;
    expect(await mirror.resolved('ap-1', 'approved')).toEqual({ durable: true });
    expect(resolutions()).toEqual([{ decisionId: 'ap-1', outcome: 'approved', by: 'human' }]);
  });

  /**
   * The card→run link, and why it survives the append rather than being dropped before it.
   *
   * `settle` used to delete the link and THEN await the write, so a failed append erased the card from
   * this module entirely — and the fallback that would have replaced it cannot: `runForDecision` reads
   * `pendingDecisions`, which drops the card at its two-minute deadline. Past that point this map is
   * the ONLY thing that still knows which run the card belongs to, so a repeat answer after a long
   * outage had nowhere to write and recorded nothing at all.
   */
  it('still knows which run an unrecorded card belongs to after its deadline has passed', async () => {
    store.down = true;
    const answering = mirror.resolved('ap-1', 'approved');
    for (let i = 0; i < APPEND_RETRY_DELAYS_MS.length; i += 1) {
      await settled();
      await fireAll();
    }
    expect((await answering).durable).toBe(false);

    // The outage outlasted the card: the projection no longer lists it, so nothing derived from the
    // projection can place the answer.
    nowMs += 120_000 + 1_000;
    expect(vm.snapshot(runId)!.pendingDecisions).toEqual([]);
    expect(vm.runForDecision('ap-1')).toBeUndefined();

    store.down = false;
    expect(await mirror.resolved('ap-1', 'approved')).toEqual({ durable: true });
    expect(resolutions()).toEqual([{ decisionId: 'ap-1', outcome: 'approved', by: 'human' }]);
  });

  /**
   * The write and the probe failing TOGETHER — the one interleaving a post-failure probe alone cannot
   * cover.
   *
   * The append commits, the pipe dies before its reply AND before the probe can be made, and the store
   * comes back later. By then the log already holds the resolution, so the next attempt must ask before
   * it writes rather than only after it fails — otherwise one card gets two resolutions. The floor that
   * probe reads from has to be the ORIGINAL one too: a floor taken after the heal sits above the
   * envelope it is looking for, and would answer "not landed" over a log that has it.
   */
  it('writes no second resolution when the committing attempt and its probe both died', async () => {
    store.loseReplyFor = 1;
    store.down = true; // the probe after the failure cannot reach the store either
    const answering = mirror.resolved('ap-1', 'approved');
    for (let i = 0; i < APPEND_RETRY_DELAYS_MS.length; i += 1) {
      await settled();
      await fireAll();
    }
    // The write DID land — the mirror just has no way to know it yet.
    expect((await answering).durable).toBe(false);
    expect(resolutions()).toEqual([{ decisionId: 'ap-1', outcome: 'approved', by: 'human' }]);

    store.down = false;
    expect(await mirror.resolved('ap-1', 'approved')).toEqual({ durable: true });

    expect(resolutions()).toEqual([{ decisionId: 'ap-1', outcome: 'approved', by: 'human' }]);
  });

  it('answers a card it has already recorded without writing a second resolution', async () => {
    expect(await mirror.resolved('ap-1', 'approved')).toEqual({ durable: true });
    expect(await mirror.resolved('ap-1', 'denied')).toEqual({ durable: true });

    expect(resolutions()).toEqual([{ decisionId: 'ap-1', outcome: 'approved', by: 'human' }]);
  });

  it('wakes a sleeping retry when it is torn down rather than holding the answer open', async () => {
    store.down = true;
    const answering = mirror.resolved('ap-1', 'approved');
    await settled();

    mirror.dispose();

    expect((await answering).durable).toBe(false);
    expect(resolutions()).toEqual([]);
  });
});

/**
 * The ordering itself, at the seam the human's click actually arrives on.
 *
 * `resolveApproval` releases the parked action SYNCHRONOUSLY — one line earlier than the append, in
 * the shipped code — so no amount of retrying behind it can help: by the time the first attempt
 * fails, the action has run. The fix is the order, and this is where it is pinned.
 */
describe('the human card click, ordered so the log cannot lie about it', () => {
  const stub = (durability: DecisionDurability) => {
    const released: Array<[string, string]> = [];
    const resurfaced: string[] = [];
    const errors: unknown[] = [];
    const asked: Array<[string, string]> = [];
    /**
     * One interleaved trace rather than two independent tallies, because the claim is the ORDER. Two
     * call logs both say "it happened", which is exactly what the defect also said.
     */
    const trace: string[] = [];
    const decide = createApprovalDecider({
      decisions: {
        resolved: (id, outcome) => {
          asked.push([id, outcome]);
          trace.push(`recorded:${durability.durable}`);
          return Promise.resolve(durability);
        },
      },
      release: (id, decision) => { released.push([id, decision]); trace.push('released'); },
      resurface: (id) => { resurfaced.push(id); trace.push('resurfaced'); },
      onError: (e) => errors.push(e),
    });
    return { decide, released, resurfaced, errors, asked, trace };
  };

  it('records the answer first, then releases the action', async () => {
    const s = stub({ durable: true });

    expect(await s.decide('ap-1', 'allow')).toEqual({ recorded: true });

    expect(s.asked).toEqual([['ap-1', 'approved']]);
    // The whole fix, as a sequence: nothing is let go before the log has the answer.
    expect(s.trace).toEqual(['recorded:true', 'released']);
    expect(s.released).toEqual([['ap-1', 'allow']]);
    expect(s.errors).toEqual([]);
  });

  it('maps a deny to the outcome the log records for it', async () => {
    const s = stub({ durable: true });
    await s.decide('ap-1', 'deny');
    expect(s.asked).toEqual([['ap-1', 'denied']]);
    expect(s.trace).toEqual(['recorded:true', 'released']);
    expect(s.released).toEqual([['ap-1', 'deny']]);
  });

  /**
   * Fail closed. An answer that could not be recorded releases NOTHING — this is the row that stops
   * the run log lying by omission about an action that already happened.
   */
  it('releases nothing when the answer could not be recorded, and says so to the surface that answered', async () => {
    const s = stub({ durable: false, reason: 'broker: not running' });

    const reply = await s.decide('ap-1', 'allow');

    expect(reply).toEqual({ recorded: false, reason: 'broker: not running' });
    expect(s.released).toEqual([]);
    expect(s.trace).toEqual(['recorded:false', 'resurfaced']);
    // Beyond stderr, twice: a structured reply to the caller, and the card back in front of the human.
    expect(s.resurfaced).toEqual(['ap-1']);
    expect(s.errors).toHaveLength(1);
  });
});
