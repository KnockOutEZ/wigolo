/**
 * Screen-transition dim test for MainPane.
 *
 * When routeId changes, MainPane enters a 1-frame (~16ms) dimming phase
 * where outgoing content is rendered with dim color, then mounts the new
 * content at normal brightness.
 *
 * With reducedMotion=true, the dim phase is skipped entirely.
 */
import React, { useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete process.env.WIGOLO_TUI_REDUCED_MOTION;
  delete process.env.CI;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
});

describe('MainPane screen-transition dim', () => {
  it('renders children normally when routeId does not change', async () => {
    delete process.env.WIGOLO_TUI_REDUCED_MOTION;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    const { MainPane } = await import('../../../../../src/cli/tui/shell/MainPane.js');
    const { lastFrame } = render(
      <MainPane title="Browser" focused={true} routeId="browser">
        <Text>stable content</Text>
      </MainPane>,
    );
    expect(lastFrame()).toContain('stable content');
  });

  it('shows new content after routeId changes and dim phase completes', async () => {
    delete process.env.WIGOLO_TUI_REDUCED_MOTION;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    vi.useFakeTimers();
    const { MainPane } = await import('../../../../../src/cli/tui/shell/MainPane.js');

    function TestHarness() {
      const [route, setRoute] = useState('browser');
      return (
        <>
          <MainPane title="Test" focused={true} routeId={route}>
            <Text>{route === 'browser' ? 'old content' : 'new content'}</Text>
          </MainPane>
          <Text onPress={() => setRoute('search')} />
        </>
      );
    }

    // Use rerender instead to avoid the onPress approach
    const { lastFrame, rerender } = render(
      <MainPane title="Test" focused={true} routeId="browser">
        <Text>old content</Text>
      </MainPane>,
    );

    expect(lastFrame()).toContain('old content');

    // Change routeId — triggers dim phase
    rerender(
      <MainPane title="Test" focused={true} routeId="search">
        <Text>new content</Text>
      </MainPane>,
    );

    // After the dim phase (≥16ms), new content should appear
    vi.advanceTimersByTime(20);
    expect(lastFrame()).toContain('new content');
  });

  it('skips dim phase when WIGOLO_TUI_REDUCED_MOTION=1', async () => {
    process.env.WIGOLO_TUI_REDUCED_MOTION = '1';

    vi.useFakeTimers();
    const { MainPane } = await import('../../../../../src/cli/tui/shell/MainPane.js');

    const { lastFrame, rerender } = render(
      <MainPane title="Test" focused={true} routeId="browser">
        <Text>old content</Text>
      </MainPane>,
    );

    rerender(
      <MainPane title="Test" focused={true} routeId="search">
        <Text>new content</Text>
      </MainPane>,
    );

    // Immediately shows new content without needing timer advance (no dim phase)
    expect(lastFrame()).toContain('new content');
  });
});
