import { Session, type SessionOptions } from './session.js';

/**
 * In-memory registry of live Studio sessions, owned by the host. Phase 0 keeps
 * it in memory (no persistence — the artifact schema is Phase 4); the host
 * writes the active session's handle to disk separately (handle.ts). Idle
 * eviction runs on a sweep with an injectable clock so it is testable.
 */
export interface SessionRegistryOptions {
  /** Evict clientless sessions idle longer than this (default 30 min). */
  idleMs?: number;
  now?: () => number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly idleMs: number;
  private readonly now: () => number;
  /**
   * Fired AFTER the live session set changes (create/close), so the host can push a metadata-only
   * {t:'sessions'} switcher delta to connected clients (7f B2). Set by the host once the hub exists.
   */
  onChange?: () => void;

  constructor(opts: SessionRegistryOptions = {}) {
    this.idleMs = opts.idleMs ?? 30 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  create(opts: Omit<SessionOptions, 'now'>): Session {
    const session = new Session({ ...opts, now: this.now });
    this.sessions.set(session.id, session);
    this.onChange?.();
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * The single open session, if exactly one — the proxy's default target when
   * the caller does not pass an explicit session_id. Undefined when none or
   * more than one is open (caller must disambiguate).
   */
  active(): Session | undefined {
    const open = this.list().filter((s) => s.status !== 'closed');
    return open.length === 1 ? open[0] : undefined;
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.close();
      this.sessions.delete(id);
      this.onChange?.();
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  /**
   * Evict sessions that have no attached clients and have been idle past
   * idleMs. Returns the evicted session ids. A session with a client attached
   * is never evicted, regardless of age.
   */
  sweepIdle(): string[] {
    const cutoff = this.now() - this.idleMs;
    const evicted: string[] = [];
    for (const session of this.list()) {
      if (session.clients === 0 && session.lastActiveAt < cutoff) {
        session.close();
        this.sessions.delete(session.id);
        evicted.push(session.id);
      }
    }
    return evicted;
  }

  get size(): number {
    return this.sessions.size;
  }
}
