export interface SettingsStore {
  getCurrent(): Readonly<Record<string, unknown>>;
  getPending(): Readonly<Record<string, unknown>>;
  isDirty(): boolean;
  dirtyKeys(): string[];
  set(key: string, value: unknown): void;
  discard(): void;
  commit(): void;
  subscribe(fn: () => void): () => void;
  /** Persist a single pending key to disk and remove it from pending on success. */
  commitOne(path: string): Promise<void>;
  /** No-op when `path` has no pending value; otherwise calls commitOne. */
  blur(path: string): Promise<void>;
}

export function createSettingsStore(
  initial: Readonly<Record<string, unknown>>,
): SettingsStore {
  const current: Record<string, unknown> = { ...initial };
  const pending = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const queues = new Map<string, Promise<void>>();

  const notify = (): void => {
    for (const fn of listeners) fn();
  };

  async function commitOne(path: string): Promise<void> {
    // Capture the pending value at call time — each commitOne call serialises
    // its own snapshot, so two concurrent calls each persist their own value.
    if (!pending.has(path)) return;
    const value = pending.get(path);
    const prev = queues.get(path) ?? Promise.resolve();
    // Build a settled promise that will be awaited sequentially.
    const next: Promise<void> = prev.then(async () => {
      const { persistKey } = await import('../actions/write-config.js');
      await persistKey(path, value);
      if (pending.get(path) === value) {
        pending.delete(path);
      }
      notify();
    });
    queues.set(path, next);
    try {
      await next;
    } finally {
      if (queues.get(path) === next) queues.delete(path);
    }
  }

  return {
    getCurrent: () => ({ ...current }),
    getPending: () => Object.fromEntries(pending),
    isDirty: () => pending.size > 0,
    dirtyKeys: () => [...pending.keys()],
    set(key, value) {
      const cur = current[key];
      const same = JSON.stringify(cur) === JSON.stringify(value);
      if (same) pending.delete(key);
      else pending.set(key, value);
      notify();
    },
    discard() {
      pending.clear();
      notify();
    },
    commit() {
      if (pending.size === 0) return;
      for (const [k, v] of pending) current[k] = v;
      pending.clear();
      notify();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    commitOne,
    async blur(path: string): Promise<void> {
      if (pending.has(path)) await commitOne(path);
    },
  };
}
