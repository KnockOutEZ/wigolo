import { useState, useEffect } from 'preact/hooks';

/**
 * Client-side holder of the SERVER-authoritative control state (S1). The host owns the control epoch; the tab
 * only ever MIRRORS what the host reports in `hello`/`control` down-messages — it never flips optimistically
 * on a local handoff action (S2). The epoch is monotonic: a stale or replayed message with an older epoch is
 * ignored so the displayed holder can never roll backwards.
 */

export type ControlParty = 'human' | 'agent';

export interface ControlState {
  holder: ControlParty;
  epoch: number;
}

export class ControlsModel {
  // Matches the host's default snapshot (controlSnapshot → {holder:'human', epoch:0}).
  private _holder: ControlParty = 'human';
  private _epoch = 0;
  private readonly subs = new Set<() => void>();

  snapshot(): ControlState {
    return { holder: this._holder, epoch: this._epoch };
  }

  /**
   * Apply a server-authoritative {holder, epoch}. Monotonic: a message whose epoch is OLDER than the current
   * one is dropped (newest epoch wins), so an out-of-order or replayed down-message can never roll the holder
   * back to a stale value. Subscribers fire only on an actual change.
   */
  applyServer(holder: ControlParty, epoch: number): void {
    if (epoch < this._epoch) return; // stale — newest epoch wins
    const changed = holder !== this._holder || epoch !== this._epoch;
    this._holder = holder;
    this._epoch = epoch;
    if (changed) for (const cb of this.subs) cb();
  }

  /** Subscribe to server-state changes; returns an unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }
}

/** Preact binding: re-render a component whenever the model's server state changes. */
export function useControlsSnapshot(model: ControlsModel): ControlState {
  const [snap, setSnap] = useState<ControlState>(model.snapshot());
  useEffect(() => model.subscribe(() => setSnap(model.snapshot())), [model]);
  return snap;
}
