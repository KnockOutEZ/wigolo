import { describe, it, expect, beforeEach } from 'vitest';
import { RunViewModel } from '../../src/main/run-view-model';
import { RunPresentationController, WindowGoneError, type PresentationWindow } from '../../src/main/run-presentation';
import { FakeRunStore } from '../helpers/fake-run-store';

/**
 * Law 2 — a run exists whether or not anyone is watching. Headless is the default state, and a run is
 * promoted to a window mid-flight and demoted back without the run itself noticing.
 *
 * Two halves, tested apart because they fail apart: the transition is a RUN EVENT (the view-model
 * half, replayable by anything reading the log), and the window presentation is a PROJECTION of those
 * events (the controller half). The window is never a source of truth about which runs are visible —
 * that has to stay in the log, or a second surface reading the same runs would disagree with this one.
 */

class FakeWindow implements PresentationWindow {
  destroyed = false;
  opacity = 0;
  ignoresMouse = true;
  skipsTaskbar = true;
  /** Every presentation call in order, so a test can assert what was NOT done (`minimize`, `hide`). */
  readonly calls: string[] = [];

  isDestroyed(): boolean { return this.destroyed; }
  setOpacity(v: number): void { this.opacity = v; this.calls.push(`opacity:${v}`); }
  setIgnoreMouseEvents(v: boolean): void { this.ignoresMouse = v; this.calls.push(`ignoreMouse:${v}`); }
  setSkipTaskbar(v: boolean): void { this.skipsTaskbar = v; this.calls.push(`skipTaskbar:${v}`); }
  showInactive(): void { this.calls.push('showInactive'); }
  show(): void { this.calls.push('show'); }
  focus(): void { this.calls.push('focus'); }
}

describe('presentation transitions are run events', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
  });

  it('records a promote as presentation.promoted carrying who did it and from where', async () => {
    const run = await vm.createRun({ task: 'read the changelog' });
    store.appends.length = 0;

    await vm.setVisibility(run.id, 'visible', 'human', 'tray');

    expect(store.appends).toEqual([
      { runId: run.id, type: 'presentation.promoted', payload: { by: 'human', surface: 'tray' } },
    ]);
    expect(vm.snapshot(run.id)!.visibility).toBe('visible');
  });

  it('records a demote as presentation.demoted, and the run keeps running', async () => {
    const run = await vm.createRun({ task: 'read the changelog' });
    await vm.setVisibility(run.id, 'visible', 'human', 'tray');
    store.appends.length = 0;

    await vm.setVisibility(run.id, 'hidden', 'human');

    expect(store.appends).toEqual([
      { runId: run.id, type: 'presentation.demoted', payload: { by: 'human' } },
    ]);
    const after = vm.snapshot(run.id)!;
    expect(after.visibility).toBe('hidden');
    // The only casualty of demotion is the chrome. Everything the run IS survives it.
    expect(after.status).toBe('running');
  });

  // §8's idempotence rule. Without it the tray's own re-render would write an event every time it
  // redrew, and the log would fill with transitions that never happened.
  it('writes no event when the run is already in the state asked for', async () => {
    const run = await vm.createRun({ task: 'idempotent' });
    await vm.setVisibility(run.id, 'visible', 'human', 'tray');
    store.appends.length = 0;

    expect(await vm.setVisibility(run.id, 'visible', 'human', 'tray')).toBe(false);
    expect(await vm.setVisibility(run.id, 'hidden', 'human')).toBe(true);
    expect(await vm.setVisibility(run.id, 'hidden', 'system')).toBe(false);
    expect(store.appends).toEqual([
      { runId: run.id, type: 'presentation.demoted', payload: { by: 'human' } },
    ]);
  });

  it('refuses to promote a run that has ended, and writes nothing', async () => {
    const run = await vm.createRun({ task: 'already over' });
    await vm.endRun(run.id, 'completed');
    store.appends.length = 0;

    await expect(vm.setVisibility(run.id, 'visible', 'human', 'tray')).rejects.toThrow(/has already ended/);
    expect(store.appends).toEqual([]);
  });

  // The reconcile path: a run that ended while the human was watching it is still marked visible in the
  // log, and the next boot has to be able to put that right without being refused.
  it('allows demoting a run that has ended', async () => {
    const run = await vm.createRun({ task: 'ended while watched' });
    await vm.setVisibility(run.id, 'visible', 'human', 'tray');
    await vm.endRun(run.id, 'completed');
    store.appends.length = 0;

    expect(await vm.setVisibility(run.id, 'hidden', 'system')).toBe(true);
    expect(store.appends).toEqual([{ runId: run.id, type: 'presentation.demoted', payload: { by: 'system' } }]);
  });

  it('refuses a run it has never seen rather than inventing one', async () => {
    await expect(vm.setVisibility('nope', 'visible', 'human', 'tray')).rejects.toThrow(/no such run/);
    expect(store.appends).toEqual([]);
  });

  it('reports visibility on the summary every surface reads', async () => {
    const a = await vm.createRun({ task: 'first' });
    await vm.createRun({ task: 'second' });
    await vm.setVisibility(a.id, 'visible', 'human', 'tray');

    expect(vm.list().map((r) => [r.task, r.visibility])).toEqual([['first', 'visible'], ['second', 'hidden']]);
  });
});

