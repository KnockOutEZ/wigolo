import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Verification } from '../../../../src/cli/tui/components/Verification.js';

vi.mock('../../../../src/cli/tui/hooks/useVerify.js', () => ({
  useVerify: () => ({
    items: [
      { id: 'searxng', name: 'SearXNG', status: 'pass', detail: 'http://localhost:8888' },
      { id: 'flashrank', name: 'FlashRank', status: 'pass', detail: 'installed' },
      { id: 'trafilatura', name: 'Trafilatura', status: 'pass', detail: 'installed' },
      { id: 'embeddings', name: 'Embeddings', status: 'pass', detail: '384-dim' },
    ],
    done: false,
    result: null,
  }),
}));

afterEach(() => {
  cleanup();
});

describe('Verification', () => {
  it('renders the header', () => {
    const { lastFrame } = render(
      <Verification dataDir="/tmp/test" onComplete={() => {}} />,
    );
    expect(lastFrame()).toContain('Verifying setup');
  });

  it('shows all verification items', () => {
    const { lastFrame } = render(
      <Verification dataDir="/tmp/test" onComplete={() => {}} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('SearXNG');
    expect(frame).toContain('FlashRank');
    expect(frame).toContain('Trafilatura');
    expect(frame).toContain('Embeddings');
  });

  it('shows pass details', () => {
    const { lastFrame } = render(
      <Verification dataDir="/tmp/test" onComplete={() => {}} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('384-dim');
  });
});
