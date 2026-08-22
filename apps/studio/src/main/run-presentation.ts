import { hiddenWindowPresentation } from './hidden-mode';
import { isTerminal, type PresentationBy, type PromoteSurface, type RunSummary } from './run-view-model';

/**
 * Law 2 — headless is the default, not a mode. A run is created without a window, runs to completion
 * without one, and can be promoted to a visible window mid-flight and demoted back.
 *
 * `hidden-mode.ts` decided this ONCE, at boot, as a boolean. This turns those same two presentations
 * into a runtime machine driven per run, and — the part that matters — makes the window a PROJECTION
 * of the run log rather than a second place holding the answer. Which runs are visible is a replayable
 * fact; this class only reads it and moves the window to match. A promote written by any other writer
 * therefore moves this window too, with no message passing at all.
 */

/** The window, narrowed to what a presentation transition needs. */
export interface PresentationWindow {
  isDestroyed(): boolean;
  setOpacity(value: number): void;
  setIgnoreMouseEvents(value: boolean): void;
  setSkipTaskbar(value: boolean): void;
  /** Maps the window WITHOUT taking foreground — the hidden state, and the boot state. */
  showInactive(): void;
  show(): void;
  focus(): void;
}

/** The run projection, narrowed the same way. */
export interface PresentationRuns {
  list(): RunSummary[];
  tabsOf(runId: string): string[];
  setVisibility(runId: string, next: 'visible' | 'hidden', by: PresentationBy, surface?: PromoteSurface): Promise<boolean>;
  onChange(cb: () => void): void;
}

export interface PresentationDeps {
  runs: PresentationRuns;
  window: PresentationWindow;
  /** Brings a tab to the front of the stage once its run is being watched. */
  focusTab(tabId: string): void;
  /** `resolveHiddenMode`'s answer — the BOOT default only, never the per-run state. */
  bootHidden: boolean;
}

export class WindowGoneError extends Error {
  constructor() {
    super('the studio window is no longer available');
    this.name = 'WindowGoneError';
  }
}

export class RunPresentationController {
  /** What was last applied, so a projection change that does not move the window costs nothing. */
  private applied: 'visible' | 'hidden' | undefined;

  constructor(private readonly deps: PresentationDeps) {
    this.deps.runs.onChange(() => this.apply());
  }

  /** True while any run is being watched, or the human launched the app with a window. */
  private wanted(): 'visible' | 'hidden' {
    if (!this.deps.bootHidden) return 'visible';
    return this.deps.runs.list().some((r) => r.visibility === 'visible') ? 'visible' : 'hidden';
  }

  /**
   * Move the window to match the projection. Safe to call at any time and from any number of places —
   * it is a pure function of the run log plus the boot default.
   */
  apply(): void {
    const want = this.wanted();
    if (want === this.applied) return;
    const win = this.deps.window;
    if (win.isDestroyed()) return;
    if (want === 'visible') {
      win.setOpacity(1);
      win.setIgnoreMouseEvents(false);
      win.setSkipTaskbar(false);
      win.show();
      win.focus();
    } else {
      const p = hiddenWindowPresentation();
      win.setOpacity(p.opacity);
      win.setIgnoreMouseEvents(p.ignoreMouseEvents);
      win.setSkipTaskbar(p.skipTaskbar);
      // Mapped and withheld — NEVER minimised or unmapped. A window with no compositor surface has no
      // frame clock, so its tabs stop painting and the run silently degrades (see hidden-mode.ts).
      win.showInactive();
    }
    this.applied = want;
  }

  async promote(runId: string, by: PresentationBy, surface: PromoteSurface): Promise<void> {
    if (this.deps.window.isDestroyed()) throw new WindowGoneError();
    await this.deps.runs.setVisibility(runId, 'visible', by, surface);
    this.apply();
    const [first] = this.deps.runs.tabsOf(runId);
    if (first !== undefined) this.deps.focusTab(first);
  }

  async demote(runId: string, by: PresentationBy): Promise<void> {
    if (this.deps.window.isDestroyed()) throw new WindowGoneError();
    await this.deps.runs.setVisibility(runId, 'hidden', by);
    this.apply();
  }

  /**
   * Boot: every run starts hidden (A-43-2). Presentation is per-app-lifetime, and the run log outlives
   * the app — so a run that was being watched when the app last quit is written back to hidden rather
   * than silently contradicted by a window that is not there. The correction is itself an event, so the
   * log stays the only account of what the human could see.
   */
  async reconcile(): Promise<void> {
    for (const run of this.deps.runs.list()) {
      if (run.visibility !== 'visible') continue;
      await this.deps.runs.setVisibility(run.id, 'hidden', 'system');
    }
    this.apply();
  }

  /** The runs a visibility surface offers: everything live, plus anything still being watched. */
  static listable(runs: readonly RunSummary[]): RunSummary[] {
    return runs.filter((r) => !isTerminal(r.status) || r.visibility === 'visible');
  }
}
