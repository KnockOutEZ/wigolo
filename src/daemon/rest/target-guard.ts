import { guardFetchUrl, SSRF_CODES, type SsrfResult } from '../../watch/ssrf.js';
import { getConfig } from '../../config.js';

/**
 * Serve-mode SSRF target guard. Layers a remote-exposure tightening on top of
 * the standard fetch guard: under a NON-loopback bind, loopback / localhost
 * literal target URLs are refused (a remote caller could otherwise probe the
 * box's own services — including this daemon's /admin — by URL). Unless
 * `WIGOLO_SERVE_ALLOW_LOCAL_TARGETS=1`. Literal check only — never claims DNS
 * rebinding coverage. Under a loopback bind, behaviour is the standard fetch
 * guard (local dev servers keep working).
 *
 * Shared seam consumed by the fetch route (T1) and every URL-bearing route +
 * the Firecrawl shim (T2/T4) — the shim cannot escape it.
 */
export function guardServeTarget(
  raw: string,
  opts: { bindIsLoopback: boolean },
): SsrfResult {
  const base = guardFetchUrl(raw, 'url', { allowPrivate: getConfig().fetchAllowPrivate });
  if (!base.ok) return base;

  if (opts.bindIsLoopback) return base;
  if (process.env.WIGOLO_SERVE_ALLOW_LOCAL_TARGETS === '1') return base;

  // Non-loopback bind: refuse loopback / localhost literal targets.
  const host = base.url.hostname.toLowerCase();
  const isLoopbackLiteral =
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0:0:0:0:0:0:0:1';

  if (isLoopbackLiteral) {
    return {
      ok: false,
      code: SSRF_CODES.PRIVATE_TARGET,
      reason: `url targets a loopback address (${host}) while the server is bound to a non-loopback interface`,
      hint: 'Remote-exposed serve mode blocks loopback/localhost targets. Set WIGOLO_SERVE_ALLOW_LOCAL_TARGETS=1 to allow them.',
    };
  }
  return base;
}
