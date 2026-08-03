/**
 * `--hidden` mode (S9 spec §4 item 2, §9 step 3).
 *
 * A hidden window is a window that is never shown: it keeps a real GPU surface, a real compositor
 * and a real renderer string, and it is NOT Electron's offscreen-rendering mode. That distinction is
 * the whole point — GT#4 records that offscreen rendering falls back to software GL and leaks a
 * detectable renderer, which would forfeit the legitimacy the hidden lane exists to preserve.
 *
 * Nothing here spoofs anything. It decides whether a window is shown, and it declines two
 * optimisations (offscreen rendering, background throttling) that would otherwise change what the
 * browser presents or how it behaves while unattended.
 */

export interface HiddenModeInput {
  readonly argv: readonly string[];
  readonly env: { readonly WIGOLO_STUDIO_HIDDEN?: string | undefined };
}

/**
 * Two channels, because the CLI needs the env one: `runStudio()` launches the app through
 * `npm run dev -w apps/studio`, and argv does not survive that wrapper chain.
 *
 * `--no-hidden` wins over everything. A contradiction resolves toward the visible window, which is
 * the state a human can see and act on — the recoverable direction.
 */
export function resolveHiddenMode(input: HiddenModeInput): boolean {
  if (input.argv.includes('--no-hidden')) return false;
  if (input.argv.includes('--hidden')) return true;

  const raw = input.env.WIGOLO_STUDIO_HIDDEN;
  // Empty is unset, NOT enabled. `VAR=` is a real accidental shape in shells and launchd plists,
  // and the failure it would cause here (no window, no explanation) is the least debuggable one.
  if (raw === undefined || raw === '') return false;
  const v = raw.toLowerCase();
  return v !== 'false' && v !== '0';
}

export interface TabPreferences {
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: true;
  readonly backgroundThrottling: false;
  readonly offscreen: false;
}

/**
 * Preferences for the WebContentsView that holds the page.
 *
 * `backgroundThrottling: false` is unconditional, not hidden-mode-only, for two reasons: a driven
 * tab that is merely occluded (rail open, another tab active) must keep real timer and rAF cadence
 * or drives break; and the parity gate compares hidden against visible on the same build, so a
 * throttling difference between the arms would mean the axis measured our config rather than the
 * window state.
 */
export function tabWebPreferences(): TabPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
    // Explicit, not omitted: this is the GT#4 guard, and a reader editing this object needs to see
    // that the value is a decision rather than a default.
    offscreen: false,
  };
}

export interface HiddenPresentation {
  /** Fully transparent: mapped and composited, but nothing reaches the screen. */
  readonly opacity: 0;
  /** A transparent window must never swallow a click meant for whatever is behind it. */
  readonly ignoreMouseEvents: true;
  /** No dock/taskbar entry for a window the human did not ask to see. */
  readonly skipTaskbar: true;
}

/**
 * How a hidden window is presented — and it is NOT "never shown", which is what this originally did.
 *
 * MEASURED, and it corrects the phase-1 parity reading. That reading loaded its probe into the
 * BrowserWindow's OWN webContents and found `visibilityState: 'visible'` with rAF at ~110fps while
 * hidden. Production does not host pages there: it hosts them in a `WebContentsView` child. On that
 * shape a never-shown window reports `visibilityState: 'hidden'` and **rAF stops completely — 0
 * frames per second** — and `backgroundThrottling: false` does not help, because the problem is not
 * throttling. A window that was never mapped never acquires a compositor surface, so there is no
 * frame clock for its child view to be driven by. `view.setVisible(true)` does not help either, and
 * neither does minimising (which is where the `cdp-direct` minimized-real-Chrome prior stops
 * applying to Electron: measured, a minimised Electron window behaves like a never-shown one).
 *
 * That was not merely a fingerprint delta. `document.visibilityState` is one line of JavaScript away
 * from any page, so hidden and visible were trivially distinguishable — but far worse, a driven tab
 * with no frame clock never paints, so every page that gates rendering or lazy-loading on
 * `requestAnimationFrame` would return an empty shell to the agent. The mode would have been broken
 * for the background work it exists to serve.
 *
 * The fix maps the window and then withholds it: transparent, click-through, and shown WITHOUT focus
 * so it never steals foreground from the human. The browser is then genuinely in the state it reports —
 * nothing here claims to be anything it is not, which is the §4 rule this has to satisfy. Timers were
 * never affected (interval cadence measured at ~1.00 in every arm); it is the frame clock alone that
 * needed a real surface.
 *
 * IT DELIBERATELY DOES NOT MOVE THE WINDOW OFF-SCREEN, and that is a correction rather than an
 * omission. Parking it far off any display works on macOS but **breaks the frame clock on X11**: a
 * window positioned entirely outside the screen is never viewable there, so it gets no frames — the
 * exact starvation this function exists to prevent, reintroduced by the belt-and-braces. Measured in
 * CI: `hidden=0 visible=60.99` with the offscreen move, on the build where macOS reported ~110 in both
 * arms. Transparency alone was measured sufficient on macOS (109.9 fps), so it is the whole mechanism.
 *
 * **Recorded ceiling:** X11 honours per-window opacity only under a compositing window manager. On a
 * bare X11 session with no compositor, a hidden window may therefore be VISIBLE. Every mainstream
 * Linux desktop composites, and the alternative — moving it off-screen — is measurably worse because it
 * starves the tab of frames and so breaks the mode outright. Stated rather than papered over.
 */
export function hiddenWindowPresentation(): HiddenPresentation {
  return {
    opacity: 0,
    ignoreMouseEvents: true,
    skipTaskbar: true,
  };
}

export interface ChromePreferences {
  readonly preload: string;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: false;
  readonly backgroundThrottling: false;
  readonly offscreen: false;
}

/**
 * Preferences for the app shell. The shell hosts the approval and chat IPC, so it must not throttle
 * while hidden — otherwise the agent line appears to hang whenever no human is looking at it.
 */
export function chromeWebPreferences(preload: string): ChromePreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    backgroundThrottling: false,
    offscreen: false,
  };
}
