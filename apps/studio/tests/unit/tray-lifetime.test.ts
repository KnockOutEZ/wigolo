import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
 * changes whether the call THROWS, not whether it happens. So every arm here asserts the two things
 * the outage was made of: nothing escapes `applyEvent`, AND the tray's redraw did not fail in place.
 *
 * The second half is not decoration. `RunViewModel.fanOut` isolates its listeners from each other
 * now (issue #111), which is defence in depth against exactly this crash — so "nothing escapes
 * `applyEvent`" is true on its own whether or not this guard exists, and an arm resting on it alone
 * has stopped testing the guard. What the isolation cannot do is keep the menu bar updating: an
 * unguarded tray still throws, the fan-out catches it and REPORTS it, and the item stops redrawing.
 * That report is the observable that still separates the two worlds, so it is what these arms read.
 * The negative-control block at the bottom runs the same two orderings through the UNGUARDED port
 * and requires the failure back.
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

/**
 * What the fan-out reported while the arm ran. `RunViewModel.fanOut` catches a listener's throw and
 * writes it to stderr rather than letting it reach the main process's stack, so this is where an
 * unguarded tray's failure now shows up — and the only thing that still tells the two worlds apart.
 */
function captureFanOutReports(): { reports: () => string; restore: () => void } {
  const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  return { reports: () => spy.mock.calls.map((c) => String(c[0])).join(''), restore: () => { spy.mockRestore(); } };
}

describe('a run event that outlives the menu-bar item', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;
  let item: DestroyableTray;
  let runId: string;
  let fanOut: ReturnType<typeof captureFanOutReports>;

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
      runs: { listLive: () => vm.listLive(), onChange: (cb) => vm.onChange(cb) },
      setVisibility: async () => {},
      onError: () => {},
    });

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
    runId = (await vm.createRun({ task: 'read the release notes' })).id;
    item = new DestroyableTray();
    fanOut = captureFanOutReports();
  });

  afterEach(() => { fanOut.restore(); });

  // Ordering one: the platform tore the item down and the socket delivers afterwards. This is the
  // reported stack verbatim. Note the tray handle is NEVER destroyed here — its own `gone` flag knows
  // only about teardowns it performed, so nothing but the seam guard is between this and the modal.
  it('is a no-op when the item was destroyed before the event arrived', () => {
    mount(livingTrayPort(item, rawPort(item)));
    item.destroy();

    expect(() => vm.applyEvent(runId, nextEvent())).not.toThrow();
    // …and the redraw did not merely fail somewhere the fan-out swallowed it. See the header.
    expect(fanOut.reports(), 'the guarded tray threw and the fan-out caught it').toBe('');
  });

  // Ordering two: the event lands DURING teardown. The engine's own destroy runs nested tasks, so a
  // socket line can be delivered after the item is dead and before `destroy()` has returned — the
  // one window where a guard placed after the teardown, rather than at the seam, would still miss.
  it('is a no-op when the event arrives inside the teardown itself', () => {
    mount(livingTrayPort(item, rawPort(item)));
    item.onTeardown = () => vm.applyEvent(runId, nextEvent());

    expect(() => item.destroy()).not.toThrow();
    expect(fanOut.reports(), 'the guarded tray threw and the fan-out caught it').toBe('');
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
 *
 * WHERE THE OUTAGE LANDS MOVED, and the control moved with it. These arms used to require the throw
 * to escape `vm.applyEvent`, which was true because `fanOut` called its listeners bare. It isolates
 * them now (issue #111), so the unguarded throw no longer reaches the main process's stack — that is
 * the second layer working, not the outage going away. The redraw still fails, the menu bar still
 * stops updating, and the fan-out now says so on stderr. So that report is what the control reads.
 * Reading nothing at all here would be the failure mode this block exists to prevent.
 */
describe('without the guard, the same two orderings are the outage', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;
  let item: DestroyableTray;
  let runId: string;
  let fanOut: ReturnType<typeof captureFanOutReports>;

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
      runs: { listLive: () => vm.listLive(), onChange: (cb) => vm.onChange(cb) },
      setVisibility: async () => {},
      onError: () => {},
    });
    fanOut = captureFanOutReports();
  });

  afterEach(() => { fanOut.restore(); });

  it('breaks the redraw when the item was destroyed first', () => {
    item.destroy();
    vm.applyEvent(runId, nextEvent());
    expect(fanOut.reports(), 'the unguarded tray redrew a destroyed item without failing').toMatch(/run-projection listener threw[\s\S]*Tray is destroyed/);
  });

  it('breaks the redraw when the event arrives inside the teardown', () => {
    item.onTeardown = () => vm.applyEvent(runId, nextEvent());
    item.destroy();
    expect(fanOut.reports(), 'the unguarded tray redrew a destroyed item without failing').toMatch(/run-projection listener threw[\s\S]*Tray is destroyed/);
  });
});
