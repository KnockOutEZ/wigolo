import { useState, useEffect } from 'preact/hooks';

/**
 * Client-side holder of the agent's narration stream (S2b). Narration is the agent→human direction: a short
 * note the agent attaches to a studio_act / studio_observe call, broadcast to the attended tab. It is EPHEMERAL
 * and broadcast-only — the host never persists it, so there is no snapshot/backfill and no id/upsert: each
 * {t:'narration'} delta simply appends. The list is bounded so a long-running session cannot grow it without
 * limit. Every entry is agent-authored (UNTRUSTED on this surface) and rendered inert via SafeText by the panel.
 */
const MAX_NARRATIONS = 50;

export class NarrationModel {
  private items: string[] = [];
  private readonly subs = new Set<() => void>();

  snapshot(): string[] {
    return [...this.items];
  }

  /** A live narration delta: append (newest last), trimming the oldest past the bound. */
  applyDelta(text: string): void {
    this.items.push(text);
    if (this.items.length > MAX_NARRATIONS) this.items = this.items.slice(-MAX_NARRATIONS);
    this.emit();
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }

  private emit(): void {
    for (const cb of this.subs) cb();
  }
}

/** Preact binding: re-render whenever a new narration arrives. */
export function useNarrationSnapshot(model: NarrationModel): string[] {
  const [snap, setSnap] = useState<string[]>(model.snapshot());
  useEffect(() => model.subscribe(() => setSnap(model.snapshot())), [model]);
  return snap;
}
