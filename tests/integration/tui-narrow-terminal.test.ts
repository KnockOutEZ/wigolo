/**
 * Integration test: narrow layout hides Sidebar and shows breadcrumb.
 *
 * useShellWidth() mocked to return 'narrow' (does not exercise classifyWidth threshold).
 * When width is 'narrow':
 *  - Sidebar group labels (SETTINGS / ACTIONS) must NOT appear.
 *  - The Header breadcrumb text must appear in place of the gradient title.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

// Mock useShellWidth so we control the width without needing a real TTY resize.
vi.mock('../../src/cli/tui/shell/width.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/cli/tui/shell/width.js')>();
  return {
    ...original,
    useShellWidth: vi.fn(() => 'narrow' as const),
  };
});

import { InkRoot } from '../../src/cli/tui/router/ink.js';
import { createSettingsStore } from '../../src/cli/tui/state/settings-store.js';
import { CATALOG } from '../../src/cli/tui/schema/catalog.js';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function makeStore() {
  return createSettingsStore({
    browserTypes: 'chromium',
    maxBrowsers: 3,
    browserIdleTimeoutMs: 30000,
  });
}

beforeEach(() => {
  process.env.WIGOLO_TUI_REDUCED_MOTION = '1';
});

afterEach(() => {
  cleanup();
  delete process.env.WIGOLO_TUI_REDUCED_MOTION;
});

describe('narrow terminal (80 cols)', () => {
  it('hides Sidebar and shows breadcrumb when width is narrow', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      React.createElement(InkRoot, { store, catalog: CATALOG }),
    );

    await wait(60);
    const frame = lastFrame() ?? '';

    // Sidebar group labels must be absent in narrow mode
    expect(frame).not.toContain('SETTINGS');
    expect(frame).not.toContain('ACTIONS');

    // Breadcrumb (home view = 'Home') must appear in header instead of gradient title
    expect(frame).toContain('Home');
  });
});
