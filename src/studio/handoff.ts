/**
 * Slice 5e-a — the login-wall handoff state machine (pure mechanism).
 *
 * A login wall is human-only (HANDOFF §2/§4: the agent never enters credentials). When an
 * agent action lands on a credential context, this machine RECLAIMS control to the human,
 * tells the agent to wait (the `login_handoff` signal + the existing `not_holder` fence on
 * `studio_act`), and watches for the human to finish — then hands the result to an
 * `onComplete` HOOK (filled by 5e-b capture/persist and 5e-c re-grant/resume).
 *
 *   agent-driving ──wall──▶ human-holding ──┬─ completing  → onComplete (5e-b/5e-c re-grant)
 *                                           ├─ aborted 🔒  (timeout, no completion)
 *                                           └─ vanished 🔒 (the client disconnected)
 *
 * LOCKED terminals (aborted / vanished) NEVER re-grant the agent and NEVER invoke the hook:
 * a disconnect or a give-up must not silently resume an agent into a half-finished login.
 * Only the COMPLETING terminal re-grants (5e-c): after the hook resolves it hands the wheel back
 * so the agent resumes the now-authenticated session. The hook fires ONLY on detected completion.
 *
 * Completion is conservative and AND-gated: the live page must have LEFT the credential
 * context AND a MEANINGFUL storageState delta must have appeared for the wall origin (a real
 * new cookie / localStorage entry — an addition, not a value change). An empty or unchanged
 * read never completes; the deadline then aborts.
 *
 * Pure mechanism: every dependency is injected (control token, event queue, the credential-
 * context probe, the host-only storageState read-back, timers, and the onComplete seam). The
 * storageState read is HOST-SIDE only — never agent-facing, never logged (it carries cookies).
 */
import type { StorageStateOut } from './session-browser.js';

export type ControlParty = 'human' | 'agent';

/** The login_handoff signal the agent reads via studio_observe — carries ONLY the state, never page content or storageState. */
export interface LoginHandoffSignal {
  state: 'in_progress' | 'completed' | 'failed';
  /** Set while in progress so the agent waits rather than fighting the human for the wheel. */
  doNotRetry?: true;
}

/** The narrow control-token view the machine needs (the real ControlToken satisfies it). */
export interface HandoffControlToken {
  readonly holder: ControlParty;
  /** Instant human takeover on wall-detect. */
  reclaim(): void;
  /** Present so 5e-c can re-grant from completing; the LOCKED terminals must NEVER call it. */
  grant(to: ControlParty): void;
}

/** The event-queue view the machine mediates (the real StudioEventQueue satisfies it). */
export interface HandoffEventQueue {
  enqueue(event: { type: string; [k: string]: unknown }): void;
}

/** Injectable timers (tests fire the captured callbacks deterministically; prod uses setTimeout). */
export interface HandoffTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** The context handed to the onComplete hook — host-side; 5e-b persists the storageState origin-scoped, 5e-c re-grants. */
export interface HandoffCompletionContext {
  /** The live context's storageState at completion (host-only; never agent-facing, never logged). */
  storageState: StorageStateOut;
  /** The origin of the page where the wall was detected (the origin 5e-b scopes the persist to). */
  wallOrigin?: string;
}

export interface LoginHandoffDeps {
  controlToken: HandoffControlToken;
  eventQueue: HandoffEventQueue;
  /** Is the live page a credential context? (Host probe: isCredentialContext over page.url() + a fresh snapshot's fields.) */
  pageContext: () => Promise<boolean>;
  /** Host-only storageState read-back, for delta detection. NEVER agent-facing, NEVER logged. */
  storageState: () => Promise<StorageStateOut>;
  /** The live page URL (host-observed) — for the wall origin. A read failure ⇒ undefined ⇒ unscoped delta. */
  currentUrl?: () => string | undefined;
  /** The onComplete HOOK — 5e-b (persist origin-scoped) + 5e-c (re-grant + authenticated resume) fill it. Invoked ONLY on completion. */
  onComplete?: (ctx: HandoffCompletionContext) => void | Promise<void>;
  /** Abort deadline: no completion by then ⇒ aborted (LOCKED). */
  timeoutMs?: number;
  /** Bounded completion poll (for a no-navigation SPA login): interval + max ticks. */
  pollIntervalMs?: number;
  maxPolls?: number;
  timers?: HandoffTimers;
}

