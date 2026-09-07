/**
 * DoctorScreen's unmount contract.
 *
 * The screen used to guard only its own `setState` calls on unmount, which
 * stops the React warning and nothing else: the diagnostic — including its
 * live account request — kept running with no reader. In the suite that showed
 * up as a net-fence violation attributed to an unrelated test several arms
 * later, because the connect landed long after the screen was gone.
 *
 * So the assertion here is about the RUN, not about the render: unmounting
 * must abort the diagnostic, and the diagnostic must actually observe it.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

interface RunRecord {
  signal?: AbortSignal;
  settled: boolean;
}

// One record per call, never a shared slot: an aborted run records its
// settlement a microtask after the cleanup that aborted it, so a slot reused
// across arms reports the previous arm's outcome.
const runs: RunRecord[] = [];
const lastRun = (): RunRecord | undefined => runs[runs.length - 1];

vi.mock('../../../../src/cli/doctor.js', () => ({
  runDoctor: vi.fn(async (_dataDir: string, opts?: { signal?: AbortSignal }) => {
    const record: RunRecord = { signal: opts?.signal, settled: false };
    runs.push(record);
    // Stand in for a probe that is still in flight: it ends only when the
    // caller cancels it, never on its own. With no signal it never settles —
    // which is exactly the behaviour this fix removes.
    await new Promise<void>((resolve) => {
      if (opts?.signal === undefined) return;
      if (opts.signal.aborted) return resolve();
      opts.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    record.settled = true;
    return 0;
  }),
}));

const { DoctorScreen } = await import('../../../../src/cli/tui/components/DoctorScreen.js');

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

afterEach(cleanup);
beforeEach(() => {
  runs.length = 0;
});

describe('DoctorScreen — unmount stops the diagnostic', () => {
  it('hands runDoctor an abort signal', async () => {
    render(<DoctorScreen onBack={() => {}} />);
    await tick();
    expect(lastRun()?.signal).toBeInstanceOf(AbortSignal);
    expect(lastRun()?.signal?.aborted).toBe(false);
  });

  it('aborts the run when the screen unmounts mid-diagnostic', async () => {
    const { unmount, lastFrame } = render(<DoctorScreen onBack={() => {}} />);
    await tick();
    const run = lastRun();
    // Still mid-run: the stub has not returned, so the screen is on its
    // "running" frame and nothing has settled.
    expect(lastFrame() ?? '').toContain('Running doctor diagnostic');
    expect(run?.settled).toBe(false);

    unmount();
    await tick();

    expect(run?.signal?.aborted).toBe(true);
    // The run itself ended — not just the screen's interest in it.
    expect(run?.settled).toBe(true);
  });
});
