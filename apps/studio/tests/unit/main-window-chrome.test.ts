import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The main process's two copies of things defined somewhere else: the window's own ground (defined in
 * the token layer) and the chrome geometry it insets the page view by (defined in the stylesheet).
 *
 * Both are asserted by READING THE SOURCE, which needs saying out loud. `src/main/index.ts` is an
 * Electron entry point: importing it constructs a BrowserWindow, so a unit test cannot call into it.
 * The precedent is `hidden-mode.test.ts`, which asserts the hidden-window branch at its call site for
 * exactly the same reason — the regression it guards lived in the call, not in the function.
 *
 * Everything here was invisible to every gate. Restoring the literal `backgroundColor: '#0c0c10'` that
 * the restyle deleted passed the whole suite; so did deleting the nativeTheme listener, and so did
 * changing one side of a geometry pair.
 */

const STUDIO = join(import.meta.dirname, '../..');
const MAIN = readFileSync(join(STUDIO, 'src/main/index.ts'), 'utf8');
const STUDIO_CSS = readFileSync(join(STUDIO, 'src/renderer/studio.css'), 'utf8');

/**
 * Extraction that FAILS rather than returns nothing. A source-read assertion whose regex stops
 * matching is the worst kind of green: it agrees with whatever the file says, including nothing.
 */
function once(source: string, label: string, pattern: RegExp): string {
  const found = pattern.exec(source);
  expect(found, `${label}: ${pattern} matched nothing — the source moved, the claim did not`).not.toBeNull();
  return found![1];
}

const px = (source: string, label: string, pattern: RegExp): number => Number(once(source, label, pattern));

describe('the window frame paints from the token layer', () => {
  it('resolves its ground through the token layer rather than holding a copy of it', () => {
    // The OS paints this colour before the renderer has a frame, and it shows behind the stage while
    // the page view is between pages. A literal here is right in one register and wrong in the other,
    // and the wrong one is only visible to a developer who switched appearance mid-session.
    const constructor = MAIN.slice(MAIN.indexOf('new BrowserWindow({'), MAIN.indexOf('webPreferences: chromeWebPreferences'));
    expect(constructor).toContain("backgroundColor: tokenValue('--bg', windowRegister())");
    expect(constructor).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/);
  });

  it('reads the register off the system appearance, so the frame and the renderer agree', () => {
    // The renderer follows `prefers-color-scheme`; `nativeTheme.shouldUseDarkColors` is the same
    // question asked from the main process. Two different sources here would put a light frame around
    // a dark app on whichever platform they disagree on.
    const fn = MAIN.slice(MAIN.indexOf('function windowRegister('), MAIN.indexOf('async function createWindow'));
    expect(fn).toMatch(/nativeTheme\.shouldUseDarkColors\s*\?\s*'dark'\s*:\s*'light'/);
  });

  it('repaints the frame when the system appearance changes', () => {
    // Without this the window keeps its old ground until the next navigation, so a register switch
    // leaves a band of the other register showing around the stage — the seam the pre-switch build had.
    expect(MAIN).toContain("nativeTheme.on('updated', onNativeThemeUpdated)");
    const handler = MAIN.slice(MAIN.indexOf('const onNativeThemeUpdated'), MAIN.indexOf("nativeTheme.on('updated'"));
    expect(handler).toContain("win.setBackgroundColor(tokenValue('--bg', windowRegister()))");
    // Guarded, because `nativeTheme` outlives the window and fires on a destroyed one.
    expect(handler).toContain('win.isDestroyed()');
  });

  it('removes that listener when the window closes, since nativeTheme outlives every window', () => {
    // `nativeTheme` is process-global. An un-removed listener leaks one closure per window opened and
    // keeps a destroyed window reachable — and the leak grows with ordinary use, not with an edge case.
    const teardown = once(MAIN, 'closed handler', /win\.on\('closed',\s*\(\)\s*=>\s*([^)]*\)[^)]*)\)/);
    expect(teardown).toContain("nativeTheme.off('updated', onNativeThemeUpdated)");
  });
});

