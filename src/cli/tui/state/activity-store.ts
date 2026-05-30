type Listener = () => void;

export interface ActivityStore {
  begin(label: string): () => void;
  busy(): boolean;
  labels(): string[];
  subscribe(fn: Listener): () => void;
}

export function createActivityStore(): ActivityStore {
  const active = new Map<symbol, string>();
  const listeners = new Set<Listener>();
  const fire = () => listeners.forEach((l) => l());

  return {
    begin(label) {
      const key = Symbol(label);
      active.set(key, label);
      fire();
      return () => {
        if (active.delete(key)) fire();
      };
    },
    busy: () => active.size > 0,
    labels: () => Array.from(active.values()),
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
