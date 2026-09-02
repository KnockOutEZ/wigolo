/**
 * The activation gate as the dispatch surfaces see it (PX2 mini-spec §3).
 *
 * `src/account/gate.ts` owns the DECISION — six pinned steps, a pure function of
 * (state, keys, now). This file owns the SURFACE: where the state comes from,
 * how often it is re-read, and what a refusal looks like on each transport. The
 * split is deliberate. The decision must stay a pure function so every arm can
 * be forced in a unit test; the surface has to touch the disk, the clock and the
 * process, and none of that belongs inside a predicate.
 *
 * WHY THE STATE IS CACHED AT ALL. `requireActivation` is called at the top of
 * every `tools/call` and every `/v1` request. A `readFileSync` there would put
 * an unconditional disk hit on the hot path of a surface whose entire job is to
 * not be in the way. So a passing decision's state is held for
 * `ACTIVATION_RELOAD_MS` and re-read after that — mini-spec §3's "reloaded from
 * disk at most once/min", which is also what makes a long-lived daemon start
 * refusing when it crosses the grace boundary mid-flight, with no restart.
 *
 * WHY A REFUSAL IS NOT CACHED (A-222-1). Read literally, "at most once a minute"
 * would also hold a refusal for a minute — so a user who registers in another
 * terminal would keep being refused by a running server for up to 60 s, and the
 * refusal line says to go and register. The cache exists to keep a hot path
 * fast; a refusing dispatch HAS no hot path, it does no work at all. So the
 * cache covers the passing decision only, and a refused surface re-reads on
 * every call. That is what makes "register, then retry the same call, without
 * restarting the server" true rather than approximately true.
 *
 * NOTHING HERE DECIDES ANYTHING. Every branch below is `decision.ok`; the reason
 * codes and the three refusal lines come from `account/gate.ts` and are never
 * re-spelled here.
 */

import { getConfig } from '../config.js';
import { AccountStateStore, type AccountState } from '../account/state.js';
import { resolvePinnedKeys, type PinnedKey } from '../account/pinned-keys.js';
import { requireActivation, type ActivationDecision } from '../account/gate.js';

/** Mini-spec §3: in-memory activation state is re-read from disk at most this often. */
export const ACTIVATION_RELOAD_MS = 60_000;

/**
 * Everything the checker reads from the outside world. Supplied by tests so the
 * grace boundary is crossed with an injected clock instead of a real wait, and
 * so "another process registered" is a state function that changes its answer.
 */
export interface ActivationSource {
  readonly now: () => number;
  readonly readState: () => AccountState;
  readonly readKeys: () => readonly PinnedKey[];
}

export interface ActivationChecker {
  /** The current decision. Re-reads state when the cache is cold, stale, or refusing. */
  check(): ActivationDecision;
  /** Drop the cached state so the next `check()` hits the source. */
  invalidate(): void;
}

export function createActivationChecker(
  source: ActivationSource,
  reloadMs: number = ACTIVATION_RELOAD_MS,
): ActivationChecker {
  let cachedState: AccountState | null = null;
  let cachedKeys: readonly PinnedKey[] = [];
  let loadedAt = 0;

  const load = (now: number): AccountState => {
    const state = source.readState();
    cachedState = state;
    cachedKeys = source.readKeys();
    loadedAt = now;
    return state;
  };

  return {
    check(): ActivationDecision {
      const now = source.now();
      let state = cachedState;
      let justLoaded = false;
      // `now < loadedAt` catches a clock that moved backwards: treat it as stale
      // rather than holding a cache entry that can never expire.
      if (state === null || now - loadedAt >= reloadMs || now < loadedAt) {
        state = load(now);
        justLoaded = true;
      }
      let decision = requireActivation(now, { state, keys: cachedKeys });
      if (!decision.ok && !justLoaded) {
        // A refusal is never served from cache — see the header note. Re-read and
        // re-evaluate so a registration that just landed takes effect on this call.
        state = load(now);
        decision = requireActivation(now, { state, keys: cachedKeys });
      }
      return decision;
    },
    invalidate(): void {
      cachedState = null;
      loadedAt = 0;
    },
  };
}

/**
 * The source every production surface uses: the account state file under the
 * resolved data dir, and the pinned keys as the environment resolves them.
 *
 * Both are read through a function rather than captured once, because a process
 * that is refusing may be registered against WHILE it runs — the whole point of
 * the per-dispatch re-check.
 */
export function defaultActivationSource(): ActivationSource {
  return {
    now: () => Date.now(),
    readState: () => new AccountStateStore(getConfig().dataDir).read(),
    readKeys: () => resolvePinnedKeys().keys,
  };
}

let processChecker: ActivationChecker | null = null;

/**
 * The process-wide checker. One per process so the ≤1/min budget is a property
 * of the process and not of however many servers a host happens to build.
 */
export function activationChecker(): ActivationChecker {
  processChecker ??= createActivationChecker(defaultActivationSource());
  return processChecker;
}

/** Replace the process-wide checker (tests, and the daemon's own harnesses). */
export function setActivationChecker(checker: ActivationChecker | null): void {
  processChecker = checker;
}

/** The one call every gated surface makes. */
export function checkActivation(): ActivationDecision {
  return activationChecker().check();
}

/**
 * The MCP rendering of a refusal: a designed tool error, not a transport failure
 * (product law 9 — the text we return IS the interface). `isError: true` so a
 * harness renders it as a failed call rather than as a result.
 */
export function activationToolError(decision: Extract<ActivationDecision, { ok: false }>): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text: decision.message }], isError: true };
}
