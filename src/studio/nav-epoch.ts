/**
 * Slice D4/A — the per-session navigation epoch: a monotonic counter bumped on every ALLOWED committed
 * Document navigation, plus the epoch of the agent's last page-read (studio_observe). The capture handler
 * (D4/B) compares the two: a capture is REFUSED when the page navigated since the agent last observed
 * (current !== lastObserve), closing the observe-A → nav-B → capture-A capture-path TOCTOU (the agent-
 * supplied content is from a page-state the fresh credential-context check no longer reflects).
 *
 * `lastObserve` starts at a sentinel (-1), distinct from any real epoch (>= 0), so a capture BEFORE the
 * agent has ever observed the live page is stale (refused) — the agent must observe first.
 *
 * Source-AGNOSTIC: a HUMAN-initiated nav bumps too (a human page change since the agent's last observe is
 * just as stale). Bump is ALLOWED-hops-only — a guard-blocked nav did not change the page.
 */
export class NavEpoch {
  private _current = 0;
  private _lastObserve = -1;

  /** Bump on each ALLOWED committed Document hop (the NavInterceptor calls this post-guard-allow). */
  bumpNavigation(): void {
    this._current += 1;
  }

  /** Mark the current page as observed by the agent (a studio_observe page-read completed). */
  markObserved(): void {
    this._lastObserve = this._current;
  }

  get current(): number {
    return this._current;
  }

  get lastObserve(): number {
    return this._lastObserve;
  }
}
