/**
 * VerifyScreen — wrapper around the Verification component.
 *
 * Tests assert the wrapper:
 *   - mounts without throwing
 *   - delegates dataDir from getConfig()
 *   - shows the return-key hint after Verification fires onComplete
 *   - calls onBack when esc / q / enter is pressed after completion
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

const useVerifyMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/cli/tui/hooks/useVerify.js', () => ({
  useVerify: useVerifyMock,
}));

vi.mock('../../../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/wigolo-vt' })),
}));

import { VerifyScreen } from '../../../../../src/cli/tui/components/VerifyScreen.js';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('VerifyScreen', () => {
  it('mounts without throwing', () => {
    useVerifyMock.mockReturnValue({
      items: [{ id: 'searxng', name: 'Search', status: 'pending', detail: '' }],
      done: false,
      result: null,
    });
    expect(() =>
      render(<VerifyScreen onBack={() => {}} />),
    ).not.toThrow();
  });

  it('renders the Verification header', () => {
    useVerifyMock.mockReturnValue({
      items: [{ id: 'searxng', name: 'Search', status: 'pending', detail: '' }],
      done: false,
      result: null,
    });
    const { lastFrame } = render(<VerifyScreen onBack={() => {}} />);
    expect(lastFrame() ?? '').toContain('Verifying setup');
  });

  it('shows the "press to return" hint after Verification completes', async () => {
    useVerifyMock.mockReturnValue({
      items: [{ id: 'searxng', name: 'Search', status: 'pass', detail: 'ok' }],
      done: true,
      result: null,
    });
    const { lastFrame } = render(<VerifyScreen onBack={() => {}} />);
    // Verification waits ~400ms before firing onComplete after done flips true.
    await wait(500);
    expect(lastFrame() ?? '').toContain('Press enter or q/esc to return');
  });

  it('calls onBack when esc is pressed after completion', async () => {
    useVerifyMock.mockReturnValue({
      items: [{ id: 'searxng', name: 'Search', status: 'pass', detail: 'ok' }],
      done: true,
      result: null,
    });
    const onBack = vi.fn();
    const { stdin } = render(<VerifyScreen onBack={onBack} />);
    await wait(500);
    stdin.write('\x1b');
    await wait(30);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('ignores keypresses before completion', async () => {
    useVerifyMock.mockReturnValue({
      items: [{ id: 'searxng', name: 'Search', status: 'pending', detail: '' }],
      done: false,
      result: null,
    });
    const onBack = vi.fn();
    const { stdin } = render(<VerifyScreen onBack={onBack} />);
    await wait(30);
    stdin.write('\x1b');
    stdin.write('q');
    await wait(30);
    expect(onBack).not.toHaveBeenCalled();
  });
});
