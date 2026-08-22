import { RunPresentationController } from './run-presentation';
import { isTerminal, type RunSummary } from './run-view-model';

/**
 * Pin 5 — the menu-bar item, and the whole of a headless run's discoverability.
 *
 * When every run is withheld there is no window, no tab strip and no panel; law 2 says that is the
 * NORMAL state, not an edge case. This is what is left: a live count of what is running, a promote for
 * each one, and a dock badge when something needs a human. It is deliberately the minimum — the fleet
 * screen is SD3's, and a menu-bar item that grew a cockpit would be a second one.
 *
 * Everything here is a pure function of the run projection. The item holds no run state of its own, so
 * it cannot disagree with the log the way a cached list would.
 */

/** One entry, in the shape an OS menu takes — kept structural so the builders stay testable. */
export interface TrayMenuItem {
  label?: string;
  type?: 'separator' | 'checkbox';
  enabled?: boolean;
  checked?: boolean;
  click?: () => void;
}

/** The OS item, narrowed. `setLabel` is the menu-bar text; platforms without one ignore it. */
export interface TrayPort {
  setLabel(text: string): void;
  setToolTip(text: string): void;
  setMenu(items: TrayMenuItem[]): void;
  destroy(): void;
}

/** The dock/taskbar badge. Absent on platforms that have none. */
export interface DockPort {
  setBadge(text: string): void;
}

export interface TrayRuns {
  list(): RunSummary[];
  onChange(cb: () => void): void;
}

export interface RunTrayDeps {
  tray: TrayPort;
  dock?: DockPort | undefined;
  runs: TrayRuns;
  setVisibility(runId: string, next: 'visible' | 'hidden'): Promise<void>;
  onError(err: unknown): void;
}

export interface RunTrayHandle {
  refresh(): void;
  destroy(): void;
  /** The menu as last built — the same items, with the same handlers, the OS is showing. */
  menu(): TrayMenuItem[];
}

/** Long enough to recognise the task, short enough that the menu never runs off the screen edge. */
const MAX_TASK_CHARS = 52;

const live = (runs: readonly RunSummary[]): RunSummary[] => runs.filter((r) => !isTerminal(r.status));

export function needsYouCount(runs: readonly RunSummary[]): number {
  return runs.filter((r) => r.status === 'needs_you').length;
}

/** The menu-bar text: the live run count, and nothing at all when nothing is running. */
export function trayLabel(runs: readonly RunSummary[]): string {
  const n = live(runs).length;
  return n === 0 ? '' : String(n);
}

function countPhrase(runs: readonly RunSummary[]): string {
  const n = live(runs).length;
  const needs = needsYouCount(runs);
  const head = n === 0 ? 'no runs' : n === 1 ? '1 run' : `${n} runs`;
  return needs === 0 ? head : `${head}, ${needs} needs you`;
}

export function trayTooltip(runs: readonly RunSummary[]): string {
  return `wigolo studio — ${countPhrase(runs)}`;
}

function shorten(task: string): string {
  const flat = task.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_TASK_CHARS ? flat : `${flat.slice(0, MAX_TASK_CHARS - 1).trimEnd()}…`;
}

/** Only "running" goes unsaid. An OS menu has no amber to give, so "needs you" is said in words. */
function stateSuffix(status: RunSummary['status']): string {
  if (status === 'running') return '';
  return status === 'needs_you' ? ' — needs you' : ` — ${status}`;
}

export function buildTrayMenu(
  runs: readonly RunSummary[],
  toggle: (runId: string, next: 'visible' | 'hidden') => void,
): TrayMenuItem[] {
  const listed = RunPresentationController.listable(runs);
  if (listed.length === 0) return [{ label: 'No runs', enabled: false }];
  return [
    { label: countPhrase(runs), enabled: false },
    { type: 'separator' },
    ...listed.map((r) => ({
      label: `${r.id} · ${shorten(r.task)}${stateSuffix(r.status)}`,
      type: 'checkbox' as const,
      checked: r.visibility === 'visible',
      click: () => toggle(r.id, r.visibility === 'visible' ? 'hidden' : 'visible'),
    })),
  ];
}

export function createRunTray(deps: RunTrayDeps): RunTrayHandle {
  let current: TrayMenuItem[] = [];
  const refresh = (): void => {
    const runs = deps.runs.list();
    deps.tray.setLabel(trayLabel(runs));
    deps.tray.setToolTip(trayTooltip(runs));
    current = buildTrayMenu(runs, (runId, next) => {
      // A rejected transition (the window is gone, the run just ended) must surface as a logged
      // error, never as an unhandled rejection out of a menu click — this is the only affordance a
      // withheld run has, and taking the main process down with it is not a failure mode.
      void deps.setVisibility(runId, next).catch(deps.onError);
    });
    deps.tray.setMenu(current);
    // Attention, and only attention: the badge counts runs that need a human, and is cleared the
    // moment none do. Nothing else is ever allowed to light it up.
    deps.dock?.setBadge(needsYouCount(runs) > 0 ? String(needsYouCount(runs)) : '');
  };

  deps.runs.onChange(refresh);
  refresh();

  return { refresh, destroy: () => deps.tray.destroy(), menu: () => current };
}

/**
 * The menu-bar glyph: `identity-ring` (DESIGN_SYSTEM §4) as a monochrome template image, so the OS
 * tints it for the menu bar it is actually in — one asset, both registers, which is the same rule the
 * token layer follows. Inlined rather than shipped as a file because the packaged app resolves assets
 * out of an asar archive and a missing icon leaves an invisible, unclickable menu-bar item.
 */
export const TRAY_ICON_1X = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAdElEQVR42mNgoBFwYGBg6GdgYNgPxf1QMYJAAKrhPwMDw3skA95DxfZD1eDU/B6KE7DIJyDJYzUEZpMBHhcaILkMw8//cdiMzSX/0cOkH2oyseA9VA+K8/eTYACGeooNoNgLFAcixdFIlYREcVKmSmYiGQAA+cs3RS9qrtQAAAAASUVORK5CYII=',
  'base64',
);
export const TRAY_ICON_2X = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA2UlEQVR42u1X2wkEIQycElLKlrAlWMKWkk4swRIsaUu4B/ixBF/4IOG4QEAkMWMmagT+MiYnAPcZcFKX5rYH9QBuAK+C3slmKZgDQKwELWlMvlNyVRZnoSWQ12hwzqT3O0cVH0o2kiae3XloBM4BCaOZOISjn6DQi7W6aiKKnc9KELXTPGpPzmkBABI1cfamjBceZe6l9ImUFgIgkdlm+uOGmzS2aHCb0p+jwbUMdgNgkwDUKVAvQvVjaOIiUr+K1R8jE8+xekNioiUz0ZSaaMtNfEzMfM1+U96EVtk5W55HFwAAAABJRU5ErkJggg==',
  'base64',
);
