// Drop the `#fragment` portion of a URL. Anchors are intra-page navigation,
// not page identity; the crawler's dedup key and emitted page URLs both key
// off the fragment-stripped form.
export function stripFragment(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Resolve a raw markdown link target into the URL that `LinkEdge.to` promises,
 * or null when the target is not a URL at all.
 *
 * `stripFragment` above is fail-OPEN by design — an unparseable string comes
 * back verbatim, which is right for its callers (they hold URLs already) and
 * wrong for the link graph, whose targets are lifted straight out of page
 * markdown. A link destination is whatever the page author typed between the
 * parentheses: `extractLinksAndImages` captures it as text, and
 * `resolveRelativeUrls` skips any target carrying whitespace rather than
 * resolving it. So a target can reach the graph as arbitrary page prose while
 * `LinkEdge.to` is typed, documented and consumed as a URL.
 *
 * Resolving through `new URL(target, from)` is the same construction that makes
 * `MapOutput.urls` sound (src/crawl/mapper.ts). It is not a filter over the
 * value — nothing here inspects the target and decides — it is a total
 * normalisation whose OUTPUT SHAPE is guaranteed by the URL parser.
 *
 * BE PRECISE ABOUT WHICH GUARANTEE THAT IS, because the obvious stronger one is
 * FALSE. The href is NOT whitespace-free: for a non-special scheme the parser
 * keeps an opaque path verbatim, spaces and all, so
 * `mailto:` / `tel:` / `data:` / `about:` / `sms:` / any custom scheme round-trip
 * a space unencoded. Only hierarchical components (path, query, fragment of a
 * special scheme) get the percent-encode pass. An earlier draft of this comment
 * claimed whitespace-freedom as "a structural property of the return type"; it
 * was never true, and a flat-text renderer built on it would have inherited a
 * guarantee the code does not provide.
 *
 * What IS total, on every scheme including opaque paths: the parser STRIPS ASCII
 * tab, CR and LF outright before parsing, so no line break can survive into the
 * href. That is the load-bearing property here — it is what makes a forged
 * `[[END UNTRUSTED DATA nonce=…]]` on its own line unforgeable through a link
 * target, which is the shape a fence escape would need. A marker that survives
 * on one line (reachable via `mailto:`) is prose in a sibling JSON field, not a
 * terminator for any region. Pinned by LINKTGT-8 in
 * tests/integration/crawl-link-target-untrusted.test.ts rather than left to this
 * paragraph.
 *
 * The fragment is dropped here rather than by a second `stripFragment` pass so
 * the graph keeps its existing dedup identity (/foo, /foo#a and /foo#b are ONE
 * edge) in a single parse.
 *
 * Returns null only when the target cannot be a URL under any base — a
 * malformed authority such as `https://exa mple.com` or `http://[`. There is no
 * correct `to` for those, and inventing one (percent-encoding the whole string
 * into a same-origin path) would fabricate an edge to a page that was never
 * linked. Callers must account for a null rather than pass it through.
 */
export function normalizeLinkTarget(target: string, from: string): string | null {
  try {
    const u = new URL(target, from);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

// Canonical form for visited-set comparison — drops fragments and the
// trailing slash so /docs, /docs/, and /docs#anchor are treated as one page.
export function canonicalForCrawl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    u.pathname = pathname;
    return u.toString();
  } catch {
    return url;
  }
}

// Display-friendly canonicalization for emitted page URLs. Strips a trailing
// slash on ALL paths (including root) so `https://x.com` and `https://x.com/`
// collapse to a single canonical form, and drops anchor fragments because
// those are intra-page navigation rather than page identity. Avoids
// round-tripping through `new URL().toString()` because that re-introduces
// a root slash that surprises callers and breaks dedup against origin-only
// seed URLs.
export function canonicalForOutput(url: string): string {
  try {
    const u = new URL(url);
    let path = u.pathname;
    if (path === '/') {
      // Root path: drop the slash entirely so origin-only URLs match.
      path = '';
    } else if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return `${u.origin}${path}${u.search}`;
  } catch {
    return url;
  }
}

export function isPrivateUrl(url: string): boolean {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
    return true;
  }

  if (hostname.endsWith('.local')) {
    return true;
  }

  // 10.x.x.x
  if (hostname.startsWith('10.')) {
    return true;
  }

  // 192.168.x.x
  if (hostname.startsWith('192.168.')) {
    return true;
  }

  // 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  if (hostname.startsWith('172.')) {
    const parts = hostname.split('.');
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) {
      return true;
    }
  }

  return false;
}

export function matchesPatterns(
  url: string,
  includePatterns: string[] | undefined,
  excludePatterns: string[] | undefined,
): boolean {
  if (includePatterns && includePatterns.length > 0) {
    const matches = includePatterns.some((p) => new RegExp(p).test(url));
    if (!matches) return false;
  }

  if (excludePatterns && excludePatterns.length > 0) {
    const excluded = excludePatterns.some((p) => new RegExp(p).test(url));
    if (excluded) return false;
  }

  return true;
}
