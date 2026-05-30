/**
 * Integration test: InkRoot composes the App shell (Header / Sidebar / Footer)
 * around whichever screen is active. This slice (SP6) verifies that the router
 * wires screens into the shell without breaking existing navigation.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { InkRoot } from '../../src/cli/tui/router/ink.js';
import { createSettingsStore } from '../../src/cli/tui/state/settings-store.js';
import { CATALOG } from '../../src/cli/tui/schema/catalog.js';

beforeEach(() => {
  // Disable gradient animation so tests get deterministic text output.
  process.env.WIGOLO_TUI_REDUCED_MOTION = '1';
});

afterEach(() => {
  cleanup();
  delete process.env.WIGOLO_TUI_REDUCED_MOTION;
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function makeStore() {
  return createSettingsStore({
    browserTypes: 'chromium',
    maxBrowsers: 3,
    browserIdleTimeoutMs: 30000,
  });
}

describe('shell wraps existing screens', () => {
  it('mounts Header + Sidebar + Footer around the active home screen', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      React.createElement(InkRoot, { store, catalog: CATALOG }),
    );
    await wait(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('wigolo');      // header title text
    expect(frame).toContain('SETTINGS');   // sidebar group label
    expect(frame).toContain('ACTIONS');    // sidebar group label
    expect(frame).toContain('Browser');    // sidebar category row
    expect(frame).toContain('↑↓');         // footer hint row (from SettingsHome)
  });

  it('sidebar onSelect wires to route navigation (Sidebar Enter → CategoryScreen)', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      React.createElement(InkRoot, { store, catalog: CATALOG }),
    );
    await wait(40);
    // Sidebar starts focused; Enter on first item (Browser) navigates to CategoryScreen.
    stdin.write('\r'); // Enter
    await wait(50);
    const frame = lastFrame() ?? '';
    // CategoryScreen for the first catalog entry (browser) renders its label.
    expect(frame).toContain('Browser');
    // The main pane title should reflect the active category.
    expect(frame).toContain('Engine');
  });

  it('Header.pending reflects store.dirtyKeys().length reactively', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      React.createElement(InkRoot, { store, catalog: CATALOG }),
    );
    await wait(40);
    expect(lastFrame() ?? '').not.toContain('pending');

    store.set('browserTypes', 'firefox');
    await wait(20);
    expect(lastFrame() ?? '').toContain('1 pending');

    store.set('maxBrowsers', 5);
    await wait(20);
    expect(lastFrame() ?? '').toContain('2 pending');

    store.discard();
    await wait(20);
    expect(lastFrame() ?? '').not.toContain('pending');
  });
});

describe('initialRoute prop', () => {
  it('initialRoute="llm" mounts the LLM category screen instead of home', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      React.createElement(InkRoot, { store, catalog: CATALOG, initialRoute: 'llm' }),
    );
    await wait(40);
    const frame = lastFrame() ?? '';
    // CategoryScreen for 'llm' renders the category label in the main pane.
    expect(frame).toContain('LLM');
    // Home screen uses "navigate" in its footer hint; CategoryScreen uses "field".
    // Asserting "navigate" absent confirms we are NOT on the home screen.
    expect(frame).not.toContain('navigate');
  });
});
