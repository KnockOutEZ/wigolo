import { useState, useEffect } from 'preact/hooks';

/**
 * Client-side holder of the agent's PARKED risky actions (S7) — the human's pending-review surface. A risky
 * action with no matching pre-grant is parked host-side and broadcast as {t:'parked'}; the tab appends it here.
 * Ephemeral + broadcast-only (no backfill), like narration. Each entry's page-derived strings (domain) render
 * via SafeText in the panel.
 */
export interface ParkedView {
  action: string;
  risk: string;
  domain?: string;
  ref?: string;
}

const MAX_PARKED = 100;

export class ParkedModel {
  private items: ParkedView[] = [];
  private readonly subs = new Set<() => void>();

  snapshot(): ParkedView[] {
    return [...this.items];
  }

  applyDelta(item: ParkedView): void {
    this.items.push(item);
    if (this.items.length > MAX_PARKED) this.items = this.items.slice(-MAX_PARKED);
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

export function useParkedSnapshot(model: ParkedModel): ParkedView[] {
  const [snap, setSnap] = useState<ParkedView[]>(model.snapshot());
  useEffect(() => model.subscribe(() => setSnap(model.snapshot())), [model]);
  return snap;
}
