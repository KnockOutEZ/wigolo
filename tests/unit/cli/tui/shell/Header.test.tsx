import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Header } from '../../../../../src/cli/tui/shell/Header.js';

beforeEach(() => {
  process.env.WIGOLO_TUI_REDUCED_MOTION = '1';
});

afterEach(() => {
  cleanup();
  delete process.env.WIGOLO_TUI_REDUCED_MOTION;
});

describe('Header', () => {
  it('renders title text "wigolo"', () => {
    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={null} />,
    );
    expect(lastFrame()).toContain('wigolo');
  });

  it('shows green dot on status=ok', () => {
    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={null} />,
    );
    expect(lastFrame()).toContain('●');
  });

  it('shows yellow dot on status=warn', () => {
    const { lastFrame } = render(
      <Header status="warn" pending={0} toast={null} />,
    );
    expect(lastFrame()).toContain('●');
  });

  it('shows red dot on status=err', () => {
    const { lastFrame } = render(
      <Header status="err" pending={0} toast={null} />,
    );
    expect(lastFrame()).toContain('●');
  });

  it('shows pending badge when pending > 0', () => {
    const { lastFrame } = render(
      <Header status="ok" pending={2} toast={null} />,
    );
    expect(lastFrame()).toContain('2 pending');
  });

  it('hides pending badge when pending === 0', () => {
    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={null} />,
    );
    expect(lastFrame() ?? '').not.toContain('pending');
  });

  it('shows toast message when toast provided', () => {
    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={{ message: 'Saved!', severity: 'ok' }} />,
    );
    expect(lastFrame()).toContain('Saved!');
  });

  it('hides toast when toast is null', () => {
    const { lastFrame } = render(
      <Header status="ok" pending={0} toast={null} />,
    );
    expect(lastFrame() ?? '').not.toContain('Saved!');
  });
});
