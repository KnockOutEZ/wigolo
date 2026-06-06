/**
 * Task 6 — Wizard completion ceremony fed by shared probe.
 *
 * Verifies that SetupComplete renders per-component status lines,
 * including the disabled-capability suffix (e.g. '→ find_similar disabled')
 * that Task 6 adds for non-ok components carrying a `disables` value.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { SetupComplete } from '../../src/cli/tui/components/WizardSteps.js';
import type { ComponentStatus } from '../../src/cli/tui/actions/setup-status.js';

afterEach(() => {
  cleanup();
});

const statuses: ComponentStatus[] = [
  { id: 'browser', label: 'browser', required: true, status: 'ok' },
  {
    id: 'embeddings',
    label: 'embeddings',
    required: false,
    status: 'failed',
    detail: 'timeout',
    disables: 'find_similar',
  },
];

describe('SetupComplete', () => {
  it('renders per-component status lines', () => {
    const { lastFrame } = render(<SetupComplete statuses={statuses} onDone={() => {}} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('browser');
    // Assert the full disabled-capability suffix, not just the bare label.
    // This is the behavior Task 6 adds: a non-ok component with `disables`
    // must render `   → <capability> disabled` (the shared format from
    // summarizeSetup — 3 spaces before the arrow). A bare-label assertion
    // would still pass if that suffix regressed, so match it exactly.
    expect(frame).toContain('   → find_similar disabled');
  });

  it('shows checkmark for ok component and cross for failed component', () => {
    const { lastFrame } = render(<SetupComplete statuses={statuses} onDone={() => {}} />);
    const frame = lastFrame() ?? '';
    // ok browser → ✓, failed embeddings → ✗
    expect(frame).toContain('✓');
    expect(frame).toContain('✗');
  });

  it('still shows Setup complete heading', () => {
    const { lastFrame } = render(<SetupComplete statuses={statuses} onDone={() => {}} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Setup complete/i);
  });
});
