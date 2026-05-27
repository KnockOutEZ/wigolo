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

/**
 * Resolve a toggle's effective state. Chromium is REQUIRED — it is the only
 * JS-render engine post-SP1, so it is always installed regardless of toggle.
 */
function isEnabled(id: string, toggles?: ToggleMap): boolean {
  if (id === 'chromium' || id === 'playwright') return true; // required
  if (!toggles) return true;
  return (toggles as Record<string, boolean>)[id] ?? true;
}

/**
 * Build the install flags from toggle state. This is the single source of
 * truth consumed by both the install effect and tests — toggling a component
 * off genuinely changes which warmup work runs:
 *   - chromium: always installed (required) → runWarmup always runs
 *   - searxng OFF → `--no-searxng` skips the bootstrap phase
 *   - reranker/embeddings/firefox ON → their individual flags
 */
export function buildInstallFlags(browser: BrowserChoice, toggles?: ToggleMap): string[] {
  const flags: string[] = [];
  if (!isEnabled('searxng', toggles)) flags.push('--no-searxng');
  if (isEnabled('reranker', toggles)) flags.push('--reranker');
  if (isEnabled('embeddings', toggles)) flags.push('--embeddings');
  if (browser === 'firefox' && isEnabled('firefox', toggles)) flags.push('--firefox');
  return flags;
}

function buildItems(browser: BrowserChoice, toggles?: ToggleMap): InstallItem[] {
  const items: InstallItem[] = [
    // Chromium is required and always installed.
    { id: 'playwright', name: 'Chromium', status: 'waiting' },
    { id: 'searxng', name: 'Search engine', status: isEnabled('searxng', toggles) ? 'waiting' : 'skipped' },
  ];
  if (browser === 'firefox') {
    items.push({ id: 'firefox', name: 'Firefox', status: isEnabled('firefox', toggles) ? 'waiting' : 'skipped' });
  }
  items.push(
    { id: 'reranker', name: 'ML reranker', status: isEnabled('reranker', toggles) ? 'waiting' : 'skipped' },
    { id: 'embeddings', name: 'Embeddings', status: isEnabled('embeddings', toggles) ? 'waiting' : 'skipped' },
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

    async function run() {
      const { runWarmup } = await import('../../warmup.js');

      // Pass individual flags instead of --all to avoid triggering
      // warmup's built-in --verify (the TUI has its own Verification screen).
      // Chromium is required, so runWarmup always runs; toggle state controls
      // the rest via buildInstallFlags (--no-searxng / --reranker / etc.).
      const flags = buildInstallFlags(browser, toggles);
      await runWarmup(flags, reporter);
      if (!cancelled) setDone(true);
    }

    run().catch(() => {
      if (!cancelled) setDone(true);
    });

    return () => { cancelled = true; };
  }, [browser, toggles]);

  return { items, done };
}
