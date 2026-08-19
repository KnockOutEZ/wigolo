/**
 * Minimal click counter.
 *
 * Fires a single pixel at a GoatCounter `/count` endpoint. No third-party
 * script, no cookies, no local storage — so there is nothing to consent to and
 * nothing to block. Counting is entirely optional: with the endpoint unset the
 * helper is a no-op and the surrounding redirect still works.
 *
 * Configure via NEXT_PUBLIC_GOATCOUNTER_ENDPOINT, e.g.
 *   https://wigolo.goatcounter.com/count
 */

const ENDPOINT = process.env.NEXT_PUBLIC_GOATCOUNTER_ENDPOINT ?? "";

export const countingEnabled = (): boolean => ENDPOINT.length > 0;

/** How long we wait for the pixel before moving on regardless. */
const BEACON_TIMEOUT_MS = 400;

/**
 * Record one hit, resolving when the pixel settles or the timeout expires —
 * whichever comes first. Never rejects: a failed count must not strand the
 * visitor on the interstitial.
 */
export const countHit = (path: string, title: string): Promise<void> => {
  if (!countingEnabled() || typeof window === "undefined") return Promise.resolve();

  const url = new URL(ENDPOINT);
  url.searchParams.set("p", path);
  url.searchParams.set("t", title);
  url.searchParams.set("r", document.referrer);
  // Defeats any intermediate cache that would collapse repeat hits.
  url.searchParams.set("rnd", Math.random().toString(36).slice(2));

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timer = window.setTimeout(done, BEACON_TIMEOUT_MS);
    const finish = () => {
      window.clearTimeout(timer);
      done();
    };

    const pixel = new Image();
    pixel.onload = finish;
    pixel.onerror = finish;
    pixel.src = url.toString();
  });
};