describe('the window is a projection of the runs, never the other way round', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;
  let win: FakeWindow;
  let focused: string[];

  const controller = (bootHidden = true): RunPresentationController =>
    new RunPresentationController({ runs: vm, window: win, focusTab: (id) => focused.push(id), bootHidden });

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    win = new FakeWindow();
    focused = [];
    await vm.hydrate();
  });

  it('boots headless: the window is mapped and withheld, never minimised or unmapped', () => {
    controller().apply();

    // Mapped-not-minimised is load-bearing — an unmapped window has no compositor surface, so its tabs
    // get no frames at all (hidden-mode.ts records the measurement). `showInactive`, never `show`.
    expect(win.calls).toEqual(['opacity:0', 'ignoreMouse:true', 'skipTaskbar:true', 'showInactive']);
    expect(win.calls).not.toContain('show');
  });

  it('presents the window and focuses the run’s tab when a run is promoted', async () => {
    const run = await vm.createRun({ task: 'watch me' });
    await vm.attachTab(run.id, 'tab-a');
    const c = controller();
    c.apply();
    win.calls.length = 0;

    await c.promote(run.id, 'human', 'tray');

    expect(win.opacity).toBe(1);
    expect(win.ignoresMouse).toBe(false);
    expect(win.skipsTaskbar).toBe(false);
    expect(win.calls).toContain('show');
    expect(focused).toEqual(['tab-a']);
  });

  it('withholds the window again on demote, and the run keeps its tab', async () => {
    const run = await vm.createRun({ task: 'watch me then don’t' });
    await vm.attachTab(run.id, 'tab-a');
    const c = controller();
    await c.promote(run.id, 'human', 'tray');
    win.calls.length = 0;

    await c.demote(run.id, 'human');

    expect(win.opacity).toBe(0);
    expect(win.ignoresMouse).toBe(true);
    expect(win.calls).toContain('showInactive');
    expect(vm.tabsOf(run.id)).toEqual(['tab-a']); // demotion is presentation only
  });

  it('keeps the window up while any other run is still promoted', async () => {
    const a = await vm.createRun({ task: 'first' });
    const b = await vm.createRun({ task: 'second' });
    await vm.attachTab(b.id, 'tab-b');
    const c = controller();
    await c.promote(a.id, 'human', 'tray');
    await c.promote(b.id, 'human', 'tray');
    win.calls.length = 0;

    await c.demote(a.id, 'human');

    expect(win.opacity).toBe(1);
    expect(win.calls).not.toContain('showInactive');
  });

  // The projection is shared: another writer (the REST surface, a second window) can promote a run, and
  // this window has to follow the log rather than only its own calls.
  it('follows a promotion it did not make itself', async () => {
    const run = await vm.createRun({ task: 'promoted elsewhere' });
    const c = controller();
    c.apply();
    win.calls.length = 0;

    await vm.setVisibility(run.id, 'visible', 'system', 'panel');

    expect(win.opacity).toBe(1);
  });

  it('leaves the window presented when the app was booted with one', async () => {
    const run = await vm.createRun({ task: 'human opened the app' });
    const c = controller(false);
    c.apply();
    expect(win.opacity).toBe(1);

    await c.promote(run.id, 'human', 'tray');
    await c.demote(run.id, 'human');

    // Demoting a run must not take away a window the human asked for at launch.
    expect(win.opacity).toBe(1);
  });

  it('puts every run back to hidden at boot — presentation is per-app-lifetime, not remembered', async () => {
    const a = await vm.createRun({ task: 'was visible last time' });
    const b = await vm.createRun({ task: 'ended while visible' });
    await vm.setVisibility(a.id, 'visible', 'human', 'tray');
    await vm.setVisibility(b.id, 'visible', 'human', 'tray');
    await vm.endRun(b.id, 'completed');
    store.appends.length = 0;

    await controller().reconcile();

    expect(store.appends).toEqual([
      { runId: a.id, type: 'presentation.demoted', payload: { by: 'system' } },
      { runId: b.id, type: 'presentation.demoted', payload: { by: 'system' } },
    ]);
    expect(win.opacity).toBe(0);
  });

  it('refuses a transition when the window is gone, and records nothing', async () => {
    const run = await vm.createRun({ task: 'orphaned' });
    win.destroyed = true;
    store.appends.length = 0;

    await expect(controller().promote(run.id, 'human', 'tray')).rejects.toBeInstanceOf(WindowGoneError);
    // An event for a transition that did not happen would make the log lie about what the human saw.
    expect(store.appends).toEqual([]);
    expect(vm.snapshot(run.id)!.visibility).toBe('hidden');
  });
});