describe('the chrome geometry the main process insets the page view by', () => {
  // The main process sizes the WebContentsView; the stylesheet sizes the chrome drawn above and beside
  // it. They are the same numbers held in two files, and nothing compared them — a single-side edit
  // leaves a strip of page under the toolbar or a strip of nothing beside the rail. This diff's own
  // `--banner-h` was added to the mirror with no check that it matched.
  const titlebar = px(MAIN, 'CHROME_HEIGHT comment', /CHROME_HEIGHT\s*=\s*\d+;\s*\/\/\s*titlebar\s*\((\d+)\)/);
  const toolbar = px(MAIN, 'CHROME_HEIGHT comment', /CHROME_HEIGHT\s*=\s*\d+;\s*\/\/[^\n]*toolbar\s*\((\d+)\)/);
  const chromeHeight = px(MAIN, 'CHROME_HEIGHT', /CHROME_HEIGHT\s*=\s*(\d+)/);
  const railWidth = px(MAIN, 'RAIL_WIDTH', /RAIL_WIDTH\s*=\s*(\d+)/);
  const bannerHeight = px(MAIN, 'BANNER_H', /BANNER_H\s*=\s*(\d+)/);
  const cssPx = (token: string): number => px(STUDIO_CSS, token, new RegExp(`${token}:\\s*(\\d+)px`));

  it('mirrors the titlebar and toolbar bands the stylesheet declares', () => {
    // Asserted per band, not only as a sum: two compensating edits (40/48 → 44/44) keep CHROME_HEIGHT
    // right while moving the tab strip, and the traffic lights are inline in that titlebar.
    expect(titlebar).toBe(cssPx('--titlebar-h'));
    expect(toolbar).toBe(cssPx('--toolbar-h'));
  });

  it('insets the page view by exactly the height of the chrome above it', () => {
    expect(chromeHeight).toBe(cssPx('--titlebar-h') + cssPx('--toolbar-h'));
  });

  it('mirrors the rail width, which is the column the page view must not be drawn under', () => {
    expect(railWidth).toBe(cssPx('--rail-w'));
  });

  it('mirrors the drive banner height, which insets the page view again while it is shown', () => {
    expect(bannerHeight).toBe(cssPx('--banner-h'));
  });

  it('reads real numbers off both sides, or these pins agree with nothing', () => {
    // The control. Every assertion above is an equality between two extractions; if either extraction
    // silently produced a NaN they would still be comparable and the pins would mean nothing.
    for (const value of [titlebar, toolbar, chromeHeight, railWidth, bannerHeight]) {
      expect(value).toBeGreaterThan(0);
    }
    for (const token of ['--titlebar-h', '--toolbar-h', '--rail-w', '--banner-h']) {
      expect(cssPx(token)).toBeGreaterThan(0);
    }
    // …and the extraction really is anchored to the name, not to the first number in the file.
    expect(() => cssPx('--not-a-geometry-token')).toThrow();
  });
});

/**
 * The headless-default wiring, asserted the same way and for the same reason: `src/main/index.ts`
 * constructs a BrowserWindow on import, so no unit test can call into it, and everything below was
 * invisible to every gate. Each of these was deleted or reordered in a scratch build and the whole
 * suite stayed green.
 */
describe('the app boots headless and can be promoted out of it', () => {
  it('applies the presentation from the run projection rather than from a boot-time branch', () => {
    // The regression this replaces: `if (hidden) {…} else {…}` ran once and no runtime transition
    // existed anywhere, so a promote had nothing to move.
    expect(MAIN).toContain('presentation.apply()');
    expect(MAIN).not.toMatch(/if \(hidden\) \{\s*const p = hiddenWindowPresentation\(\)/);
  });

  it('gives the controller the boot default and a way to focus the promoted run’s tab', () => {
    const ctor = MAIN.slice(MAIN.indexOf('new RunPresentationController({'), MAIN.indexOf('void runs.hydrate()'));
    expect(ctor).toContain('bootHidden: hidden');
    expect(ctor).toContain('focusTab: (tabId) => tabs.focusTab(tabId)');
  });

  it('reconciles the log back to hidden once the replay lands, not before it', () => {
    // Order matters: reconciling before hydrate would find an empty projection and write nothing, so
    // a run left visible by the last session would keep claiming a window nobody can see.
    const hydrate = MAIN.indexOf('void runs.hydrate()');
    const reconcile = MAIN.indexOf('presentation.reconcile()');
    expect(hydrate).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(hydrate);
    expect(MAIN.slice(hydrate, reconcile)).toContain('.then(');
  });

  it('mounts the menu-bar item, and survives a system that will not give it one', () => {
    expect(MAIN).toContain('mountRunTray(runs, presentation)');
    const fn = MAIN.slice(MAIN.indexOf('function mountRunTray'), MAIN.indexOf('async function createWindow'));
    expect(fn).toContain('setTemplateImage(true)'); // one asset, tinted by the OS, both registers
    expect(fn).toMatch(/catch \(err\)/); // a status area that refuses an item must not stop the boot
    expect(fn).toContain('return null;');
  });

  it('lets go of the menu-bar item on shutdown', () => {
    // A Tray that outlives the app leaves a dead icon in the menu bar until the OS reaps it.
    expect(MAIN.slice(MAIN.indexOf('const shutdown ='), MAIN.indexOf("app.on('before-quit'"))).toContain('runTray?.destroy()');
  });
});
