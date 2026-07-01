// Cross-engine canonical URL normalization.
//
// Pre-S11c dedup matched URLs by raw string. Two engines returning the same
// underlying page through different URL variants (utm_*, AMP, mobile
// subdomain, trailing slash, http vs https, www) surfaced as two separate
// RRF entries — over-counting consensus and starving the *actual* highest
// score of a contributor signal.
//
// canonicalizeUrl normalises the surface variants seen in the
// engine pool:
//
//   * Tracking params: utm_*, fbclid, gclid, msclkid, mc_cid, mc_eid, ref,
//     ref_src, amp (the bare ?amp=1 marker).
//   * AMP path variants: /amp/foo, /foo/amp/, /foo.amp.
//   * Mobile subdomains: m. and mobile. (but NOT docs., api., blog., etc.).
//   * www subdomain.
//   * Protocol: http -> https.
//   * Trailing slash on non-root paths.
//
// Negative cases (must NOT merge):
//   * Different paths.
//   * Different hosts.
//   * Non-mobile subdomains.
//
// Malformed input is returned unchanged so dedup can still treat it as a
// raw-string key without throwing.

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'amp', // bare ?amp=1 marker
]);

// Subdomains that signal "mobile mirror of the same site". Collapsed into the
// bare-host form for dedup purposes. Other subdomains (docs., api., blog.,
// support., etc.) are real sub-properties and must stay distinct.
const MOBILE_SUBDOMAINS = new Set(['m', 'mobile']);

function isTrackingParam(name: string): boolean {
  if (TRACKING_PARAMS.has(name)) return true;
  return name.startsWith('utm_');
}

function stripMobileAndWww(host: string): string {
  // Strip leading www. unconditionally — it never identifies a separate site.
  let h = host.toLowerCase().replace(/^www\./, '');
  // Then strip a single leading mobile subdomain, if any.
  const firstDot = h.indexOf('.');
  if (firstDot > 0) {
    const head = h.slice(0, firstDot);
    if (MOBILE_SUBDOMAINS.has(head)) {
      h = h.slice(firstDot + 1);
    }
  }
  return h;
}

function stripAmpFromPathname(pathname: string): string {
  let p = pathname;
  // Drop leading /amp/ -> /
  if (p.startsWith('/amp/')) p = p.slice(4); // keep one leading slash
  // Drop trailing /amp or /amp/
  p = p.replace(/\/amp\/?$/i, '');
  // Drop .amp suffix on the final segment
  p = p.replace(/\.amp$/i, '');
  if (p === '') p = '/';
  return p;
}

export function canonicalizeUrl(input: string): string {
  if (!input) return input;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }

  parsed.protocol = 'https:';
  parsed.hostname = stripMobileAndWww(parsed.hostname);
  parsed.hash = '';
  if (
    (parsed.port === '80' && parsed.protocol === 'http:') ||
    (parsed.port === '443' && parsed.protocol === 'https:') ||
    parsed.port === '80' ||
    parsed.port === '443'
  ) {
    parsed.port = '';
  }

  // AMP normalisation on the path.
  parsed.pathname = stripAmpFromPathname(parsed.pathname);

  // Filter tracking params + sort the rest for stable ordering.
  const kept: Array<[string, string]> = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    if (isTrackingParam(k)) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  parsed.search = '';
  for (const [k, v] of kept) parsed.searchParams.append(k, v);

  let out = parsed.toString();
  // URL serialiser keeps the trailing slash for "/" — for non-root paths the
  // serialiser preserves what was given, so drop a trailing slash only when
  // the path is non-root and there's no query string.
  if (parsed.pathname !== '/' && parsed.search === '' && out.endsWith('/')) {
    out = out.slice(0, -1);
  } else if (parsed.pathname === '/' && parsed.search === '' && parsed.hash === '') {
    out = out.replace(/\/$/, '');
  }
  return out;
}
