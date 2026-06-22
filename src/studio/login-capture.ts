/**
 * Slice 5e-b — the login-handoff onComplete fill: capture the authenticated session and persist it,
 * origin-scoped, to the opted-in named profile. Invoked ONLY on a detected completion (5e-a's
 * AND-gate: left the credential context + a meaningful storageState delta), so this never runs for
 * an abandoned/no-auth login.
 *
 * ORIGIN-SCOPE (L6a). The host-only storageState carries cookies/localStorage for EVERY origin the
 * session touched; persisting all of it would leak unrelated-origin state into the profile. We keep
 * ONLY the wall origin's state:
 *
 *   - Cookies — RFC 6265 domain-match (exact host + dotted parent-domain): keep a cookie iff the wall
 *     host would RECEIVE it, i.e. its domain (leading dot ignored) equals the wall host OR the wall
 *     host is a subdomain of it. This RETAINS the real auth cookies — host-only (`__Host-`/no Domain →
 *     domain == wall host) AND parent-dotted (`.wall.example`, shared across the family) — so reuse
 *     authenticates, while DROPPING unrelated origins (`tracker.example`) AND sibling subdomains the
 *     wall host would not receive (`api.wall.example`). Chosen over registrable-domain (eTLD+1) so we
 *     need no public-suffix dependency and stay tighter (lower leak); the wall host's own auth cookies
 *     live in exactly the kept set.
 *   - localStorage — EXACT origin (the web-platform partition): keep only the wall origin's entries.
 *
 * L3-2 (persist-side backstop to 5e-a's detection-gate): if the scoped state is empty — no wall-origin
 * cookie and no wall-origin localStorage — persist NOTHING. A no-auth profile is never written even if
 * onComplete is somehow reached without real auth (or the wall origin is unknown ⇒ scope keeps nothing).
 *
 * SECURITY: the storageState and the scoped blob are NEVER logged here (this module emits no logs);
 * the only sink is ProfileStore.set (5c), which encrypts them at rest and itself logs nothing.
 */
import type { StorageStateOut } from './session-browser.js';
import type { HandoffCompletionContext } from './handoff.js';

/** The persist seam — the real ProfileStore.set (5c) satisfies it, used as-is. */
export interface ProfilePersist {
  set(profileId: string, storageStateJson: string): Promise<void>;
}

/** RFC 6265 cookie domain-match: would a request to `wallHost` carry a cookie scoped to `cookieDomain`? */
function hostReceivesCookie(wallHost: string, cookieDomain: string): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase();
  if (!d) return false;
  const h = wallHost.toLowerCase();
  return h === d || h.endsWith('.' + d);
}

/**
 * Keep only the wall origin's cookies (RFC-6265 domain-match) + localStorage (exact origin); drop the
 * rest. An undefined/invalid `wallOrigin` ⇒ nothing matches ⇒ empty (the L3-2 backstop then blocks persist).
 */
export function scopeStorageStateToOrigin(state: StorageStateOut, wallOrigin: string | undefined): StorageStateOut {
  let wallHost: string | undefined;
  let originStr: string | undefined;
  try {
    const u = new URL(wallOrigin ?? '');
    wallHost = u.hostname;
    originStr = u.origin;
  } catch {
    /* no/invalid wall origin → scope keeps nothing */
  }
  if (!wallHost) return { cookies: [], origins: [] };
  const host = wallHost;
  return {
    cookies: (state.cookies ?? []).filter((c) => hostReceivesCookie(host, c.domain ?? '')),
    origins: (state.origins ?? []).filter((o) => o.origin === originStr),
  };
}

/** True when there is nothing worth persisting — no cookies and no localStorage entries. */
export function isEmptyStorageState(state: StorageStateOut): boolean {
  const noCookies = (state.cookies ?? []).length === 0;
  const noLocalStorage = (state.origins ?? []).every((o) => (o.localStorage ?? []).length === 0);
  return noCookies && noLocalStorage;
}

/**
 * Build the onComplete hook: on a detected login completion, origin-scope the captured storageState to
 * the wall origin and persist it to the opted-in named profile — UNLESS the scoped state is empty
 * (L3-2 backstop), in which case nothing is persisted.
 */
export function createLoginCapture(deps: {
  profilePersist: ProfilePersist;
  profileId: string;
}): (ctx: HandoffCompletionContext) => Promise<void> {
  return async (ctx: HandoffCompletionContext): Promise<void> => {
    const scoped = scopeStorageStateToOrigin(ctx.storageState, ctx.wallOrigin);
    if (isEmptyStorageState(scoped)) return; // no wall-origin auth captured → never persist a no-auth profile
    await deps.profilePersist.set(deps.profileId, JSON.stringify(scoped));
  };
}
