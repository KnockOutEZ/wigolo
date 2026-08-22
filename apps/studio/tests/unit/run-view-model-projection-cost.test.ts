import { describe, it, expect, vi } from 'vitest';
import { RunViewModel } from '../../src/main/run-view-model';
import { FakeRunStore } from '../helpers/fake-run-store';

/**
 * `projectRun` replays a whole log. The view-model memoises it and drops the memo when a run's events
 * change, so folding is supposed to be cheap and projecting is supposed to happen on READ — once per
 * burst, not once per envelope.
 *
 * That is easy to lose by accident: any per-envelope check written as "project, then look at the
 * result" turns folding a run of N envelopes into N replays, which is quadratic in the exact place the
 * retention bound exists to make cheap. This file counts the replays, because nothing about the
 * resulting projection is different when they are quadratic — only the clock is, and a clock
 * assertion is a flake.
 */
const counter = vi.hoisted(() => ({ projections: 0 }));

vi.mock('wigolo/studio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wigolo/studio')>();
  const counted: typeof actual.projectRun = (facts, events) => {
    counter.projections++;
    return actual.projectRun(facts, events);
  };
  return { ...actual, projectRun: counted };
});

describe('RunViewModel — folding an envelope does not replay the log', () => {
  it('projects on read and on sealing, never once per folded envelope', async () => {
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);
    await vm.hydrate();
    const run = await vm.createRun({ task: 'a chatty one' });

    counter.projections = 0;
    for (let i = 0; i < 50; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    // Nobody read the run, so nothing had to be replayed to fold 50 envelopes in.
    expect(counter.projections, 'folding replayed the log per envelope').toBe(0);

    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(50);
    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(50);
    expect(counter.projections, 'the memo did not survive a second read').toBe(1);

    // Ending the run costs exactly one more: the projection that is kept in place of the log.
    counter.projections = 0;
    await vm.endRun(run.id, 'completed');
    expect(counter.projections).toBe(1);
    expect(vm.retainedEventCount(run.id)).toBe(0);
    expect(vm.snapshot(run.id)?.status).toBe('done');
    expect(counter.projections, 'a sealed run re-projected instead of answering from what it kept').toBe(1);
  });
});
