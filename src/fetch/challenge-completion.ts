import { abortRejection } from '../util/abort.js';

export interface ClearanceCookie {
  name: string;
  value: string;
  domain: string;
  expires: number;
}

/** Structural page token — the readers are injected, so this fn never imports
 *  Playwright. The concrete caller passes the live browser page. */
type PageLike = unknown;

export interface PollUntilClearedOptions {
  /** Absolute budget for the whole poll (already min()'d by the caller against
   *  the remaining signal budget). The loop never runs past this. */
  deadlineMs: number;
  /** Delay between polls. */
  intervalMs: number;
  /** True while the page still shows a challenge (markers present). Cleared is
   *  the negation of this — the real page rendered. */
  isStillChallenge: (html: string) => boolean;
  readContent: (page: PageLike) => Promise<string>;
  readCookies: (page: PageLike) => Promise<ClearanceCookie[]>;
  signal?: AbortSignal;
}

export interface PollUntilClearedResult {
  cleared: boolean;
  cookies: ClearanceCookie[];
  cfClearance?: { value: string; expires: number };
}

function findClearance(cookies: ClearanceCookie[]): { value: string; expires: number } | undefined {
  const c = cookies.find((k) => k.name === 'cf_clearance' && k.value.length > 0);
  return c ? { value: c.value, expires: c.expires } : undefined;
}

/** Poll a challenged page until it clears or the deadline / signal cuts it off.
 *
 * Cleared == the challenge markers are gone (real page rendered) OR a
 * `cf_clearance` cookie is present (authoritative pass signal — the DOM may
 * still show the interstitial mid-redirect, so the cookie wins). On cleared we
 * return the cookies + any clearance cookie for the caller to persist.
 *
 * Bounded: when the deadline elapses we return `{cleared:false}` so the caller
 * can fast-fail (no hang on an interactive / never-completing challenge). An
 * abort rejects promptly with the signal's reason, mirroring the settle race it
 * replaces. */
export async function pollUntilCleared(
  page: PageLike,
  opts: PollUntilClearedOptions,
): Promise<PollUntilClearedResult> {
  const { deadlineMs, intervalMs, isStillChallenge, readContent, readCookies, signal } = opts;
  const deadline = Date.now() + Math.max(0, deadlineMs);

  // A single abort rejection reused across ticks; races each async step so an
  // abort propagates promptly instead of after the current tick completes.
  const abort = abortRejection(signal);

  do {
    if (signal?.aborted) throw signal.reason;

    const [html, cookies] = await Promise.race([
      Promise.all([readContent(page), readCookies(page)]),
      abort,
    ]);

    const cfClearance = findClearance(cookies);
    if (cfClearance || !isStillChallenge(html)) {
      return { cleared: true, cookies, cfClearance };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining))),
      abort,
    ]);
  } while (Date.now() < deadline);

  return { cleared: false, cookies: [] };
}
