import { useState, useEffect } from 'react';
import type { WarmupReporter } from '../reporter.js';
import type { BrowserChoice } from '../components/BrowserSelect.js';
import type { ToggleMap } from '../actions/index.js';

export interface InstallItem {
  id: string;
  name: string;
  status: 'waiting' | 'installing' | 'done' | 'failed' | 'skipped';
  timeMs?: number;
  error?: string;
  progress?: number;
}

function buildItems(browser: BrowserChoice, toggles?: ToggleMap): InstallItem[] {
  const toggled = (id: string): boolean => {
    if (!toggles) return true;
    return (toggles as Record<string, boolean>)[id] ?? true;
  };
  const items: InstallItem[] = [
    { id: 'searxng', name: 'Search engine', status: toggled('searxng') ? 'waiting' : 'skipped' },
    { id: 'playwright', name: 'Chromium', status: toggled('chromium') ? 'waiting' : 'skipped' },
  ];
  if (browser === 'firefox') {
    items.push({ id: 'firefox', name: 'Firefox', status: toggled('firefox') ? 'waiting' : 'skipped' });
  }
  items.push(
    { id: 'reranker', name: 'ML reranker', status: toggled('reranker') ? 'waiting' : 'skipped' },
    { id: 'embeddings', name: 'Embeddings', status: toggled('embeddings') ? 'waiting' : 'skipped' },
  );
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

export function useInstall(browser: BrowserChoice, toggles?: ToggleMap): {
  items: InstallItem[];
  done: boolean;
} {
  const [items, setItems] = useState<InstallItem[]>(() => buildItems(browser, toggles));
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const starts = new Map<string, number>();
    const reporter = createTuiReporter(setItems, starts);

    const toggled = (id: string): boolean => {
      if (!toggles) return true;
      return (toggles as Record<string, boolean>)[id] ?? true;
    };

    async function run() {
      const { runWarmup } = await import('../../warmup.js');

      // Pass individual flags instead of --all to avoid triggering
      // warmup's built-in --verify (the TUI has its own Verification screen).
      // Respect toggles: skip items the user opted out of.
      const flags: string[] = [];
      if (toggled('reranker')) flags.push('--reranker');
      if (toggled('embeddings')) flags.push('--embeddings');
      if (browser === 'firefox' && toggled('firefox')) flags.push('--firefox');

      if (flags.length > 0) {
        await runWarmup(flags, reporter);
      }
      if (!cancelled) setDone(true);
    }

    run().catch(() => {
      if (!cancelled) setDone(true);
    });

    return () => { cancelled = true; };
  }, [browser, toggles]);

  return { items, done };
}