export type HandoffState = 'idle' | 'human-holding' | 'completed' | 'aborted' | 'vanished';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 60;

const defaultTimers: HandoffTimers = {
  setTimer: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h.unref === 'function') h.unref(); // never keep the host alive on the deadline alone
    return h;
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

const cookieKey = (c: StorageStateOut['cookies'][number]): string => JSON.stringify([c.name, c.domain, c.path]);

/** Whether a cookie's domain covers the wall origin's host (host-only or a leading-dot parent domain). */
function cookieMatchesOrigin(c: StorageStateOut['cookies'][number], wallOrigin: string): boolean {
  let host: string;
  try {
    host = new URL(wallOrigin).hostname;
  } catch {
    return false;
  }
  const domain = c.domain.replace(/^\./, '');
  return host === domain || host.endsWith('.' + domain);
}

/**
 * Conservative completion signal: a real NEW persisted entry vs the baseline — a cookie
 * (by name+domain+path) or a localStorage key not present before. Value changes on existing
 * entries do NOT count. Scoped to the wall origin when known (a new analytics-domain cookie
 * must not be read as "logged in"); with no known origin, any new entry counts.
 */
export function meaningfulStorageDelta(
  baseline: StorageStateOut,
  current: StorageStateOut,
  wallOrigin?: string,
): boolean {
  const baseCookies = new Set((baseline.cookies ?? []).map(cookieKey));
  for (const c of current.cookies ?? []) {
    if (wallOrigin && !cookieMatchesOrigin(c, wallOrigin)) continue;
    if (!baseCookies.has(cookieKey(c))) return true;
  }
  const baseLs = new Map<string, Set<string>>();
  for (const o of baseline.origins ?? []) baseLs.set(o.origin, new Set((o.localStorage ?? []).map((e) => e.name)));
  for (const o of current.origins ?? []) {
    if (wallOrigin && o.origin !== wallOrigin) continue;
    const seen = baseLs.get(o.origin) ?? new Set<string>();
    for (const e of o.localStorage ?? []) if (!seen.has(e.name)) return true;
  }
  return false;
}

export class LoginHandoff {
  private readonly deps: LoginHandoffDeps;
  private readonly timers: HandoffTimers;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  private _state: HandoffState = 'idle';
  private _signal: LoginHandoffSignal | null = null;
  private baseline: StorageStateOut | null = null;
  private wallOrigin: string | undefined;
  private deadlineHandle: unknown = null;
  private pollHandle: unknown = null;
  private pollsLeft = 0;

  constructor(deps: LoginHandoffDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? defaultTimers;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  }

  get state(): HandoffState {
    return this._state;
  }

  /** True while the human-holding login window is open — the gate the wiring uses to drop content events. */
  get active(): boolean {
    return this._state === 'human-holding';
  }

  /** The login_handoff signal the agent reads each studio_observe (in_progress / completed / failed). */
  signal(): LoginHandoffSignal | null {
    return this._signal;
  }

  /**
   * Mediate a human content event (a mark, a navigation). DROP it while the login window is
   * open — a credential-context mark name can be a displayed secret, and the agent must not
   * see the login navigations either. Outside the window it is a pass-through to the queue.
   */
  enqueueContentEvent(event: { type: string; [k: string]: unknown }): void {
    if (this.active) return; // dropped at source — never enqueued, so it can't leak now or on a later drain
    this.deps.eventQueue.enqueue(event);
  }

  /**
   * After an agent action lands, open the window IFF the agent was driving and the post-act
   * page is a credential context (a login wall just appeared). The wiring calls this from the
   * act wrapper; a human-held or non-credential outcome is a no-op.
   */
  async afterAgentAct(): Promise<void> {
    if (this._state !== 'idle') return; // already handling a handoff
    if (this.deps.controlToken.holder !== 'agent') return; // the agent was not driving (refused / reclaimed)
    if (!(await this.deps.pageContext())) return; // not a credential context — no wall
    await this.detectWall();
  }

