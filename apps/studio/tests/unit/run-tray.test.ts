import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildTrayMenu,
  createRunTray,
  trayLabel,
  trayTooltip,
  TRAY_ICON_1X,
  TRAY_ICON_2X,
  type DockPort,
  type TrayMenuItem,
  type TrayPort,
} from '../../src/main/run-tray';
import type { RunSummary } from '../../src/main/run-view-model';

/**
 * Pin 5's minimal surface: the menu-bar item is how a human discovers a run nobody is watching, and
 * the only way to promote one when there is no window on screen at all. It is therefore the ONE
 * surface that must be correct while everything else is withheld.
 *
 * The count and the menu are pure functions of the run projection, tested as such — a menu built from
 * anything the tray itself remembers would drift from the log the moment a run changed elsewhere.
 */

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: '7fq2',
  task: 'read the release notes',
  status: 'running',
  tabIds: [],
  visibility: 'hidden',
  ...over,
});

const labels = (items: TrayMenuItem[]): string[] => items.map((i) => i.label ?? `<${i.type}>`);

describe('the menu-bar item states what is running', () => {
  it('shows the live run count, and nothing at all when nothing is running', () => {
    expect(trayLabel([])).toBe('');
    expect(trayLabel([run()])).toBe('1');
    expect(trayLabel([run({ id: 'a' }), run({ id: 'b' })])).toBe('2');
  });

  // A run that has ended is not running, and counting it would make the menu bar claim work that is
  // over. It stays in the MENU while it is still being watched, so it can be demoted.
  it('counts only live runs, not ones that have ended', () => {
    expect(trayLabel([run({ status: 'done' }), run({ id: 'b' })])).toBe('1');
    expect(trayLabel([run({ status: 'failed' }), run({ id: 'b', status: 'cancelled' })])).toBe('');
  });

  it('names the count and the attention state in the tooltip, in sentence case', () => {
    expect(trayTooltip([])).toBe('wigolo studio — no runs');
    expect(trayTooltip([run()])).toBe('wigolo studio — 1 run');
    expect(trayTooltip([run({ id: 'a' }), run({ id: 'b', status: 'needs_you' })])).toBe(
      'wigolo studio — 2 runs, 1 needs you',
    );
  });
});

describe('the menu offers a promote for every run', () => {
  it('says so plainly when there is nothing to show', () => {
    expect(buildTrayMenu([], () => {})).toEqual([{ label: 'No runs', enabled: false }]);
  });

  it('lists each run as a checkbox that is ticked while it is being watched', () => {
    const menu = buildTrayMenu([run(), run({ id: 'k3vp', task: 'check prices', visibility: 'visible' })], () => {});

    expect(labels(menu)).toEqual([
      '2 runs',
      '<separator>',
      '7fq2 · read the release notes',
      'k3vp · check prices',
    ]);
    expect(menu[2].type).toBe('checkbox');
    expect(menu[2].checked).toBe(false);
    expect(menu[3].checked).toBe(true);
  });

  it('toggles: clicking a hidden run promotes it, clicking a watched one demotes it', () => {
    const asked: Array<[string, 'visible' | 'hidden']> = [];
    const menu = buildTrayMenu(
      [run(), run({ id: 'k3vp', visibility: 'visible' })],
      (id, next) => asked.push([id, next]),
    );

    menu[2].click!();
    menu[3].click!();

    expect(asked).toEqual([['7fq2', 'visible'], ['k3vp', 'hidden']]);
  });

  // Amber means "needs you" and nothing else — an OS menu has no colour to give it, so it is said in
  // words instead. The other non-running states are named too, so a stalled run is never silent.
  it('names the state of any run that is not simply running', () => {
    const menu = buildTrayMenu(
      [
        run({ id: 'a', status: 'needs_you' }),
        run({ id: 'b', status: 'paused' }),
        run({ id: 'c', status: 'done', visibility: 'visible' }),
      ],
      () => {},
    );

    expect(labels(menu).slice(2)).toEqual([
      'a · read the release notes — needs you',
      'b · read the release notes — paused',
      'c · read the release notes — done',
    ]);
  });

  it('drops a run that has ended and is not being watched', () => {
    const menu = buildTrayMenu([run({ id: 'over', status: 'done' }), run({ id: 'live' })], () => {});
    expect(labels(menu)).toEqual(['1 run', '<separator>', 'live · read the release notes']);
  });

  // §4's label-fitting law, in the one place the design system cannot reach: a menu the OS renders.
  it('shortens a long task rather than letting the menu grow without limit', () => {
    const long = 'summarise every entry in the changelog and tell me which ones affect the parser';
    const menu = buildTrayMenu([run({ task: long })], () => {});
    const label = menu[2].label!;
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label.endsWith('…')).toBe(true);
    expect(label.startsWith('7fq2 · summarise every entry')).toBe(true);
  });
});

