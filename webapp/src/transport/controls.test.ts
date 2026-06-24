import { describe, it, expect } from 'vitest';
import { ControlsModel } from './controls.js';

/**
 * The Studio controls model (S1) — the single client-side holder of the SERVER-authoritative control state
 * ({holder, epoch}). It is fed ONLY by down-messages (hello/control); it never flips optimistically on a
 * local action. These pins lock the monotonic-epoch rule that keeps a stale/replayed message from rolling
 * the holder backwards.
 */
describe('ControlsModel — server-authoritative control state', () => {
  it('starts as the human holder at epoch 0 (matches the host default snapshot)', () => {
    expect(new ControlsModel().snapshot()).toEqual({ holder: 'human', epoch: 0 });
  });

  it('adopts a newer server {holder, epoch}', () => {
    const m = new ControlsModel();
    m.applyServer('agent', 1);
    expect(m.snapshot()).toEqual({ holder: 'agent', epoch: 1 });
  });

  // PIN-B (epoch monotonic). NAMED mutation that REDs: delete the `epoch < this._epoch` stale-guard in
  // applyServer (apply unconditionally) → the stale {human, epoch 1} overwrites the current {agent, 2}, so
  // the snapshot becomes human@1 and this assertion fails.
  it('PIN-B: a stale (lower-epoch) server message NEVER overwrites the current holder', () => {
    const m = new ControlsModel();
    m.applyServer('agent', 2);
    m.applyServer('human', 1); // arrives late / out of order — epoch is older
    expect(m.snapshot()).toEqual({ holder: 'agent', epoch: 2 });
  });

  it('notifies subscribers only when the server state actually changes', () => {
    const m = new ControlsModel();
    let calls = 0;
    m.subscribe(() => calls++);
    m.applyServer('agent', 1); // change
    m.applyServer('human', 0); // stale — no change
    expect(calls).toBe(1);
  });
});
