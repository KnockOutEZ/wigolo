import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { CategoryScreen } from '../../../../../src/cli/tui/components/CategoryScreen.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import { browserCategory } from '../../../../../src/cli/tui/schema/browser.js';
import type { CategoryDef } from '../../../../../src/cli/tui/schema/types.js';

vi.mock('../../../../../src/cli/tui/actions/write-config.js', () => ({
  persistKey: vi.fn().mockResolvedValue(undefined),
  writeMcpConfig: vi.fn().mockResolvedValue({ results: [], anyFailed: false }),
}));

afterEach(() => {
  cleanup();
});

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ARROW_RIGHT = '\x1b[C';
const ESC = '\x1b';
const ENTER = '\r';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('CategoryScreen', () => {
  it('renders the category label, description, and all visible fields', async () => {
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
    });
    const { lastFrame } = render(
      <CategoryScreen
        category={browserCategory}
        store={store}
        onBack={() => {}}
      />,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Browser');
    expect(frame).toContain('Engine');
    expect(frame).toContain('Max concurrent');
    expect(frame).toContain('Idle timeout');
  });

  it('shows ActionBar with autosave hint', async () => {
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
    });
    const { lastFrame } = render(
      <CategoryScreen
        category={browserCategory}
        store={store}
        onBack={() => {}}
      />,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('autosave');
    expect(frame).toContain('⏎');
  });

  it('ActionBar pending count removed — autosave fires on field blur', async () => {
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
    });
    const blurSpy = vi.spyOn(store, 'blur');
    const { lastFrame } = render(
      <CategoryScreen
        category={browserCategory}
        store={store}
        onBack={() => {}}
      />,
    );
    await wait(20);
    // The ActionBar no longer shows a pending count badge.
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('save 0 pending');
    expect(frame).not.toContain('save 2 pending');
    // blur spy starts clean.
    expect(blurSpy).not.toHaveBeenCalled();
  });

  it('down-arrow moves focus to the next field', async () => {
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
    });
    const { stdin, lastFrame } = render(
      <CategoryScreen
        category={browserCategory}
        store={store}
        onBack={() => {}}
      />,
    );
    await wait(20);
    // Initially focused on "Engine" (index 0)
    const before = lastFrame() ?? '';
    // The focus indicator is a "❯ " glyph rendered by FieldRenderer.
    expect(before).toContain('❯ ');
    stdin.write(ARROW_DOWN);
    await wait(30);
    const after = lastFrame() ?? '';
    // Focus should have moved; "Max concurrent" line now carries the glyph.
    // We assert the relative position changed by comparing the line that contains it.
    const focusLineAfter = (after.split('\n').find((l) => l.includes('❯ ')) ?? '');
    expect(focusLineAfter).toContain('Max concurrent');
  });

  it('up-arrow does not move past index 0', async () => {
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
    });
    const { stdin, lastFrame } = render(
      <CategoryScreen
        category={browserCategory}
        store={store}
        onBack={() => {}}
      />,
    );
    await wait(20);
    stdin.write(ARROW_UP);
    await wait(20);
    const frame = lastFrame() ?? '';
    const focusLine = frame.split('\n').find((l) => l.includes('❯ ')) ?? '';
    expect(focusLine).toContain('Engine');
  });

  it('enter on a select field cycles the value and calls store.set', async () => {
    // Add a second option so cycling is observable.
    const category: CategoryDef = {
      ...browserCategory,
      fields: [
        {
          ...browserCategory.fields[0]!,
          options: [
            { value: 'chromium', label: 'Chromium' },
            { value: 'firefox', label: 'Firefox' },
          ],
        },
        ...browserCategory.fields.slice(1),
      ],
    };
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
    });
    const setSpy = vi.spyOn(store, 'set');
    const { stdin } = render(
      <CategoryScreen category={category} store={store} onBack={() => {}} />,
    );
    await wait(20);
    // Focused on Engine (select) by default. Enter should cycle to next option.
    stdin.write(ENTER);
    await wait(40);
    // The select also fires onEditDone, but the store.set call is what matters.
    expect(setSpy).toHaveBeenCalledWith('browserTypes', 'firefox');
  });

  it('right-arrow on a focused select cycles the value via FieldRenderer', async () => {
    const category: CategoryDef = {
      ...browserCategory,
      fields: [
        {
          ...browserCategory.fields[0]!,
          options: [
            { value: 'chromium', label: 'Chromium' },
            { value: 'firefox', label: 'Firefox' },
          ],
        },
        ...browserCategory.fields.slice(1),
      ],
    };
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
    });
    const { stdin } = render(
      <CategoryScreen category={category} store={store} onBack={() => {}} />,
    );
    await wait(20);
    stdin.write(ARROW_RIGHT);
    await wait(40);
    expect(store.getPending()).toEqual({ browserTypes: 'firefox' });
  });

  it('esc when not editing calls onBack', async () => {
    const onBack = vi.fn();
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
    });
    const { stdin } = render(
      <CategoryScreen category={browserCategory} store={store} onBack={onBack} />,
    );
    await wait(20);
    stdin.write(ESC);
    await wait(30);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('resets edit-buffer state on unmount', async () => {
    const onEditBufferChange = vi.fn();
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
    });
    const { unmount } = render(
      <CategoryScreen
        category={browserCategory}
        store={store}
        onBack={() => {}}
        onEditBufferChange={onEditBufferChange}
      />,
    );
    await wait(20);
    unmount();
    // Allow React's cleanup effects to flush after unmount.
    await wait(20);
    // The teardown effect must reset the flag to false so InkRoot doesn't get
    // stuck with inEditBuffer=true when the screen navigates away.
    expect(onEditBufferChange).toHaveBeenLastCalledWith(false);
  });

  it('initialFocusKey positions cursor on the specified field', async () => {
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
    });
    // The second field in browserCategory is "Max concurrent" (key: WIGOLO_MAX_BROWSERS).
    const secondField = browserCategory.fields[1];
    if (!secondField) throw new Error('test assumption: browserCategory must have at least 2 fields');
    const { lastFrame } = render(
      <CategoryScreen
        category={browserCategory}
        store={store}
        onBack={() => {}}
        initialFocusKey={secondField.key}
      />,
    );
    await wait(20);
    const frame = lastFrame() ?? '';
    // The focus glyph "❯ " should be on the second field row, not the first.
    const focusLine = frame.split('\n').find((l) => l.includes('❯ ')) ?? '';
    expect(focusLine).toContain('Max concurrent');
  });

  it('hidden fields are skipped (visible: () => false)', async () => {
    const hiddenCategory: CategoryDef = {
      id: 'browser',
      label: 'Browser',
      description: 'test',
      fields: [
        ...browserCategory.fields,
        {
          key: 'WIGOLO_HIDDEN',
          settingsPath: 'hiddenField',
          label: 'Hidden Field Should Not Render',
          kind: 'text',
          default: '',
          visible: () => false,
        },
      ],
    };
    const store = createSettingsStore({
      browserTypes: 'chromium',
      maxBrowsers: 3,
      browserIdleTimeoutMs: 30000,
      hiddenField: '',
    });
    const { lastFrame } = render(
      <CategoryScreen category={hiddenCategory} store={store} onBack={() => {}} />,
    );
    await wait(20);
    expect(lastFrame() ?? '').not.toContain('Hidden Field Should Not Render');
    // Visible fields still render.
    expect(lastFrame() ?? '').toContain('Engine');
  });

});

