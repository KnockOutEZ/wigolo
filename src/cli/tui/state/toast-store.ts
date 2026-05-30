export interface Toast {
  message: string;
  severity: 'ok' | 'warn' | 'err';
  ttl: number;
  group?: string;
}

type Listener = () => void;

export interface ToastStore {
  push(t: Toast): void;
  current(): Toast | null;
  queue(): Toast[];
  subscribe(fn: Listener): () => void;
}

export function createToastStore(): ToastStore {
  let queue: Toast[] = [];
  const listeners = new Set<Listener>();
  const timers = new Map<Toast, ReturnType<typeof setTimeout>>();
  const fire = () => listeners.forEach((l) => l());

  function scheduleRemoval(t: Toast): void {
    const handle = setTimeout(() => {
      queue = queue.filter((q) => q !== t);
      timers.delete(t);
      fire();
    }, t.ttl);
    timers.set(t, handle);
  }

  function push(t: Toast): void {
    if (t.group === 'save') {
      const last = queue[queue.length - 1];
      if (last && last.group === 'save') {
        const m = /^Saved · (\d+) fields$/.exec(last.message);
        const next = m ? Number(m[1]) + 1 : 2;
        const merged: Toast = { ...last, message: `Saved · ${next} fields` };
        const prevTimer = timers.get(last);
        if (prevTimer !== undefined) { clearTimeout(prevTimer); timers.delete(last); }
        queue[queue.length - 1] = merged;
        scheduleRemoval(merged);
        fire();
        return;
      }
    }
    queue.push(t);
    scheduleRemoval(t);
    fire();
  }

  return {
    push,
    current: () => queue[0] ?? null,
    queue: () => [...queue],
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
