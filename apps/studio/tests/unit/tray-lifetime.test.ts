import { describe, it, expect, beforeEach } from 'vitest';
import type { RunEvent } from 'wigolo/studio';
import { createRunTray, type TrayMenuItem, type TrayPort } from '../../src/main/run-tray';
import { livingTrayPort } from '../../src/main/tray-lifetime';
import { RunViewModel } from '../../src/main/run-view-model';
import { FakeRunStore } from '../helpers/fake-run-store';

/**
 * The menu-bar item's lifetime guard, exercised through the path the crash actually took: a run event
 * arriving on the socket, folded in by `RunViewModel.applyEvent`, fanned out to the tray's redraw,
 * landing on an OS item the platform already destroyed. Unguarded that throws on the main process's
 * stack, and Electron answers a main-process throw with a modal dialog — which is a process that can
 * never exit. Twenty-one orphaned instances came out of exactly this, oldest alive two hours.
 *
 * WHAT IS ASSERTED, and why it is the observable rather than the call. A test that checked "setLabel
 * was not called" would still pass with the guard deleted at the wrapper, because the deleted guard
 * changes whether the call THROWS, not whether it happens. So every arm here asserts the one thing
 * the outage was made of: nothing escapes `applyEvent`. The negative-control arm at the bottom runs
 * the same two orderings through the UNGUARDED port and requires them to throw — without it, these
 * tests could not fail if the guard stopped being load-bearing.
 *
 * WHY THE DOUBLE IS TRUSTWORTHY. `FakeTray` in `run-tray.test.ts` cannot be destroyed — its `destroy`
 * sets a flag and every later call still succeeds — so it can never witness this class at all.
 * `DestroyableTray` below reproduces what Electron 43 was MEASURED to do, and that measurement is
 * pinned against the real `Tray` in `tests/e2e/tray-lifetime.spec.ts`, so if a future engine changes
 * its mind the e2e spec reds rather than this double quietly going on agreeing with itself.
 */

/** Electron 43's real `Tray`, as measured: readable lifetime, throwing setters, idempotent destroy. */
class DestroyableTray {
  label = '<unset>';
  tooltip = '<unset>';
  menu: TrayMenuItem[] = [];
  private dead = false;
  /** Fired from INSIDE destroy, before it returns — the platform pumps tasks during its teardown. */
  onTeardown: () => void = () => {};

  isDestroyed(): boolean {
    return this.dead; // stays readable after destroy; this is the difference from BrowserWindow
  }
  setTitle(v: string): void {
    this.assertAlive();
    this.label = v;
  }
  setToolTip(v: string): void {
    this.assertAlive();
    this.tooltip = v;
  }
  setContextMenu(items: TrayMenuItem[]): void {
    this.assertAlive();
    this.menu = items;
  }
  destroy(): void {
    if (this.dead) return; // a second destroy is a no-op on the real item, not a throw
    this.dead = true;
    this.onTeardown();
  }
  private assertAlive(): void {
    if (this.dead) throw new Error('Tray is destroyed');
  }
}

/** The wrapper `index.ts` builds around the OS item, minus the guard. The shape that shipped broken. */
const rawPort = (item: DestroyableTray): TrayPort => ({
  setLabel: (text) => item.setTitle(text),
  setToolTip: (text) => item.setToolTip(text),
  setMenu: (items) => item.setContextMenu(items),
  destroy: () => item.destroy(),
});

describe('a run event that outlives the menu-bar item', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;
  let item: DestroyableTray;
  let runId: string;

  /** The next envelope the socket would deliver for this run — the `onLine → applyEvent` entry point. */
  const nextEvent = (): RunEvent => ({
    seq: (store.log.get(runId)?.length ?? 0) + 1,
    ts: new Date(1_700_000_100_000).toISOString(),
    actor: { kind: 'daemon' },
    type: 'run.progress',
    payload: { note: 'still working' },
  });

  /** Mount the tray on the real projection. `port` decides whether the guard is in the path. */
  const mount = (port: TrayPort): ReturnType<typeof createRunTray> =>
    createRunTray({
      tray: port,
      runs: { list: () => vm.list(), onChange: (cb) => vm.onChange(cb) },
      setVisibility: async () => {},
      onError: () => {},
    });

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
    runId = (await vm.createRun({ task: 'read the release notes' })).id;
    item = new DestroyableTray();
  });

  // Ordering one: the platform tore the item down and the socket delivers afterwards. This is the
  // reported stack verbatim. Note the tray handle is NEVER destroyed here — its own `gone` flag knows
  // only about teardowns it performed, so nothing but the seam guard is between this and the modal.
  it('is a no-op when the item was destroyed before the event arrived', () => {
    mount(livingTrayPort(item, rawPort(item)));
    item.destroy();

    expect(() => vm.applyEvent(runId, nextEvent())).not.toThrow();
  });

  // Ordering two: the event lands DURING teardown. The engine's own destroy runs nested tasks, so a
  // socket line can be delivered after the item is dead and before `destroy()` has returned — the
  // one window where a guard placed after the teardown, rather than at the seam, would still miss.
  it('is a no-op when the event arrives inside the teardown itself', () => {
    mount(livingTrayPort(item, rawPort(item)));
    item.onTeardown = () => vm.applyEvent(runId, nextEvent());

    expect(() => item.destroy()).not.toThrow();
  });

  // Second destroy, and destroy after the platform already took the item: the guard covers `destroy`
  // too, so "no-op" means every method rather than three of the four.
  it('lets the tray handle be torn down after the platform already took the item', () => {
    const handle = mount(livingTrayPort(item, rawPort(item)));
    item.destroy();

    expect(() => handle.destroy()).not.toThrow();
  });

  // The guard must not be a blanket no-op: a tray that stopped redrawing would pass every arm above
  // and leave a menu bar that never updates, which is the whole feature.
  it('still redraws a live item — the guard is a lifetime read, not a switch', () => {
    mount(livingTrayPort(item, rawPort(item)));
    expect(item.label).toBe('1');
    expect(item.tooltip).toBe('wigolo studio — 1 run');

    vm.applyEvent(runId, nextEvent());
    expect(item.label).toBe('1');
    expect(item.menu.some((i) => i.label?.startsWith(runId))).toBe(true);
  });
});

/**
 * The negative control. Every arm above asserts an absence, and an absence is what a test asserts
 * when it has stopped testing anything — so these run the SAME two orderings with the guard removed
 * and require the outage back. If the guard ever becomes decorative, this describe block is what
 * notices.
 */
describe('without the guard, the same two orderings are the outage', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;
  let item: DestroyableTray;
  let runId: string;

  const nextEvent = (): RunEvent => ({
    seq: (store.log.get(runId)?.length ?? 0) + 1,
    ts: new Date(1_700_000_100_000).toISOString(),
    actor: { kind: 'daemon' },
    type: 'run.progress',
    payload: {},
  });

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
    runId = (await vm.createRun({ task: 'read the release notes' })).id;
    item = new DestroyableTray();
    createRunTray({
      tray: rawPort(item),
      runs: { list: () => vm.list(), onChange: (cb) => vm.onChange(cb) },
      setVisibility: async () => {},
      onError: () => {},
    });
  });

  it('throws out of applyEvent when the item was destroyed first', () => {
    item.destroy();
    expect(() => vm.applyEvent(runId, nextEvent())).toThrow(/Tray is destroyed/);
  });

  it('throws out of the teardown when the event arrives inside it', () => {
    item.onTeardown = () => vm.applyEvent(runId, nextEvent());
    expect(() => item.destroy()).toThrow(/Tray is destroyed/);
  });
});
