import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHiddenMode, tabWebPreferences, chromeWebPreferences, hiddenWindowPresentation } from '../../src/main/hidden-mode';

describe('resolveHiddenMode', () => {
  it('defaults to visible: a browser the human opened must appear', () => {
    expect(resolveHiddenMode({ argv: ['electron', 'main.js'], env: {} })).toBe(false);
  });

  it('honours --hidden on the command line', () => {
    expect(resolveHiddenMode({ argv: ['electron', 'main.js', '--hidden'], env: {} })).toBe(true);
  });

  it('honours WIGOLO_STUDIO_HIDDEN, because the CLI launches through `npm run` which eats argv', () => {
    // runStudio() spawns `npm run dev -w apps/studio`; argv does not survive that wrapper chain, so
    // the env channel is the one that actually works for a programmatic background launch. If this
    // test is deleted, --hidden silently stops working from the CLI while still passing argv tests.
    expect(resolveHiddenMode({ argv: ['electron', 'main.js'], env: { WIGOLO_STUDIO_HIDDEN: '1' } })).toBe(true);
  });

  it('treats an empty env value as unset, not as enabled', () => {
    // `WIGOLO_STUDIO_HIDDEN=` in a shell or a launchd plist is the accidental case. Silently hiding
    // the window because a variable exists-but-is-blank is the worst possible failure: the user sees
    // no browser and has nothing to look at to explain why.
    expect(resolveHiddenMode({ argv: [], env: { WIGOLO_STUDIO_HIDDEN: '' } })).toBe(false);
  });

  it.each(['0', 'false', 'FALSE'])('treats %s as disabled', (v) => {
    expect(resolveHiddenMode({ argv: [], env: { WIGOLO_STUDIO_HIDDEN: v } })).toBe(false);
  });

  it.each(['1', 'true', 'yes', 'on'])('treats %s as enabled', (v) => {
    expect(resolveHiddenMode({ argv: [], env: { WIGOLO_STUDIO_HIDDEN: v } })).toBe(true);
  });

  it('lets an explicit --no-hidden override the env, so a stuck variable is recoverable', () => {
    expect(
      resolveHiddenMode({ argv: ['electron', 'main.js', '--no-hidden'], env: { WIGOLO_STUDIO_HIDDEN: '1' } }),
    ).toBe(false);
  });

  it('--no-hidden beats --hidden regardless of order — the safe direction wins a contradiction', () => {
    expect(resolveHiddenMode({ argv: ['--hidden', '--no-hidden'], env: {} })).toBe(false);
    expect(resolveHiddenMode({ argv: ['--no-hidden', '--hidden'], env: {} })).toBe(false);
  });

  it('does not match a flag that merely contains "hidden"', () => {
    // Guards against a substring match picking up unrelated switches (Electron and Chromium both
    // ship several, e.g. --enable-features=SomethingHidden).
    expect(resolveHiddenMode({ argv: ['--enable-features=WindowHidden'], env: {} })).toBe(false);
    expect(resolveHiddenMode({ argv: ['--hidden-inset'], env: {} })).toBe(false);
  });
});

describe('tabWebPreferences — the preferences of the tab that actually holds the page', () => {
  it('never enables offscreen rendering', () => {
    // GT#4 trap record: Electron's offscreen-rendering mode falls back to software GL and leaks a
    // detectable renderer string. A hidden window is NOT the same thing as an offscreen window, and
    // the measured WebGL renderer (real Metal/M3 Pro) is what makes the hidden lane legitimate.
    // This test is the regression guard on that distinction.
    expect(tabWebPreferences()).not.toHaveProperty('offscreen', true);
    expect(tabWebPreferences().offscreen).toBe(false);
  });

  it('disables background throttling unconditionally', () => {
    // A driven tab must keep real timer and rAF cadence whether or not its window is on screen:
    // throttled timers break drives, and — for the parity gate — a throttling difference between the
    // hidden and visible arms would mean the axis measured our own config instead of the window state.
    expect(tabWebPreferences().backgroundThrottling).toBe(false);
  });

  it('keeps the tab sandboxed with no node integration', () => {
    // The tab renders untrusted web content. These are load-bearing and must not drift while
    // someone is editing neighbouring fields.
    const p = tabWebPreferences();
    expect(p.sandbox).toBe(true);
    expect(p.contextIsolation).toBe(true);
    expect(p.nodeIntegration).toBe(false);
  });
});

describe('chromeWebPreferences — the app shell', () => {
  it('disables background throttling so a hidden shell keeps servicing the agent line', () => {
    // The shell hosts the approval/chat IPC. If it throttles while hidden, approvals and drive
    // events queue behind a throttled timer — the hidden lane would appear to hang.
    expect(chromeWebPreferences('/preload.cjs').backgroundThrottling).toBe(false);
  });

  it('never enables offscreen rendering either', () => {
    expect(chromeWebPreferences('/preload.cjs').offscreen).toBe(false);
  });

  it('carries the preload path it was given', () => {
    expect(chromeWebPreferences('/x/preload.cjs').preload).toBe('/x/preload.cjs');
  });
});

describe('hiddenWindowPresentation — a hidden window must be MAPPED, not merely unshown', () => {
  // MEASURED, and it corrects the phase-1 parity reading, which probed the BrowserWindow's own
  // webContents rather than the WebContentsView child production actually hosts pages in. On the
  // production shape a never-shown window reports `visibilityState: 'hidden'` and its child view's
  // rAF stops completely (0fps) — while timers keep perfect cadence, so `backgroundThrottling: false`
  // was never the missing piece. Mapping the window restores both. Minimising does NOT, which is
  // where the minimized-real-Chrome prior stops transferring to Electron.
  it('is transparent rather than unshown, because that is what gives the window a compositor surface — and without one a driven tab has no frame clock, never paints, and returns an empty shell for every page that lazy-loads on requestAnimationFrame', () => {
    expect(hiddenWindowPresentation().opacity).toBe(0);
  });

  it('ignores mouse events: a fully transparent window that swallowed clicks meant for the app behind it would be a worse bug than the one this fixes', () => {
    expect(hiddenWindowPresentation().ignoreMouseEvents).toBe(true);
  });

  it('skips the taskbar, so a background run leaves no entry for a window the human never asked to see', () => {
    expect(hiddenWindowPresentation().skipTaskbar).toBe(true);
  });

  it('sits far off any display, not merely at negative coordinates — a second monitor puts real, visible desktop space at negative x/y, so (-100,-100) can be genuinely on screen', () => {
    const [x, y] = hiddenWindowPresentation().position;
    expect(x).toBeLessThan(-10000);
    expect(y).toBeLessThan(-10000);
  });

  it('is applied with showInactive, never show — asserted at the call site, because taking foreground away from the human mid-task is the one thing a background run must never do', () => {
    const src = readFileSync(join(import.meta.dirname, '../../src/main/index.ts'), 'utf-8');
    const hiddenBranch = src.slice(src.indexOf('hiddenWindowPresentation()'), src.indexOf('running hidden'));
    expect(hiddenBranch).toContain('win.showInactive()');
    expect(hiddenBranch).not.toMatch(/win\.show\(\)|win\.focus\(\)/);
  });
});
