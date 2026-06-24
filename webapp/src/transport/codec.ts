/**
 * The Studio stream wire codec (S3) — the single boundary between the untyped WebSocket and the typed app.
 *
 * DOWN (host → tab): `parseDownMessage` validates the `t` discriminant + the minimal fields each variant
 * needs and returns a typed union; anything malformed or unknown returns null (never throws) so attacker /
 * garbage frames are dropped, not crashed on. The host's down-schema is the source of truth (see
 * src/studio/ws-hub.ts broadcast/broadcastFrame): hello, frame, control, error, approval_request.
 *
 * UP (tab → host): the `up` builders produce the exact shapes the host routes on (ws-hub onMessage cases:
 * ack, input, control, nav, mark, approval). The bearer/party are never carried here — the WS itself is the
 * authenticated human channel (the host stamps party='human'), so the tab can never claim to be the agent.
 */

export type ControlParty = 'human' | 'agent';
export type ControlOp = 'reclaim' | 'grant' | 'release';

export type DownMessage =
  | { t: 'hello'; sessionId: string; holder?: ControlParty; epoch?: number }
  | { t: 'frame'; data: string; meta?: unknown }
  | { t: 'control'; holder: ControlParty; epoch: number }
  | { t: 'error'; reason: string }
  | { t: 'approval_request'; id: number; action: string; risk: string; target?: { url?: string; ref?: string } };

export type UpMessage =
  | { t: 'ack' }
  | { t: 'input'; [k: string]: unknown }
  | { t: 'control'; op: ControlOp; to?: ControlParty }
  | { t: 'nav'; url: string }
  | { t: 'mark' }
  | { t: 'approval'; id: number; decision: string };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** Parse an inbound WS payload (string or pre-parsed object) into a typed down-message, or null if malformed/unknown. */
export function parseDownMessage(raw: unknown): DownMessage | null {
  let m: unknown = raw;
  if (typeof raw === 'string') {
    try {
      m = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'hello':
      if (typeof m.sessionId !== 'string') return null;
      return {
        t: 'hello',
        sessionId: m.sessionId,
        ...(m.holder === 'human' || m.holder === 'agent' ? { holder: m.holder } : {}),
        ...(typeof m.epoch === 'number' ? { epoch: m.epoch } : {}),
      };
    case 'frame':
      if (typeof m.data !== 'string') return null;
      return { t: 'frame', data: m.data, ...(m.meta !== undefined ? { meta: m.meta } : {}) };
    case 'control':
      if ((m.holder !== 'human' && m.holder !== 'agent') || typeof m.epoch !== 'number') return null;
      return { t: 'control', holder: m.holder, epoch: m.epoch };
    case 'error':
      if (typeof m.reason !== 'string') return null;
      return { t: 'error', reason: m.reason };
    case 'approval_request':
      if (typeof m.id !== 'number' || typeof m.action !== 'string' || typeof m.risk !== 'string') return null;
      return {
        t: 'approval_request',
        id: m.id,
        action: m.action,
        risk: m.risk,
        ...(isObj(m.target) ? { target: m.target as { url?: string; ref?: string } } : {}),
      };
    default:
      return null;
  }
}

/** Builders for the up-schema — the exact shapes the host's ws-hub routes on. */
export const up = {
  ack(): UpMessage {
    return { t: 'ack' };
  },
  input(payload: Record<string, unknown>): UpMessage {
    return { t: 'input', ...payload };
  },
  control(op: ControlOp, to?: ControlParty): UpMessage {
    return { t: 'control', op, ...(to ? { to } : {}) };
  },
  nav(url: string): UpMessage {
    return { t: 'nav', url };
  },
  mark(): UpMessage {
    return { t: 'mark' };
  },
  approval(id: number, decision: string): UpMessage {
    return { t: 'approval', id, decision };
  },
};

/** Serialize an up-message for `WebSocket.send`. */
export function encodeUp(msg: UpMessage): string {
  return JSON.stringify(msg);
}
