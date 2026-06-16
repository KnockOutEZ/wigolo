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
    // Every flip: release the outgoing holder's held buttons/keys and push the
    // authoritative {holder, epoch} so clients drop stale input. The neutralize
    // is best-effort/async (a failed release is logged, not fatal); correctness
    // does not depend on its completion ordering vs the broadcast — the epoch
    // gate already rejects any input that races the flip.
    this.token.onChange((s) => {
      void this.input.neutralizeHeld().catch((err) =>
        log.debug('neutralizeHeld failed on flip', { error: err instanceof Error ? err.message : String(err) }),
      );
      this.broadcast({ t: 'control', holder: s.holder, epoch: s.epoch });
    });
  }

  /** Current control state — sent to a client on connect (in `hello`) so it knows the epoch to stamp on input. */
  controlSnapshot(): { holder: ControlParty; epoch: number } {
    return { holder: this.token.holder, epoch: this.token.epoch };
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

  /**
   * A client disconnected (graceful close, error, or heartbeat reap). If the
   * human holds, release whatever they left pressed — a holder dropping mid-drag
   * must not strand a button/modifier down on the page until the next flip. Only
   * acts when the human holds: a human viewer leaving must not release the agent's
   * input (Phase 2). The forwarder only ever tracks human raw input in Phase 1.
   */
  onClientGone(): void {
    if (this.token.holder !== 'human') return;
    void this.input.neutralizeHeld().catch((err) =>
      log.debug('neutralizeHeld on client-gone failed', { error: err instanceof Error ? err.message : String(err) }),
    );
  }

  /** Apply a control op. Human `reclaim` is the absolute takeover; `grant`/`release` move the token per the state machine. */
  handleControl(msg: ControlMessage): void {
    if (msg.op === 'reclaim') this.token.reclaim();
    else if (msg.op === 'grant') this.token.grant(msg.to ?? 'agent');
    else if (msg.op === 'release') this.token.release();
  }

  /**
   * Entry point for an inbound WS input message (untrusted JSON). The party is
   * HOST-STAMPED to 'human' — the WS is the human channel, so a client can never
   * claim to be the agent (the agent drives via studio_act in Phase 2). epoch/kind
   * are coerced; a malformed event that throws on dispatch is swallowed (dropped).
   */
  async handleWireInput(raw: Record<string, unknown>): Promise<boolean> {
    const epoch = typeof raw.epoch === 'number' ? raw.epoch : -1;
    const kind = raw.kind === 'key' ? 'key' : 'mouse';
    const msg = { ...raw, party: 'human', epoch, kind } as unknown as InputMessage;
    try {
      return await this.handleInput(msg);
    } catch (err) {
      log.debug('input dispatch failed', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Entry point for an inbound WS control message (untrusted JSON): coerce the op + target, then apply. */
  handleWireControl(raw: Record<string, unknown>): void {
    const op = raw.op;
    if (op !== 'reclaim' && op !== 'grant' && op !== 'release') return;
    const to = raw.to === 'agent' ? 'agent' : raw.to === 'human' ? 'human' : undefined;
    this.handleControl({ op, to });
  }
}
