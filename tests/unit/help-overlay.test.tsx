import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { HelpOverlay } from '../../src/cli/tui/shell/HelpOverlay.js';

afterEach(() => {
  cleanup();
});

describe('HelpOverlay', () => {
  it('does not list the unimplemented ⌃z binding', () => {
    const { lastFrame } = render(<HelpOverlay onClose={() => {}} />);
    expect(lastFrame()).not.toContain('⌃z');
    expect(lastFrame()).not.toContain('Ctrl+Z');
    expect(lastFrame()).not.toContain('Undo');
  });

  it('renders documented keybindings', () => {
    const { lastFrame } = render(<HelpOverlay onClose={() => {}} />);
    const frame = lastFrame();
    expect(frame).toContain('⌃k');
    expect(frame).toContain('Keyboard Shortcuts');
  });
});
