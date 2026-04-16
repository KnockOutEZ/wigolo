import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Summary } from '../../../../src/cli/tui/components/Summary.js';

afterEach(() => {
  cleanup();
});

const defaultProps = {
  agentResults: [
    { id: 'claude-code', displayName: 'Claude Code', ok: true },
    { id: 'cursor', displayName: 'Cursor', ok: true },
  ],
  skillResults: [
    { id: 'cursor', status: 'installed', name: 'Cursor', detail: '.cursor/rules/wigolo.md' },
  ],
  installItems: [
    { id: 'searxng', name: 'SearXNG', status: 'done' as const, timeMs: 3200 },
    { id: 'playwright', name: 'Chromium', status: 'done' as const, timeMs: 1100 },
  ],
  verifyItems: [
    { id: 'searxng', name: 'SearXNG', status: 'pass' as const, detail: 'http://localhost:8888' },
    { id: 'test-search', name: 'Test search', status: 'pass' as const, detail: '26 results' },
  ],
};

describe('Summary', () => {
  it('shows setup complete message', () => {
    const { lastFrame } = render(<Summary {...defaultProps} />);
    expect(lastFrame()).toContain('Setup complete');
  });

  it('shows what was installed', () => {
    const { lastFrame } = render(<Summary {...defaultProps} />);
    const frame = lastFrame()!;
    expect(frame).toContain('SearXNG');
    expect(frame).toContain('Chromium');
  });

  it('shows MCP configured agents', () => {
    const { lastFrame } = render(<Summary {...defaultProps} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('Cursor');
    expect(frame).toContain('MCP configured');
  });

  it('shows skills installed', () => {
    const { lastFrame } = render(<Summary {...defaultProps} />);
    expect(lastFrame()).toContain('.cursor/rules/wigolo.md');
  });

  it('shows try it now suggestion', () => {
    const { lastFrame } = render(<Summary {...defaultProps} />);
    expect(lastFrame()).toContain('Search for Next.js');
  });

  it('shows available commands', () => {
    const { lastFrame } = render(<Summary {...defaultProps} />);
    const frame = lastFrame()!;
    expect(frame).toContain('wigolo doctor');
    expect(frame).toContain('wigolo shell');
  });

  it('shows docs link', () => {
    const { lastFrame } = render(<Summary {...defaultProps} />);
    expect(lastFrame()).toContain('github.com/KnockOutEZ/wigolo');
  });
});
