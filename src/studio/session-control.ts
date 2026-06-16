import { createLogger } from '../logger.js';
import type { ControlToken, ControlParty } from './control-token.js';
import type { MouseInput, KeyInput } from './input.js';

/**
 * Couples the control token to the input channel for one session: gates every
 * inbound input event through the token (host-authoritative epoch), and on every
 * holder flip neutralizes the OUTGOING holder's held input then tells clients the
 * new {holder, epoch} so stale-epoch input stops promptly. The hub routes raw
 * `input`/`control` WS messages here; this is where the token's table becomes
 * live behavior on the shared channel.
 */

const log = createLogger('studio');

/** The subset of InputForwarder this controller drives (injectable for tests). */
export interface InputSink {
  mouse(ev: MouseInput): Promise<void>;
  key(ev: KeyInput): Promise<void>;
  neutralizeHeld(): Promise<void>;
}

export type InputMessage =
  | ({ party: ControlParty; epoch: number; kind: 'mouse' } & MouseInput)
  | ({ party: ControlParty; epoch: number; kind: 'key' } & KeyInput);

export interface ControlMessage {
  op: 'reclaim' | 'grant' | 'release';
  to?: ControlParty;
}

export class SessionController {
  constructor(
    private readonly token: ControlToken,
    private readonly input: InputSink,
    private readonly broadcast: (msg: Record<string, unknown>) => void,
  ) {
    // Every flip: release the outgoing holder's held buttons/keys, then push the
    // authoritative {holder, epoch} so clients drop stale input without a round trip.
    this.token.onChange((s) => {
      void this.input.neutralizeHeld();
      this.broadcast({ t: 'control', holder: s.holder, epoch: s.epoch });
    });
  }

  /** Gate then dispatch an inbound input event. Returns whether it was applied. */
  async handleInput(msg: InputMessage): Promise<boolean> {
    if (!this.token.canDrive(msg.party, msg.epoch)) {
      log.debug('input dropped (not holder or stale epoch)', {
        party: msg.party,
        claimedEpoch: msg.epoch,
        holder: this.token.holder,
        hostEpoch: this.token.epoch,
      });
      return false;
    }
    if (msg.kind === 'mouse') await this.input.mouse(msg);
    else await this.input.key(msg);
    return true;
  }

  /** Apply a control op. Human `reclaim` is the absolute takeover; `grant`/`release` move the token per the state machine. */
  handleControl(msg: ControlMessage): void {
    if (msg.op === 'reclaim') this.token.reclaim();
    else if (msg.op === 'grant') this.token.grant(msg.to ?? 'agent');
    else if (msg.op === 'release') this.token.release();
  }
}