  /** Open the human-holding window: reclaim to the human, signal in_progress, baseline storage, arm the deadline + poll. */
  async detectWall(): Promise<void> {
    if (this._state !== 'idle') return;
    this.deps.controlToken.reclaim(); // instant human takeover — the only token op the machine performs in 5e-a
    this._state = 'human-holding';
    this._signal = { state: 'in_progress', doNotRetry: true };
    this.wallOrigin = originOf(this.deps.currentUrl?.());
    this.baseline = await this.deps.storageState(); // host-only read-back; never logged
    this.arm();
  }

  /**
   * The completion check, run on each human navigation and on the bounded poll. AND-gated:
   * the page must have LEFT the credential context AND a meaningful storageState delta must
   * have appeared. Otherwise it stays human-holding (the deadline aborts if it never completes).
   */
  async checkCompletion(): Promise<void> {
    if (this._state !== 'human-holding' || this.baseline === null) return;
    if (await this.deps.pageContext()) return; // still a credential context
    const current = await this.deps.storageState();
    if (this._state !== 'human-holding') return; // a terminal raced the await
    if (!meaningfulStorageDelta(this.baseline, current, this.wallOrigin)) return; // no real new entry yet
    await this.settleCompleted(current);
  }

  /** The abort deadline fired with no completion → aborted + LOCKED. */
  onTimeout(): void {
    if (this._state !== 'human-holding') return;
    this.settleFailed('aborted');
  }

  /** The client disconnected during the window → vanished + LOCKED. */
  onClientGone(): void {
    if (this._state !== 'human-holding') return;
    this.settleFailed('vanished');
  }

  /**
   * Observe a control-token flip. A flip to the agent during the window can ONLY come from an
   * explicit human WS grant (the agent can't self-grant; the machine never grants in 5e-a) —
   * the human chose to hand back, so end the window WITHOUT a completion (the hook never fires).
   * A flip to human (incl. the machine's own reclaim) keeps the window open for the login.
   */
  onControlChange(holder: ControlParty): void {
    if (this._state === 'human-holding' && holder === 'agent') {
      this.clearTimers();
      this._state = 'idle';
      this._signal = null;
      this.baseline = null;
    }
  }

  private async settleCompleted(current: StorageStateOut): Promise<void> {
    this.clearTimers();
    this._state = 'completed';
    this._signal = { state: 'completed' };
    // 5e-b: persist the captured session origin-scoped (FUTURE reuse). 5e-c: re-grant the agent so it
    // resumes driving the LIVE, now-authenticated session (the signal above is the login_handoff:completed
    // the agent observes). The grant is in `finally`: the live context is authenticated regardless of the
    // persist outcome, so a transient persist failure must NOT strand the agent — yet the rejection still
    // propagates (a persist failure is surfaced, never silent). This re-grant is on the COMPLETING path
    // ONLY; settleFailed (abort/vanish) NEVER grants — a disconnect/timeout must not resume the agent.
    try {
      await this.deps.onComplete?.({ storageState: current, wallOrigin: this.wallOrigin });
    } finally {
      this.deps.controlToken.grant('agent');
    }
  }

  private settleFailed(state: 'aborted' | 'vanished'): void {
    this.clearTimers();
    this._state = state;
    this._signal = { state: 'failed' };
    // LOCKED: no grant, no onComplete — a disconnect/timeout must never resume the agent.
  }

  private arm(): void {
    this.deadlineHandle = this.timers.setTimer(() => this.onTimeout(), this.timeoutMs);
    this.pollsLeft = this.maxPolls;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.pollsLeft <= 0) return;
    this.pollHandle = this.timers.setTimer(() => {
      this.pollsLeft--;
      void this.checkCompletion().finally(() => {
        if (this._state === 'human-holding') this.schedulePoll();
      });
    }, this.pollIntervalMs);
  }

  private clearTimers(): void {
    if (this.deadlineHandle !== null) this.timers.clearTimer(this.deadlineHandle);
    if (this.pollHandle !== null) this.timers.clearTimer(this.pollHandle);
    this.deadlineHandle = null;
    this.pollHandle = null;
    this.pollsLeft = 0;
  }
}