describe('the tray follows the projection', () => {
  class FakeTray implements TrayPort {
    label = '<unset>';
    tooltip = '<unset>';
    menu: TrayMenuItem[] = [];
    destroyed = false;
    setLabel(v: string): void { this.label = v; }
    setToolTip(v: string): void { this.tooltip = v; }
    setMenu(items: TrayMenuItem[]): void { this.menu = items; }
    destroy(): void { this.destroyed = true; }
  }

  class FakeDock implements DockPort {
    badge = '<unset>';
    setBadge(v: string): void { this.badge = v; }
  }

  let tray: FakeTray;
  let dock: FakeDock;
  let runs: RunSummary[];

  let notify = (): void => {};

  /** Mount the tray, then push a set of runs through the projection's change signal. */
  const mount = (next: RunSummary[] = [run({ status: 'needs_you' }), run({ id: 'b' })]): ReturnType<typeof createRunTray> => {
    const handle = createRunTray({
      tray,
      dock,
      runs: { list: () => runs, onChange: (cb) => { notify = cb; } },
      setVisibility: async () => {},
      onError: () => {},
    });
    runs = next;
    notify();
    return handle;
  };

  beforeEach(() => {
    tray = new FakeTray();
    dock = new FakeDock();
    runs = [];
  });

  it('redraws the count, the tooltip and the menu whenever the runs move', () => {
    mount();
    expect(tray.label).toBe('2');
    expect(tray.tooltip).toBe('wigolo studio — 2 runs, 1 needs you');
    expect(labels(tray.menu)).toEqual([
      '2 runs, 1 needs you',
      '<separator>',
      '7fq2 · read the release notes — needs you',
      'b · read the release notes',
    ]);
  });

  // Law 11 and the amber rule: "needs you" is the one thing allowed to reach out for attention, and
  // the dock badge is the only attention affordance a withheld window has.
  it('badges the dock with the number of runs that need a human, and clears it when none do', () => {
    mount();
    expect(dock.badge).toBe('1');

    runs = [run({ id: 'b' })];
    notify();
    expect(dock.badge).toBe('');
  });

  it('carries an icon at both scale factors so the menu bar is not blurry on a retina display', () => {
    expect(TRAY_ICON_1X.byteLength).toBeGreaterThan(0);
    expect(TRAY_ICON_2X.byteLength).toBeGreaterThan(TRAY_ICON_1X.byteLength);
    // PNG magic — a truncated or text-mangled base64 constant would still be a Buffer.
    for (const buf of [TRAY_ICON_1X, TRAY_ICON_2X]) expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('reports a refused transition instead of throwing into the menu handler', async () => {
    const seen: unknown[] = [];
    let notify = (): void => {};
    createRunTray({
      tray,
      dock,
      runs: { list: () => runs, onChange: (cb) => { notify = cb; } },
      setVisibility: async () => { throw new Error('the studio window is no longer available'); },
      onError: (err) => seen.push(err),
    });
    runs = [run()];
    notify();

    tray.menu[2].click!();
    await new Promise((r) => setImmediate(r));

    // An unhandled rejection out of a menu click takes the whole main process down on some platforms,
    // and the human just clicked the only affordance a hidden run has.
    expect(String(seen[0])).toContain('no longer available');
  });

  it('lets go of the OS item when it is torn down', () => {
    mount().destroy();
    expect(tray.destroyed).toBe(true);
  });
});
