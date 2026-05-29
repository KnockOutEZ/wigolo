import React from 'react';
import { Text } from 'ink';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

// Mock the heavy action screens so router tests stay deterministic and
// don't try to hit Searxng/Doctor/etc.
vi.mock('../../../../../src/cli/tui/components/VerifyScreen.js', () => ({
  VerifyScreen: ({ onBack }: { onBack: () => void }) => {
    (globalThis as Record<string, unknown>).__verifyOnBack = onBack;
    return React.createElement(Text, null, 'mock:VerifyScreen');
  },
}));
vi.mock('../../../../../src/cli/tui/components/DoctorScreen.js', () => ({
  DoctorScreen: ({ onBack }: { onBack: () => void }) => {
    (globalThis as Record<string, unknown>).__doctorOnBack = onBack;
    return React.createElement(Text, null, 'mock:DoctorScreen');
  },
}));
vi.mock('../../../../../src/cli/tui/components/DashboardExport.js', () => ({
  DashboardExport: ({ onBack }: { onBack: () => void }) => {
    (globalThis as Record<string, unknown>).__exportOnBack = onBack;
    return React.createElement(Text, null, 'mock:DashboardExport');
  },
}));
vi.mock('../../../../../src/cli/tui/components/ImportScreen.js', () => ({
  ImportScreen: ({ onBack }: { onBack: () => void }) => {
    (globalThis as Record<string, unknown>).__importOnBack = onBack;
    return React.createElement(Text, null, 'mock:ImportScreen');
  },
}));
vi.mock('../../../../../src/cli/tui/components/DashboardUninstall.js', () => ({
  DashboardUninstall: ({ onBack }: { onBack: () => void }) => {
    (globalThis as Record<string, unknown>).__uninstallOnBack = onBack;
    return React.createElement(Text, null, 'mock:DashboardUninstall');
  },
}));

import InkRouter from '../../../../../src/cli/tui/router/ink.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import { CATALOG } from '../../../../../src/cli/tui/schema/catalog.js';

afterEach(() => {
  cleanup();
});

const ARROW_DOWN = '\x1b[B';
const ENTER = '\r';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function makeStore() {
  return createSettingsStore({
    browserTypes: 'chromium',
    maxBrowsers: 3,
    browserIdleTimeoutMs: 30000,
  });
}

/**
 * Navigate from the home screen to the action at `actionIndex` (0 = Verify)
 * and press enter to mount it.
 */
async function pressAction(
  stdin: { write: (s: string) => void },
  actionIndex: number,
): Promise<void> {
  // Walk past every category row, then `actionIndex` extra steps to land on
  // the desired action.
  const total = CATALOG.length + actionIndex;
  for (let i = 0; i < total; i++) {
    stdin.write(ARROW_DOWN);
    await wait(10);
  }
  await wait(20);
  stdin.write(ENTER);
  await wait(40);
}

describe('InkRouter (router/ink.tsx)', () => {
  it('renders SettingsHome by default', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Browser');
    expect(frame).toContain('Verify');
    expect(frame).toContain('navigate');
  });

  it('transitions to CategoryScreen when SettingsHome emits onSelectCategory', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    stdin.write(ENTER);
    await wait(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Engine');
    expect(frame).toContain('Max concurrent');
    expect(frame).toContain('Idle timeout');
  });

  it('esc on CategoryScreen returns to SettingsHome', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    stdin.write(ENTER);
    await wait(40);
    stdin.write('\x1b'); // esc
    await wait(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Verify');
    expect(frame).toContain('Doctor');
    expect(frame).toContain('navigate');
  });

  it('routes Verify action to VerifyScreen', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    await pressAction(stdin, 0);
    expect(lastFrame() ?? '').toContain('mock:VerifyScreen');
  });

  it('routes Doctor action to DoctorScreen', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    await pressAction(stdin, 1);
    expect(lastFrame() ?? '').toContain('mock:DoctorScreen');
  });

  it('routes Export action to DashboardExport', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    await pressAction(stdin, 2);
    expect(lastFrame() ?? '').toContain('mock:DashboardExport');
  });

  it('routes Import action to ImportScreen', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    await pressAction(stdin, 3);
    expect(lastFrame() ?? '').toContain('mock:ImportScreen');
  });

  it('routes Uninstall action to DashboardUninstall', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    await pressAction(stdin, 4);
    expect(lastFrame() ?? '').toContain('mock:DashboardUninstall');
  });

  it('action screen onBack returns to SettingsHome', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    await pressAction(stdin, 0);
    expect(lastFrame() ?? '').toContain('mock:VerifyScreen');

    // Trigger the captured onBack — simulates the wrapped screen finishing.
    const back = (globalThis as Record<string, unknown>).__verifyOnBack as
      | (() => void)
      | undefined;
    expect(typeof back).toBe('function');
    back?.();
    await wait(40);
    const home = lastFrame() ?? '';
    expect(home).toContain('Browser');
    expect(home).toContain('navigate');
  });

  it('q from SettingsHome calls onExit when the store is clean', async () => {
    const store = makeStore();
    const onExit = vi.fn();
    const { stdin } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={onExit} />,
    );
    await wait(30);
    stdin.write('q');
    await wait(40);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
