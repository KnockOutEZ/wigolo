import { randomUUID } from 'node:crypto';
import { mintHostToken } from './auth.js';

/**
 * A Studio session: a long-lived, addressable unit the host owns and the human
 * + the user's agent co-drive. Phase 0 models its lifecycle and client
 * attachment only — the live headed browser binds in Phase 1, so there is no
 * browser handle here yet. `now` is injectable so the registry's idle eviction
 * is testable without real time.
 */
export type SessionStatus = 'active' | 'idle' | 'closed';

export interface SessionSnapshot {
  id: string;
  token: string;
  endpoint: string;
  status: SessionStatus;
  clients: number;
  createdAt: number;
  lastActiveAt: number;
}

/**
 * The session-switcher projection: the ONLY session fields safe to enumerate to a connected client.
 * Deliberately EXCLUDES `token` (a bearer leak) and `endpoint`/url (not needed — a daemon-scoped bearer
 * reaches every session by path, so the client never needs a per-session URL). Metadata only.
 */
export interface SessionMeta {
  id: string;
  status: SessionStatus;
  clients: number;
  createdAt: number;
  lastActiveAt: number;
}

/** Project a Session to its enumeration-safe metadata (no token, no url). */
export function sessionMeta(s: Session): SessionMeta {
  return { id: s.id, status: s.status, clients: s.clients, createdAt: s.createdAt, lastActiveAt: s.lastActiveAt };
}

export interface SessionOptions {
  endpoint: string;
  id?: string;
  token?: string;
  now?: () => number;
}

export class Session {
  readonly id: string;
  readonly token: string;
  readonly endpoint: string;
  readonly createdAt: number;

  private readonly nowFn: () => number;
  private _status: SessionStatus = 'active';
  private _clients = 0;
  private _lastActiveAt: number;

  constructor(opts: SessionOptions) {
    this.nowFn = opts.now ?? Date.now;
    this.id = opts.id ?? randomUUID();
    this.token = opts.token ?? mintHostToken();
    this.endpoint = opts.endpoint;
    this.createdAt = this.nowFn();
    this._lastActiveAt = this.createdAt;
  }

  get status(): SessionStatus {
    return this._status;
  }

  get clients(): number {
    return this._clients;
  }

  get lastActiveAt(): number {
    return this._lastActiveAt;
  }

  /** Mark activity: refresh the idle clock and revive an idle (not closed) session. */
  touch(): void {
    this._lastActiveAt = this.nowFn();
    if (this._status === 'idle') this._status = 'active';
  }

  /** A client (the agent proxy or a future web client) attached. */
  attach(): void {
    this._clients++;
    this.touch();
  }

  /** A client detached; never drops below zero. */
  detach(): void {
    this._clients = Math.max(0, this._clients - 1);
    this.touch();
  }

  /** Park an active session as idle (registry idle sweep). No-op once closed. */
  markIdle(): void {
    if (this._status === 'active') this._status = 'idle';
  }

  /** Terminal: a closed session never reactivates. */
  close(): void {
    this._status = 'closed';
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      token: this.token,
      endpoint: this.endpoint,
      status: this._status,
      clients: this._clients,
      createdAt: this.createdAt,
      lastActiveAt: this._lastActiveAt,
    };
  }
}
