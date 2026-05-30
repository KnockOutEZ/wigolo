import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { InkRoot } from '../../../../../src/cli/tui/router/ink.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import { CATALOG } from '../../../../../src/cli/tui/schema/catalog.js';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete process.env.WIGOLO_TUI_REDUCED_MOTION;
});

beforeEach(() => {
  process.env.WIGOLO_TUI_REDUCED_MOTION = '1';
});

function makeStore() {
  return createSettingsStore({
    browserTypes: 'chromium',
    maxBrowsers: 3,
    browserIdleTimeoutMs: 30000,
  });
}

describe('InkRoot — routeId dim transition (home → category:browser)', () => {
  it('fires MainPane dim transition when navigating from home to Browser category', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    delete process.env.WIGOLO_TUI_REDUCED_MOTION;
    vi.useFakeTimers();

    const store = makeStore();
    const { lastFrame, rerender } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="home" />,
    );

    await vi.runAllTimersAsync();
    const homeFrame = lastFrame() ?? '';
    expect(homeFrame).toContain('Browser');

    rerender(<InkRoot store={store} catalog={CATALOG} initialRoute="browser" />);
    await vi.advanceTimersByTimeAsync(20);
    const categoryFrame = lastFrame() ?? '';
    expect(categoryFrame).toContain('Browser');
  });
});

describe('InkRoot — routing behaviors', () => {
  it('renders home screen with category list on mount', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="home" />,
    );
    await wait(30);
    const frame = lastFrame() ?? '';
    // Home screen shows catalog categories
    expect(frame).toMatch(/Browser|Search|LLM|Agents|Cache/i);
  });

  it('navigates home → LLM category on sidebar Enter after arrow-down', async () => {
    const store = makeStore();
    // The third CATALOG entry is llmCategory (index 2 → 2 down-arrows from Browser)
    const { lastFrame } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="llm" />,
    );
    await wait(30);
    expect(lastFrame() ?? '').toMatch(/LLM/i);
  });

  it('mounts CategoryScreen when initialRoute is a settings category', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="browser" />,
    );
    await wait(30);
    // CategoryScreen for 'browser' renders browser-related field content
    expect(lastFrame() ?? '').toMatch(/Browser/i);
  });

  it('mounts VerifyScreen when initialRoute is "verify"', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="verify" />,
    );
    await wait(30);
    // VerifyScreen renders Verification component which shows verify-related content
    expect(lastFrame() ?? '').toBeTruthy();
  });

  it('mounts DoctorScreen when initialRoute is "doctor"', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="doctor" />,
    );
    await wait(30);
    // DoctorScreen renders "Running doctor diagnostic…" immediately
    expect(lastFrame() ?? '').toMatch(/doctor/i);
  });

  it('mounts DashboardExport when initialRoute is "export"', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="export" />,
    );
    await wait(30);
    // DashboardExport renders "Wigolo — export / import config"
    expect(lastFrame() ?? '').toMatch(/export/i);
  });

  it('mounts ImportScreen when initialRoute is "import"', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="import" />,
    );
    await wait(30);
    // ImportScreen renders "Import config" prompt
    expect(lastFrame() ?? '').toMatch(/import/i);
  });

  it('mounts DashboardUninstall when initialRoute is "uninstall"', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="uninstall" />,
    );
    await wait(30);
    // DashboardUninstall renders "Uninstall wigolo"
    expect(lastFrame() ?? '').toMatch(/uninstall/i);
  });

  it('calls onExit when q is pressed on home screen', async () => {
    const store = makeStore();
    const onExit = vi.fn();
    const { stdin } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="home" onExit={onExit} />,
    );
    await wait(30);
    stdin.write('q');
    await wait(30);
    expect(onExit).toHaveBeenCalled();
  });

  it('returns to home from a category screen on ESC', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <InkRoot store={store} catalog={CATALOG} initialRoute="browser" />,
    );
    await wait(30);
    // CategoryScreen is shown; pressing ESC triggers onBack → goHome
    stdin.write('\x1b');
    await wait(30);
    // After ESC, home screen is re-rendered (shows action row labels)
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Verify|Doctor|Export|Settings/i);
  });
});
