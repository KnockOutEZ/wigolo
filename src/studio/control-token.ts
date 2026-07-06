import { createLogger } from '../logger.js';

/**
 * Single-driver control token for a session's shared input channel. The HOST
 * owns the epoch authoritatively: every holder change bumps a monotonic epoch,
 * and an inbound input event is dispatched only if it carries BOTH the current
 * holder's party AND the current epoch. A client's claimed epoch is used only to
 * gate (`canDrive`) — never stored or trusted — so input in flight across a flip
 * is dropped, not applied. Human reclaim is absolute (instant takeover); the
 * agent never seizes control, it is only ever granted.
 *
 * Pure state — no browser, no I/O. The SessionController consults it before
 * dispatching agent input; `studio_act` consults `assertCanDrive`.
 */

const log = createLogger('studio');

export type ControlParty = 'human' | 'agent';

export interface ControlSnapshot {
  holder: ControlParty;
  epoch: number;
  since: number;
}

export type DriveCheck = { ok: true } | { ok: false; reason: string; currentEpoch: number };

export interface ControlTokenOptions {
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
  /**
   * S5: the holder at construction (epoch stays 0). Defaults 'human'. Set to 'agent' ONLY for an
   * agent-spawned session (registry.create({spawnedBy:'agent'}) → Session → here) so the agent can drive a
   * clientless background session with no human attached (assertCanDrive('agent') succeeds). A human-spawned/
   * attended session keeps 'human' — the agent stays blocked until the human grants control. The agent NEVER
   * reaches this: it is set only on the host-side create path, never any agent-callable verb (requestControl
   * still returns {granted:false}).
   */
  initialHolder?: ControlParty;
}

export class ControlToken {
  private readonly nowFn: () => number;
  private _holder: ControlParty;
  private _epoch = 0;
  private _since: number;
  private readonly changeHandlers: Array<(s: { holder: ControlParty; epoch: number }) => void> = [];

  constructor(opts: ControlTokenOptions = {}) {
    this.nowFn = opts.now ?? Date.now;
    this._holder = opts.initialHolder ?? 'human';
    this._since = this.nowFn();
  }

  get holder(): ControlParty {
    return this._holder;
  }

  get epoch(): number {
    return this._epoch;
  }

  snapshot(): ControlSnapshot {
    return { holder: this._holder, epoch: this._epoch, since: this._since };
  }

  /** Human takeover — absolute and instant. Flips to human (epoch++) unless the human already holds. */
  reclaim(): void {
    this.flipTo('human');
  }

  /** Host/human hands control to a party (the agent-turn grant). epoch++ unless that party already holds. */
  grant(to: ControlParty): void {
    this.flipTo(to);
  }

  /** Current holder yields: the agent returns control to the human; a human release is a no-op. */
  release(): void {
    if (this._holder === 'agent') this.flipTo('human');
  }

  /** The agent asking for control. Denied in Phase 1 — control is only ever GRANTED by the host/human, never seized. */
  requestControl(_party: ControlParty): { granted: boolean } {
    return { granted: false };
  }

  /**
   * Gate an inbound input event. The caller passes the epoch the CLIENT believed
   * current; it is compared against the host's authoritative epoch and never
   * trusted as state. Returns true only for the current holder at the current epoch.
   */
  canDrive(party: ControlParty, epoch: number): boolean {
    return party === this._holder && epoch === this._epoch;
  }

  /** Holder-only check (no per-event epoch) for Phase-2 `studio_act`; returns the current epoch on refusal for resync. */
  assertCanDrive(party: ControlParty): DriveCheck {
    if (party === this._holder) return { ok: true };
    return { ok: false, reason: 'not_holder', currentEpoch: this._epoch };
  }

  /** Subscribe to holder flips (the hub pushes a `control` message to clients on each). */
  onChange(cb: (s: { holder: ControlParty; epoch: number }) => void): void {
    this.changeHandlers.push(cb);
  }

  private flipTo(party: ControlParty): void {
    if (this._holder === party) return; // no-op: never bump the epoch spuriously
    this._holder = party;
    this._epoch++;
    this._since = this.nowFn();
    log.debug('control token flipped', { holder: this._holder, epoch: this._epoch });
    for (const cb of this.changeHandlers) cb({ holder: this._holder, epoch: this._epoch });
  }
}
