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
  /** Hard cap on concurrent live sessions; admission rejects over this (default 4). */
  maxSessions?: number;
  /**
   * S4: max lifetime (since creation) for a clientless KEEP-ALIVE (background) session before the backstop
   * evicts it anyway — prevents an abandoned background session leaking forever (default 30 min). Does NOT
   * affect non-keepAlive sessions (those evict on the idle clock) or client-attached sessions (never evicted).
   */
  backgroundMaxMs?: number;
}

/** Thrown by {@link SessionRegistry.create} when admission would exceed the cap. */
export class SessionLimitError extends Error {
  readonly code = 'studio_session_limit' as const;
  constructor(public readonly max: number) {
    super(`studio_session_limit: at most ${max} concurrent studio sessions allowed`);
    this.name = 'SessionLimitError';
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly backgroundMaxMs: number;
  /**
   * Fired AFTER the live session set changes (create/close), so the host can push a metadata-only
   * {t:'sessions'} switcher delta to connected clients (7f B2). Set by the host once the hub exists.
   */
  onChange?: () => void;

  constructor(opts: SessionRegistryOptions = {}) {
    this.idleMs = opts.idleMs ?? 30 * 60_000;
    this.now = opts.now ?? Date.now;
    this.maxSessions = opts.maxSessions ?? 4;
    this.backgroundMaxMs = opts.backgroundMaxMs ?? 30 * 60_000;
  }

  create(opts: Omit<SessionOptions, 'now'>): Session {
    // Reclaim idle clientless sessions FIRST, then admit against the post-sweep count —
    // a session freed by idle eviction must not count against a new admission.
    this.sweepIdle();
    if (this.sessions.size >= this.maxSessions) throw new SessionLimitError(this.maxSessions);
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
    const idleCutoff = this.now() - this.idleMs;
    const maxLifeCutoff = this.now() - this.backgroundMaxMs;
    const evicted: string[] = [];
    for (const session of this.list()) {
      // F1c attached-guard — the `clients === 0` first term is UNCHANGED and never weakened: a client-attached
      // session is never evicted, however old.
      if (session.clients !== 0) continue;
      // Normal idle eviction: a clientless, NON-keepAlive session idle past idleMs (S4 adds the !keepAlive term —
      // a background keep-alive session is exempt from the idle clock).
      const idleEvict = !session.keepAlive && session.lastActiveAt < idleCutoff;
      // S4 backstop: a clientless KEEP-ALIVE session past its max lifetime IS still evicted (prevents an abandoned
      // background session leaking forever). Keyed on createdAt (absolute age), not the idle clock.
      const backstopEvict = session.keepAlive && session.createdAt < maxLifeCutoff;
      if (idleEvict || backstopEvict) {
        session.close();
        this.sessions.delete(session.id);
        evicted.push(session.id);
      }
    }
    // The live set changed → refresh the switcher (mirror create/close). Fire once for the
    // batch, never on a no-op sweep, so an evicted session can't linger as a switcher ghost.
    // NOT done in closeAll: its only caller is shutdown teardown, where the hub is already
    // closed (hub.closeAll precedes registry.closeAll) — a broadcast there would race a no-op.
    if (evicted.length > 0) this.onChange?.();
    return evicted;
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Stops a running idle sweeper; idempotent. */
export interface IdleSweeper {
  stop(): void;
}

/**
 * Wire {@link SessionRegistry.sweepIdle} into a periodic lifecycle tick so idle
 * clientless sessions are reclaimed even when no new session is created (the only
 * other place that sweeps is admission in `create`). The host starts this once the
 * registry exists and stops it on shutdown. `schedule` is injectable so tests drive
 * a real tick without a wall-clock timer; the default uses an UNREF'd interval so a
 * pending sweep never keeps the process alive.
 */
export function startIdleSweeper(
  registry: Pick<SessionRegistry, 'sweepIdle'>,
  intervalMs: number,
  deps: { schedule?: (cb: () => void, ms: number) => () => void } = {},
): IdleSweeper {
  const schedule =
    deps.schedule ??
    ((cb, ms) => {
      const timer = setInterval(cb, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  const cancel = schedule(() => registry.sweepIdle(), intervalMs);
  return { stop: () => cancel() };
}
