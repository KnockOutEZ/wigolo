import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';
import { App, DEFAULT_ROUTES } from '../../../../../src/cli/tui/shell/App.js';
import { useFooterHints } from '../../../../../src/cli/tui/shell/Footer.js';

beforeEach(() => {
  process.env.WIGOLO_TUI_REDUCED_MOTION = '1';
});

afterEach(() => {
  cleanup();
  delete process.env.WIGOLO_TUI_REDUCED_MOTION;
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultProps = {
  activeRoute: 'browser',
  dirtyByCategory: {},
  status: 'ok' as const,
  pending: 0,
  toast: null,
  focusedPane: 'sidebar' as const,
  paneTitle: 'Browser',
  onSelectRoute: () => {},
};

describe('App', () => {
  it('renders header with wigolo title', async () => {
    const { lastFrame } = render(
      <App {...defaultProps}>
        <Text>content</Text>
      </App>,
    );
    await wait(20);
    expect(lastFrame()).toContain('wigolo');
  });

  it('renders all 11 sidebar rows (6 settings + 5 actions)', async () => {
    const { lastFrame } = render(
      <App {...defaultProps}>
        <Text>content</Text>
      </App>,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Browser');
    expect(frame).toContain('Search engine');
    expect(frame).toContain('LLM provider');
    expect(frame).toContain('Agents');
    expect(frame).toContain('Cache');
    expect(frame).toContain('Advanced');
    expect(frame).toContain('Verify');
    expect(frame).toContain('Doctor');
    expect(frame).toContain('Export');
    expect(frame).toContain('Import');
    expect(frame).toContain('Uninstall');
  });

  it('renders MainPane with rounded border', async () => {
    const { lastFrame } = render(
      <App {...defaultProps}>
        <Text>pane body</Text>
      </App>,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/[╭╮╰╯│─]/);
  });

  it('renders paneTitle inside main pane', async () => {
    const { lastFrame } = render(
      <App {...defaultProps} paneTitle="Advanced Settings">
        <Text>x</Text>
      </App>,
    );
    await wait(20);
    expect(lastFrame()).toContain('Advanced Settings');
  });

  it('renders Footer hint row when useFooterHints is used inside App', async () => {
    function InnerScreen() {
      useFooterHints(['↑↓ nav', 'q quit']);
      return <Text>screen</Text>;
    }

    const { lastFrame } = render(
      <App {...defaultProps}>
        <InnerScreen />
      </App>,
    );
    await wait(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑↓ nav');
    expect(frame).toContain('q quit');
  });

  it('shows pending count badge when pending > 0', async () => {
    const { lastFrame } = render(
      <App {...defaultProps} pending={3}>
        <Text>x</Text>
      </App>,
    );
    await wait(20);
    expect(lastFrame()).toContain('3 pending');
  });

  it('DEFAULT_ROUTES has 6 settings and 5 actions', () => {
    const settings = DEFAULT_ROUTES.filter(r => r.group === 'settings');
    const actions = DEFAULT_ROUTES.filter(r => r.group === 'actions');
    expect(settings).toHaveLength(6);
    expect(actions).toHaveLength(5);
  });

  it('renders children in main pane', async () => {
    const { lastFrame } = render(
      <App {...defaultProps}>
        <Text>unique-child-text-123</Text>
      </App>,
    );
    await wait(20);
    expect(lastFrame()).toContain('unique-child-text-123');
  });
});
