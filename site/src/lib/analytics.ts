/**
 * Umami: cookieless, no personal data, no consent banner needed. Loaded only
 * when NEXT_PUBLIC_UMAMI_ID is set, and the tag itself only counts visits on
 * the production domain, so local and preview builds send nothing.
 *
 * Framework-free so the event path can be unit-tested.
 */

export const UMAMI_ID = process.env.NEXT_PUBLIC_UMAMI_ID ?? "";
/** Umami Cloud by default; point at a self-hosted instance's script to move off it. */
export const UMAMI_SRC = process.env.NEXT_PUBLIC_UMAMI_SRC || "https://cloud.umami.is/script.js";
export const UMAMI_DOMAINS = "wigolo.app";

export const analyticsEnabled = (): boolean => UMAMI_ID.length > 0;

type Umami = { track: (name: string, data?: Record<string, string | number>) => Promise<unknown> | void };
type UmamiWindow = { umami?: Umami };

const POLL_MS = 50;

/**
 * Send one event. The tag loads after hydration, so an early call (the
 * sponsor hop fires on mount) waits for it. Resolves when the event is sent,
 * or after `timeoutMs` — whichever is first — and never rejects: the sponsor
 * hop waits on it before navigating, and must not strand a visitor when the
 * tag is blocked.
 */
export function track(
  name: string,
  data: Record<string, string | number> = {},
  timeoutMs = 800,
  win: UmamiWindow | undefined = typeof window === "undefined" ? undefined : (window as UmamiWindow),
): Promise<void> {
  if (!win || !analyticsEnabled()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(poll);
      resolve();
    };
    const deadline = setTimeout(finish, timeoutMs);
    const send = () => {
      if (!win.umami) return false;
      clearInterval(poll);
      try {
        Promise.resolve(win.umami.track(name, data)).then(finish, finish);
      } catch {
        finish();
      }
      return true;
    };
    const poll = setInterval(send, POLL_MS);
    send();
  });
}
