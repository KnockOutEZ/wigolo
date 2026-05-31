/**
 * Fix A regression test: MountRoot must sync its internal `phase` state when
 * `initialView` prop changes after the initial render. Without the useEffect
 * guard, a parent that passes `'home'` first (or a prop that arrives late) will
 * never show the wizard even if `initialView` is later updated to `'wizard'`.
 *
 * We render the real MountRoot from entry.ts. The lazy-loaded InkRoot and
 * WizardSteps components are injected via the `_inkRoot` / `_wizardSteps` test
 * seam props so the render is synchronous and deterministic — no dynamic import
 * mocking required.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Stub useApp — returns a noop `exit` so MountRoot doesn't throw outside Ink.
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useApp: () => ({ exit: vi.fn() }),
  };
});

// ---------------------------------------------------------------------------

import { MountRoot } from '../../../../src/cli/tui/entry.js';
import { createSettingsStore } from '../../../../src/cli/tui/state/settings-store.js';
import { CATALOG } from '../../../../src/cli/tui/schema/catalog.js';

// Stub components injected via the _inkRoot / _wizardSteps test seam.
// They emit a deterministic sentinel string so tests can assert which view is active.
const StubInkRoot = (_props: object): React.ReactElement =>
  React.createElement(Text, null, 'STUB_HOME');

const StubWizardSteps = (_props: object): React.ReactElement =>
  React.createElement(Text, null, 'STUB_WIZARD');

// Minimal props for MountRoot — store and catalog are required.
const store = createSettingsStore(CATALOG);
const mountProps = {
  store,
  catalog: CATALOG,
  configPath: '/tmp/test-wigolo.json',
  // Inject stubs so the component skips the lazy dynamic import and renders immediately.
  _inkRoot: StubInkRoot,
  _wizardSteps: StubWizardSteps,
};

describe('MountRoot phase sync (Fix A)', () => {
  it('renders the home view (StubInkRoot) when initialView is home', async () => {
    const { lastFrame } = render(
      React.createElement(MountRoot, { ...mountProps, initialView: 'home' }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('STUB_HOME');
  });

  it('phase updates to wizard when initialView prop changes from home to wizard', async () => {
    const { lastFrame, rerender } = render(
      React.createElement(MountRoot, { ...mountProps, initialView: 'home' }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('STUB_HOME');

    rerender(React.createElement(MountRoot, { ...mountProps, initialView: 'wizard' }));
    await new Promise((r) => setTimeout(r, 20));
    // With Fix A (useEffect), the phase syncs to wizard — StubWizardSteps renders.
    expect(lastFrame()).toContain('STUB_WIZARD');
  });

  it('phase updates to home when initialView prop changes from wizard to home', async () => {
    const { lastFrame, rerender } = render(
      React.createElement(MountRoot, { ...mountProps, initialView: 'wizard' }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('STUB_WIZARD');

    rerender(React.createElement(MountRoot, { ...mountProps, initialView: 'home' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('STUB_HOME');
  });
});
