import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Summary } from '../../../../src/cli/tui/components/Summary.js';

afterEach(() => {
  cleanup();
});

describe('Summary', () => {
  it('shows setup complete message', () => {
    const { lastFrame } = render(<Summary />);
    expect(lastFrame()).toContain('Setup complete');
  });

  it('shows try it now suggestion', () => {
    const { lastFrame } = render(<Summary />);
    expect(lastFrame()).toContain('Search for Next.js');
  });

  it('shows available commands', () => {
    const { lastFrame } = render(<Summary />);
    const frame = lastFrame()!;
    expect(frame).toContain('wigolo doctor');
    expect(frame).toContain('wigolo shell');
    expect(frame).toContain('wigolo status');
    expect(frame).toContain('wigolo init');
  });

  it('shows docs link', () => {
    const { lastFrame } = render(<Summary />);
    expect(lastFrame()).toContain('github.com/KnockOutEZ/wigolo');
  });
});
