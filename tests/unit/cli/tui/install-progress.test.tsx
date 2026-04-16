import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { InstallProgress } from '../../../../src/cli/tui/components/InstallProgress.js';

vi.mock('../../../../src/cli/tui/hooks/useInstall.js', () => ({
  useInstall: () => ({
    items: [
      { id: 'searxng', name: 'SearXNG', status: 'done', timeMs: 3200 },
      { id: 'playwright', name: 'Chromium', status: 'done', timeMs: 1100 },
      { id: 'trafilatura', name: 'Trafilatura', status: 'installing' },
      { id: 'flashrank', name: 'FlashRank', status: 'waiting' },
      { id: 'embeddings', name: 'Embeddings', status: 'waiting' },
      { id: 'lightpanda', name: 'Lightpanda', status: 'waiting' },
    ],
    done: false,
  }),
}));

afterEach(() => {
  cleanup();
});

describe('InstallProgress', () => {
  it('renders the header', () => {
    const { lastFrame } = render(
      <InstallProgress browser="lightpanda" onComplete={() => {}} />,
    );
    expect(lastFrame()).toContain('Installing dependencies');
  });

  it('shows completed items with checkmark and time', () => {
    const { lastFrame } = render(
      <InstallProgress browser="lightpanda" onComplete={() => {}} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('SearXNG');
    expect(frame).toContain('3.2s');
    expect(frame).toContain('Chromium');
  });

  it('shows installing items with spinner', () => {
    const { lastFrame } = render(
      <InstallProgress browser="lightpanda" onComplete={() => {}} />,
    );
    expect(lastFrame()).toContain('Trafilatura');
    expect(lastFrame()).toContain('installing');
  });

  it('shows waiting items', () => {
    const { lastFrame } = render(
      <InstallProgress browser="lightpanda" onComplete={() => {}} />,
    );
    expect(lastFrame()).toContain('FlashRank');
    expect(lastFrame()).toContain('waiting');
  });
});
