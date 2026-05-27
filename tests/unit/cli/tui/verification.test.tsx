import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Verification } from '../../../../src/cli/tui/components/Verification.js';

vi.mock('../../../../src/cli/tui/hooks/useVerify.js', () => ({
  useVerify: () => ({
    items: [
      { id: 'searxng', name: 'SearXNG', status: 'pass', detail: 'http://localhost:8888' },
      { id: 'reranker', name: 'ML reranker', status: 'pass', detail: 'installed' },
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
    expect(frame).toContain('ML reranker');
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

// ---------------------------------------------------------------------------
// SP6 — end-to-end capability report (renders only when done:true + e2eResult)
// ---------------------------------------------------------------------------

describe('Verification — E2E report (done:true)', () => {
  const e2eResult = {
    capabilities: [
      { capability: 'search' as const, status: 'pass' as const, detail: 'got 3 results' },
      { capability: 'fetch' as const, status: 'fail' as const, detail: 'HTTP error — check connectivity' },
      { capability: 'extract' as const, status: 'pass' as const, detail: 'title extracted' },
      { capability: 'synthesis' as const, status: 'skipped' as const, detail: 'no provider key configured' },
      { capability: 'mcp-wiring' as const, status: 'pass' as const, detail: 'wigolo entry confirmed in: Cursor' },
    ],
    mcpWiringResults: [
      {
        agentId: 'cursor' as const,
        agentName: 'Cursor',
        configPath: '/home/u/.cursor/mcp.json',
        status: 'pass' as const,
        detail: 'wigolo entry found',
      },
    ],
    allPassed: false,
    hardFailureCount: 1,
  };

  it('renders the per-capability report with each capability name', async () => {
    vi.resetModules();
    vi.doMock('../../../../src/cli/tui/hooks/useVerify.js', () => ({
      useVerify: () => ({
        items: [{ id: 'searxng', name: 'SearXNG', status: 'pass', detail: 'ok' }],
        done: true,
        result: null,
      }),
    }));
    const { Verification: V } = await import('../../../../src/cli/tui/components/Verification.js');
    const { lastFrame } = render(
      <V dataDir="/tmp/test" onComplete={() => {}} e2eResult={e2eResult} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('End-to-end capability check');
    expect(frame).toContain('search');
    expect(frame).toContain('fetch');
    expect(frame).toContain('extract');
    expect(frame).toContain('synthesis');
    expect(frame).toContain('mcp-wiring');
  });

  it('renders capability details for pass / fail / skipped statuses', async () => {
    vi.resetModules();
    vi.doMock('../../../../src/cli/tui/hooks/useVerify.js', () => ({
      useVerify: () => ({
        items: [{ id: 'searxng', name: 'SearXNG', status: 'pass', detail: 'ok' }],
        done: true,
        result: null,
      }),
    }));
    const { Verification: V } = await import('../../../../src/cli/tui/components/Verification.js');
    const { lastFrame } = render(
      <V dataDir="/tmp/test" onComplete={() => {}} e2eResult={e2eResult} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('got 3 results');
    expect(frame).toContain('check connectivity');
    expect(frame).toContain('no provider key configured');
    // hard-failure summary line
    expect(frame).toContain('capability failure');
  });

  it('renders the MCP wiring sub-section when wiring results are present', async () => {
    vi.resetModules();
    vi.doMock('../../../../src/cli/tui/hooks/useVerify.js', () => ({
      useVerify: () => ({
        items: [{ id: 'searxng', name: 'SearXNG', status: 'pass', detail: 'ok' }],
        done: true,
        result: null,
      }),
    }));
    const { Verification: V } = await import('../../../../src/cli/tui/components/Verification.js');
    const { lastFrame } = render(
      <V dataDir="/tmp/test" onComplete={() => {}} e2eResult={e2eResult} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('MCP wiring');
    expect(frame).toContain('Cursor');
  });

  it('renders the all-pass summary when allPassed is true', async () => {
    vi.resetModules();
    vi.doMock('../../../../src/cli/tui/hooks/useVerify.js', () => ({
      useVerify: () => ({
        items: [{ id: 'searxng', name: 'SearXNG', status: 'pass', detail: 'ok' }],
        done: true,
        result: null,
      }),
    }));
    const allPass = { ...e2eResult, allPassed: true, hardFailureCount: 0 };
    const { Verification: V } = await import('../../../../src/cli/tui/components/Verification.js');
    const { lastFrame } = render(
      <V dataDir="/tmp/test" onComplete={() => {}} e2eResult={allPass} />,
    );
    expect(lastFrame()!).toContain('All capabilities confirmed');
  });
});
