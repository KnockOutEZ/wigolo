import { describe, it, expect, vi, beforeEach } from 'vitest';

const writes: Array<[string, unknown]> = [];

vi.mock('../../../../../src/cli/tui/actions/write-config.js', () => ({
  persistKey: vi.fn(async (path: string, value: unknown) => {
    writes.push([path, value]);
  }),
}));

import { createSettingsStore } from '../../../../../src/cli/tui/state/settings-store.js';

beforeEach(async () => {
  writes.length = 0;
  const { persistKey } = await import('../../../../../src/cli/tui/actions/write-config.js');
  (persistKey as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, value: unknown) => {
    writes.push([path, value]);
  });
});

describe('settings-store.blur', () => {
  it('blur fires commitOne for that key when pending', async () => {
    const store = createSettingsStore({});
    store.set('llm.model', 'claude-sonnet-4-6');
    await store.blur('llm.model');
    expect(writes).toEqual([['llm.model', 'claude-sonnet-4-6']]);
    expect(store.dirtyKeys()).not.toContain('llm.model');
  });

  it('blur is a no-op when nothing pending', async () => {
    const store = createSettingsStore({});
    await store.blur('llm.model');
    expect(writes).toEqual([]);
  });

  it('commitOne serialises concurrent writes to the same key', async () => {
    const { persistKey } = await import('../../../../../src/cli/tui/actions/write-config.js');
    (persistKey as ReturnType<typeof vi.fn>).mockImplementation(async (k: string, v: unknown) => {
      writes.push([`begin:${k}`, v]);
      await new Promise((r) => setTimeout(r, 30));
      writes.push([`end:${k}`, v]);
    });
    const store = createSettingsStore({});
    store.set('llm.key', 'a');
    const p1 = store.commitOne('llm.key');
    store.set('llm.key', 'b');
    const p2 = store.commitOne('llm.key');
    await Promise.all([p1, p2]);
    expect(writes.map(([k]) => k)).toEqual([
      'begin:llm.key',
      'end:llm.key',
      'begin:llm.key',
      'end:llm.key',
    ]);
  });

  it('commitOne surfaces write errors so callers can park focus', async () => {
    const { persistKey } = await import('../../../../../src/cli/tui/actions/write-config.js');
    (persistKey as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('disk full');
    });
    const store = createSettingsStore({});
    store.set('llm.key', 'sk-…');
    await expect(store.commitOne('llm.key')).rejects.toThrow('disk full');
    expect(store.dirtyKeys()).toContain('llm.key');
  });

  it('serialises three concurrent same-key writes and reports dirty between them', async () => {
    const { persistKey } = await import('../../../../../src/cli/tui/actions/write-config.js');
    const resolvers: Array<() => void> = [];
    (persistKey as ReturnType<typeof vi.fn>).mockImplementation((_k, _v) =>
      new Promise<void>((r) => { resolvers.push(r); })
    );
    const store = createSettingsStore({});
    store.set('llm.key', 'a');
    const p1 = store.commitOne('llm.key');
    store.set('llm.key', 'b');
    const p2 = store.commitOne('llm.key');
    store.set('llm.key', 'c');
    const p3 = store.commitOne('llm.key');

    // Wait for the first persistKey call to be queued (dynamic import inside
    // the .then chain means we need more than one microtask tick).
    await vi.waitFor(() => { if (resolvers.length < 1) throw new Error('waiting'); });
    resolvers[0]();
    await p1;
    expect(store.dirtyKeys()).toContain('llm.key');  // 'c' still pending

    await vi.waitFor(() => { if (resolvers.length < 2) throw new Error('waiting'); });
    resolvers[1]();
    await p2;
    expect(store.dirtyKeys()).toContain('llm.key');  // 'c' still pending

    await vi.waitFor(() => { if (resolvers.length < 3) throw new Error('waiting'); });
    resolvers[2]();
    await p3;
    expect(store.dirtyKeys()).not.toContain('llm.key');  // all done
  });

  it('commits the saved value into current so re-selecting it is not dirty', async () => {
    const store = createSettingsStore({ 'llm.model': 'claude-haiku-4-5' });
    store.set('llm.model', 'claude-sonnet-4-6');
    expect(store.isDirty()).toBe(true);

    await store.commitOne('llm.model');

    // After a successful single-key commit the in-memory snapshot must reflect
    // the persisted value; otherwise re-selecting the saved value re-dirties it.
    expect(store.getCurrent()['llm.model']).toBe('claude-sonnet-4-6');
    store.set('llm.model', 'claude-sonnet-4-6');
    expect(store.isDirty()).toBe(false);
  });
});
