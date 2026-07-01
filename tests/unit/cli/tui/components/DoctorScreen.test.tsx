/**
 * DoctorScreen — wrapper around runDoctor().
 *
 * Tests assert the wrapper:
 *   - delegates to runDoctor with the dataDir from getConfig()
 *   - shows the running banner while runDoctor is pending
 *   - renders the OK summary when runDoctor returns 0
 *   - renders the degraded summary when runDoctor returns 1
 *   - renders an error frame when runDoctor throws
 *   - calls onBack when esc / q / enter is pressed after completion
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

const runDoctorMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/cli/doctor.js', () => ({
  runDoctor: runDoctorMock,
}));

vi.mock('../../../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/wigolo-dt' })),
}));

import { DoctorScreen } from '../../../../../src/cli/tui/components/DoctorScreen.js';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('DoctorScreen', () => {
  it('mounts without throwing', () => {
    runDoctorMock.mockResolvedValue(0);
    expect(() => render(<DoctorScreen onBack={() => {}} />)).not.toThrow();
  });

  it('shows the running banner immediately', async () => {
    runDoctorMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const { lastFrame } = render(<DoctorScreen onBack={() => {}} />);
    await wait(20);
    expect(lastFrame() ?? '').toContain('Running doctor');
  });

  it('delegates to runDoctor with the dataDir from getConfig', async () => {
    runDoctorMock.mockResolvedValue(0);
    render(<DoctorScreen onBack={() => {}} />);
    await wait(40);
    expect(runDoctorMock).toHaveBeenCalledWith('/tmp/wigolo-dt');
  });

  it('shows the OK summary when runDoctor returns 0', async () => {
    runDoctorMock.mockResolvedValue(0);
    const { lastFrame } = render(<DoctorScreen onBack={() => {}} />);
    await wait(50);
    expect(lastFrame() ?? '').toContain('all required components OK');
  });

  it('shows the degraded summary when runDoctor returns 1', async () => {
    runDoctorMock.mockResolvedValue(1);
    const { lastFrame } = render(<DoctorScreen onBack={() => {}} />);
    await wait(50);
    expect(lastFrame() ?? '').toContain('degraded');
  });

  it('renders an error frame when runDoctor throws', async () => {
    runDoctorMock.mockRejectedValue(new Error('boom'));
    const { lastFrame } = render(<DoctorScreen onBack={() => {}} />);
    await wait(50);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Doctor failed to run');
    expect(frame).toContain('boom');
  });

  it('calls onBack when esc is pressed after completion', async () => {
    runDoctorMock.mockResolvedValue(0);
    const onBack = vi.fn();
    const { stdin } = render(<DoctorScreen onBack={onBack} />);
    await wait(50);
    stdin.write('\x1b');
    await wait(30);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('ignores keypresses while running', async () => {
    runDoctorMock.mockImplementation(() => new Promise(() => {}));
    const onBack = vi.fn();
    const { stdin } = render(<DoctorScreen onBack={onBack} />);
    await wait(20);
    stdin.write('\x1b');
    stdin.write('q');
    await wait(30);
    expect(onBack).not.toHaveBeenCalled();
  });
});
