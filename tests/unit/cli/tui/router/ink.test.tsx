import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import InkRouter from '../../../../../src/cli/tui/router/ink.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import { CATALOG } from '../../../../../src/cli/tui/schema/catalog.js';

afterEach(() => {
  cleanup();
});

const ARROW_DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function makeStore() {
  return createSettingsStore({
    browserTypes: 'chromium',
    maxBrowsers: 3,
    browserIdleTimeoutMs: 30000,
  });
}

describe('InkRouter (router/ink.tsx)', () => {
  it('renders SettingsHome by default', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    const frame = lastFrame() ?? '';
    // Home shows category label + action labels + hotkey hint.
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
    // Enter on the focused Browser row.
    stdin.write(ENTER);
    await wait(40);
    const frame = lastFrame() ?? '';
    // CategoryScreen renders the individual field labels.
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
    // Now on CategoryScreen.
    stdin.write(ESC);
    await wait(40);
    const frame = lastFrame() ?? '';
    // Home shows the action labels; CategoryScreen does not.
    expect(frame).toContain('Verify');
    expect(frame).toContain('Doctor');
    expect(frame).toContain('navigate');
  });

  it('action row entry renders the slice-11 placeholder and esc returns home', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <InkRouter store={store} catalog={CATALOG} onExit={() => {}} />,
    );
    await wait(30);
    // Browser → action row (Verify focused).
    stdin.write(ARROW_DOWN);
    await wait(20);
    stdin.write(ENTER);
    await wait(40);
    expect(lastFrame() ?? '').toContain('Verify (coming in slice 11)');
    // esc returns home.
    stdin.write(ESC);
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
