import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { SettingsHome } from '../../../../../src/cli/tui/components/SettingsHome.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import { browserCategory } from '../../../../../src/cli/tui/schema/browser.js';
import { CATALOG } from '../../../../../src/cli/tui/schema/catalog.js';

afterEach(() => {
  cleanup();
});

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ENTER = '\r';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function makeStore(overrides: Record<string, unknown> = {}) {
  return createSettingsStore({
    browserTypes: 'chromium',
    maxBrowsers: 3,
    browserIdleTimeoutMs: 30000,
    ...overrides,
  });
}

describe('SettingsHome', () => {
  it('renders one row per CATALOG category (Browser in this slice)', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Browser');
  });

  it('right-column preview shows the browser engine value', async () => {
    const store = makeStore({ browserTypes: 'chromium' });
    const { lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('chromium');
  });

  it('renders the title with version + product name when provided', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
        productName="wigolo"
        version="0.1.23"
      />,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('wigolo');
    expect(frame).toContain('0.1.23');
  });

  it('renders the bottom hotkey hint row', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑↓');
    expect(frame).toContain('navigate');
    expect(frame).toContain('enter');
    expect(frame).toContain('quit');
    expect(frame).toContain('help');
  });

  it('renders the action row with Verify / Doctor / Export / Import / Uninstall', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Verify');
    expect(frame).toContain('Doctor');
    expect(frame).toContain('Export');
    expect(frame).toContain('Import');
    expect(frame).toContain('Uninstall');
  });

  it('initial focus is on the first category row', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    const focusLine = frame.split('\n').find((l) => l.includes('❯ ')) ?? '';
    expect(focusLine).toContain('Browser');
  });

  it('down-arrow past the last category moves focus into the action row', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    // Single category in CATALOG → one ARROW_DOWN moves into the action row.
    stdin.write(ARROW_DOWN);
    await wait(30);
    const frame = lastFrame() ?? '';
    const focusLine = frame.split('\n').find((l) => l.includes('❯ ')) ?? '';
    expect(focusLine).toContain('Verify');
  });

  it('up-arrow does not move past index 0', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    stdin.write(ARROW_UP);
    await wait(20);
    const frame = lastFrame() ?? '';
    const focusLine = frame.split('\n').find((l) => l.includes('❯ ')) ?? '';
    expect(focusLine).toContain('Browser');
  });

  it('enter on the Browser row calls onSelectCategory("browser")', async () => {
    const store = makeStore();
    const onSelect = vi.fn();
    const { stdin } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={onSelect}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    stdin.write(ENTER);
    await wait(30);
    expect(onSelect).toHaveBeenCalledWith('browser');
  });

  it('enter on the Verify action row calls onAction("verify")', async () => {
    const store = makeStore();
    const onAction = vi.fn();
    const { stdin } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={onAction}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    // Move from Browser → Verify (first action).
    stdin.write(ARROW_DOWN);
    await wait(20);
    stdin.write(ENTER);
    await wait(30);
    expect(onAction).toHaveBeenCalledWith('verify');
  });

  it('enter on the Doctor action row calls onAction("doctor")', async () => {
    const store = makeStore();
    const onAction = vi.fn();
    const { stdin } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={onAction}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    // Browser → Verify → Doctor.
    stdin.write(ARROW_DOWN);
    await wait(10);
    stdin.write(ARROW_DOWN);
    await wait(20);
    stdin.write(ENTER);
    await wait(30);
    expect(onAction).toHaveBeenCalledWith('doctor');
  });

  it('q with a clean store calls onQuit immediately', async () => {
    const store = makeStore();
    expect(store.isDirty()).toBe(false);
    const onQuit = vi.fn();
    const { stdin } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={onQuit}
      />,
    );
    await wait(20);
    stdin.write('q');
    await wait(30);
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('q with a dirty store shows the confirmation line and does NOT call onQuit', async () => {
    const store = makeStore();
    store.set('maxBrowsers', 5);
    expect(store.isDirty()).toBe(true);
    const onQuit = vi.fn();
    const { stdin, lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={onQuit}
      />,
    );
    await wait(20);
    stdin.write('q');
    await wait(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Discard 1 pending change');
    expect(frame).toContain('(y/N)');
    expect(onQuit).not.toHaveBeenCalled();
  });

  it('confirmation y after q on a dirty store calls onQuit', async () => {
    const store = makeStore();
    store.set('maxBrowsers', 5);
    const onQuit = vi.fn();
    const { stdin } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={onQuit}
      />,
    );
    await wait(20);
    stdin.write('q');
    await wait(20);
    stdin.write('y');
    await wait(30);
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('confirmation n after q on a dirty store cancels and does NOT call onQuit', async () => {
    const store = makeStore();
    store.set('maxBrowsers', 5);
    const onQuit = vi.fn();
    const { stdin, lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={onQuit}
      />,
    );
    await wait(20);
    stdin.write('q');
    await wait(20);
    stdin.write('n');
    await wait(30);
    expect(onQuit).not.toHaveBeenCalled();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Discard');
  });

  it('? toggles a help overlay line', async () => {
    const store = makeStore();
    const { stdin, lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    const before = lastFrame() ?? '';
    expect(before).not.toContain('Pick a category to edit');
    stdin.write('?');
    await wait(30);
    expect(lastFrame() ?? '').toContain('Pick a category');
    stdin.write('?');
    await wait(30);
    expect(lastFrame() ?? '').not.toContain('Pick a category to edit');
  });

  it('renders the pending count in the hint when the store is dirty', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={CATALOG}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    store.set('maxBrowsers', 5);
    store.set('browserIdleTimeoutMs', 45000);
    await wait(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 pending');
  });

  it('renders even when CATALOG is empty (defensive)', async () => {
    const store = makeStore();
    const { lastFrame } = render(
      <SettingsHome
        store={store}
        catalog={[]}
        onSelectCategory={() => {}}
        onAction={() => {}}
        onQuit={() => {}}
      />,
    );
    await wait(20);
    // No throw, still shows actions and hint row.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Verify');
    expect(frame).toContain('navigate');
  });

  it('keeps the browserCategory reference intact (smoke)', () => {
    // Sanity — CATALOG always points at the same shared definition.
    expect(CATALOG[0]).toBe(browserCategory);
  });
});
