import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { CategoryScreen } from '../../../../../src/cli/tui/components/CategoryScreen.js';
import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';
import type { CategoryDef } from '../../../../../src/cli/tui/schema/types.js';

vi.mock('../../../../../src/cli/tui/actions/write-config.js', () => ({
  persistKey: vi.fn().mockResolvedValue(undefined),
  writeMcpConfig: vi.fn().mockResolvedValue({ results: [], anyFailed: false }),
}));

afterEach(() => {
  cleanup();
});

const ENTER = '\r';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const textCategory: CategoryDef = {
  id: 'test',
  label: 'Test',
  fields: [
    {
      key: 'WIGOLO_GREETING',
      settingsPath: 'greeting',
      label: 'Greeting',
      kind: 'text',
      default: '',
    },
  ],
};

describe('CategoryScreen blur autosave', () => {
  it('Enter in a text field triggers blur on the field path', async () => {
    const store = createSettingsStore({ greeting: 'hello' });
    const blurSpy = vi.spyOn(store, 'blur');

    const { stdin } = render(
      <CategoryScreen
        category={textCategory}
        store={store}
        onBack={() => {}}
      />,
    );

    await wait(30);
    // Enter edit mode
    stdin.write(ENTER);
    await wait(30);
    // Type something
    stdin.write('a');
    stdin.write('b');
    stdin.write('c');
    await wait(20);
    // Commit with Enter — this should trigger blur('greeting')
    stdin.write(ENTER);
    await wait(50);

    expect(blurSpy).toHaveBeenCalledWith('greeting');
  });

  it('onSave prop is never called on keystroke (s handler removed)', async () => {
    const store = createSettingsStore({ greeting: '' });
    const onSave = vi.fn();

    render(
      <CategoryScreen
        category={textCategory}
        store={store}
        onBack={() => {}}
        onSave={onSave}
      />,
    );

    await wait(30);
    // onSave is no longer wired to any key — it should never fire passively.
    expect(onSave).not.toHaveBeenCalled();
  });

  it('ActionBar shows autosave hint (no manual save key)', async () => {
    const store = createSettingsStore({ greeting: '' });

    const { lastFrame } = render(
      <CategoryScreen
        category={textCategory}
        store={store}
        onBack={() => {}}
      />,
    );

    await wait(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('autosave');
    expect(frame).toContain('⏎');
  });
});
