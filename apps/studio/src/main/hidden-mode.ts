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
