import { useState, useEffect } from 'react';
import type { WarmupReporter } from '../reporter.js';
import type { BrowserChoice } from '../components/BrowserSelect.js';

export interface InstallItem {
  id: string;
  name: string;
  status: 'waiting' | 'installing' | 'done' | 'failed' | 'skipped';
  timeMs?: number;
  error?: string;
  progress?: number;
}

function buildItems(browser: BrowserChoice): InstallItem[] {
  const items: InstallItem[] = [
    { id: 'searxng', name: 'SearXNG', status: 'waiting' },
    { id: 'playwright', name: 'Chromium', status: 'waiting' },
  ];
  if (browser === 'firefox') {
    items.push({ id: 'firefox', name: 'Firefox', status: 'waiting' });
  }
  items.push(
    { id: 'trafilatura', name: 'Trafilatura', status: 'waiting' },
    { id: 'flashrank', name: 'FlashRank', status: 'waiting' },
    { id: 'embeddings', name: 'Embeddings', status: 'waiting' },
  );
  if (browser === 'lightpanda') {
    items.push({ id: 'lightpanda', name: 'Lightpanda', status: 'waiting' });
  }
  return items;
}

function createTuiReporter(
  setItems: React.Dispatch<React.SetStateAction<InstallItem[]>>,
  starts: Map<string, number>,
): WarmupReporter {
  return {
    start(id: string, _label: string, _opts?: { totalBytes?: number }) {
      starts.set(id, Date.now());
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, status: 'installing' } : item,
        ),
      );
    },
    update(_id: string, _text: string) {},
    progress(id: string, fraction: number) {
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, progress: fraction } : item,
        ),
      );
    },
    success(id: string, _detail?: string) {
      const elapsed = starts.has(id) ? Date.now() - starts.get(id)! : undefined;
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, status: 'done', timeMs: elapsed } : item,
        ),
      );
    },
    fail(id: string, error: string) {
      const elapsed = starts.has(id) ? Date.now() - starts.get(id)! : undefined;
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, status: 'failed', error, timeMs: elapsed } : item,
        ),
      );
    },
    note(_text: string) {},
    finish() {},
  };
}

export function useInstall(browser: BrowserChoice): {
  items: InstallItem[];
  done: boolean;
} {
  const [items, setItems] = useState<InstallItem[]>(() => buildItems(browser));
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const starts = new Map<string, number>();
    const reporter = createTuiReporter(setItems, starts);

    async function run() {
      const { runWarmup } = await import('../../warmup.js');

      // Pass individual flags instead of --all to avoid triggering
      // warmup's built-in --verify (the TUI has its own Verification screen)
      const flags = [
        '--trafilatura',
        '--reranker',
        '--embeddings',
      ];
      if (browser === 'lightpanda') flags.push('--lightpanda');
      if (browser === 'firefox') flags.push('--firefox');

      await runWarmup(flags, reporter);
      if (!cancelled) setDone(true);
    }

    run().catch(() => {
      if (!cancelled) setDone(true);
    });

    return () => { cancelled = true; };
  }, [browser]);

  return { items, done };
}
