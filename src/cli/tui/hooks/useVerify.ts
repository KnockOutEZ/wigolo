import { useState, useEffect } from 'react';
import type { WarmupReporter } from '../reporter.js';
import type { VerifyResult } from '../verify.js';

export interface VerifyItem {
  id: string;
  name: string;
  status: 'pending' | 'checking' | 'pass' | 'fail' | 'warn';
  detail: string;
  timeMs?: number;
}

const INITIAL_ITEMS: VerifyItem[] = [
  { id: 'searxng', name: 'SearXNG', status: 'pending', detail: '' },
  { id: 'flashrank', name: 'FlashRank', status: 'pending', detail: '' },
  { id: 'trafilatura', name: 'Trafilatura', status: 'pending', detail: '' },
  { id: 'embeddings', name: 'Embeddings', status: 'pending', detail: '' },
];

function createVerifyReporter(
  setItems: React.Dispatch<React.SetStateAction<VerifyItem[]>>,
  starts: Map<string, number>,
): WarmupReporter {
  return {
    start(id: string, _label: string) {
      starts.set(id, Date.now());
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, status: 'checking' } : item,
        ),
      );
    },
    update() {},
    progress() {},
    success(id: string, detail?: string) {
      const elapsed = starts.has(id) ? Date.now() - starts.get(id)! : undefined;
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, status: 'pass', detail: detail ?? 'ok', timeMs: elapsed } : item,
        ),
      );
    },
    fail(id: string, error: string) {
      const elapsed = starts.has(id) ? Date.now() - starts.get(id)! : undefined;
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, status: 'fail', detail: error, timeMs: elapsed } : item,
        ),
      );
    },
    note() {},
    finish() {},
  };
}

export function useVerify(dataDir: string): {
  items: VerifyItem[];
  done: boolean;
  result: VerifyResult | null;
} {
  const [items, setItems] = useState<VerifyItem[]>(INITIAL_ITEMS);
  const [done, setDone] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    const starts = new Map<string, number>();
    const reporter = createVerifyReporter(setItems, starts);

    async function run() {
      const { runVerify } = await import('../verify.js');
      const r = await runVerify(dataDir, reporter);
      if (!cancelled) {
        setResult(r);
        setDone(true);
      }
    }

    run().catch(() => {
      if (!cancelled) setDone(true);
    });

    return () => { cancelled = true; };
  }, [dataDir]);

  return { items, done, result };
}
