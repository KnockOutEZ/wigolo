/**
 * Shared SSRF host classification + navigation policy.
 *
 * Extracted from `watch/ssrf.ts` so the Studio's human-vs-agent navigation guard
 * and the `watch`/`extraction` callers share ONE classifier. The IP-bypass
 * handling (IPv4 shortforms, IPv4-mapped/compat IPv6) is ported verbatim — it is
 * security-load-bearing — but `classifyHost` returns a fine-grained category
 * (`loopback`/`private`/`link_local`/`public`) so the Studio can allow a human to
 * reach localhost/RFC1918 while STILL blocking cloud-metadata (link-local), which
 * the watch path (agent-equivalent) blocks wholesale.
 *
 * DNS rebinding is out of scope here — hostnames are classified, not resolved.
 */

export type HostCategory = 'public' | 'loopback' | 'private' | 'link_local';

export const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hostname aliases that resolve into the local/cloud-internal space. */
const HOSTNAME_CATEGORIES = new Map<string, HostCategory>([
  ['localhost', 'loopback'],
  ['localhost.localdomain', 'loopback'],
  // Cloud metadata alias for 169.254.169.254 — classify as link_local so it is
  // blocked even when private/loopback are allowed.
  ['metadata.google.internal', 'link_local'],
]);

function categorizeIpv4(host: string): HostCategory | null {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const o1 = Number(m[1]);
  const o2 = Number(m[2]);
  if (o1 === 127) return 'loopback'; // 127.0.0.0/8
  if (o1 === 0) return 'loopback'; // 0.0.0.0/8 (incl. 0.0.0.0) — reserved, commonly routes local
  if (o1 === 10) return 'private'; // 10.0.0.0/8
  if (o1 === 192 && o2 === 168) return 'private'; // 192.168.0.0/16
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return 'private'; // 172.16.0.0/12
  if (o1 === 169 && o2 === 254) return 'link_local'; // 169.254.0.0/16 (incl. cloud metadata)
  return null; // public IPv4
}

function categorizeIpv6(host: string): HostCategory | null {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return 'loopback';
  if (h === '::' || h === '0:0:0:0:0:0:0:0') return 'loopback';
  // link-local fe80::/10
  if (h.startsWith('fe80:') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    return 'link_local';
  }
  // unique-local fc00::/7 — fc.. or fd..
  if (h.startsWith('fc') || h.startsWith('fd')) return 'private';

  // IPv4-mapped IPv6: literal dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1).
  const v4mappedDotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mappedDotted) {
    const cat = categorizeIpv4(v4mappedDotted[1]);
    if (cat) return cat;
  }
  const v4mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4mappedHex) {
    const cat = categorizeIpv4(hexPairToDotted(v4mappedHex[1], v4mappedHex[2]));
    if (cat) return cat;
  }

  // IPv4-compatible IPv6: deprecated `::a.b.c.d`, normalized by WHATWG to `::7f00:1`.
  const v4compatDotted = h.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4compatDotted) {
    const cat = categorizeIpv4(v4compatDotted[1]);
    if (cat) return cat;
  }
  const v4compatHex = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4compatHex) {
    const cat = categorizeIpv4(hexPairToDotted(v4compatHex[1], v4compatHex[2]));
    if (cat) return cat;
  }

  // 6to4 (2002::/16): the gateway IPv4 is embedded in the two hextets right after
  // `2002:` (e.g. 2002:7f00:1:: -> 7f00:0001 -> 127.0.0.1). ALL of 2002::/16 is
  // 6to4, so any 2002:-prefixed address decodes; a private/metadata embedding on a
  // host with 6to4 routing reaches the embedded v4, so block it. The low hextet is
  // OPTIONAL: when the embedded v4 is x.y.0.0 the trailing zero compresses away
  // (2002:7f00:0:: normalizes to [2002:7f00::]), so default a missing low hextet to 0.
  const sixToFour = h.match(/^2002:([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?/);
  if (sixToFour) {
    const cat = categorizeIpv4(hexPairToDotted(sixToFour[1], sixToFour[2] ?? '0'));
    if (cat) return cat;
  }

  // NAT64 (64:ff9b::/96): the IPv4 is embedded in the low 32 bits — a trailing
  // dotted quad or the last two hextets (e.g. 64:ff9b::a9fe:a9fe -> 169.254.169.254).
  const nat64Dotted = h.match(/^64:ff9b::(?:.*:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (nat64Dotted) {
    const cat = categorizeIpv4(nat64Dotted[1]);
    if (cat) return cat;
  }
  const nat64Hex = h.match(/^64:ff9b::(?:[0-9a-f:]*:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64Hex) {
    const cat = categorizeIpv4(hexPairToDotted(nat64Hex[1], nat64Hex[2]));
    if (cat) return cat;
  }
  // Exotic all-zero-high-hextet forms (2002::1, 64:ff9b::1) embed 0.0.0.x and are
  // not decoded here — out of scope: no realistic private/metadata target has a
  // zero high hextet (7f00/0a00/c0a8/a9fe/ac1x are all non-zero).
  return null; // public (or unrecognized) IPv6
}

function hexPairToDotted(highHex: string, lowHex: string): string {
  const high = parseInt(highHex, 16);
  const low = parseInt(lowHex, 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return '';
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/** Classify a hostname (as `URL.hostname` gives it) into a reachability category. */
export function classifyHost(hostname: string): HostCategory {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const alias = HOSTNAME_CATEGORIES.get(h);
  if (alias) return alias;
  const v4 = categorizeIpv4(h);
  if (v4) return v4;
  if (h.includes(':')) {
    const v6 = categorizeIpv6(hostname.toLowerCase());
    if (v6) return v6;
  }
  return 'public';
}

export type NavSource = 'human' | 'agent';

export type GuardRejectCode = 'empty' | 'parse' | 'protocol' | 'blocked';

export type GuardResult =
  | { ok: true; url: URL; category: HostCategory }
  | { ok: false; code: GuardRejectCode; category?: HostCategory; host?: string; protocol?: string };

export interface GuardNavigationOptions {
  source: NavSource;
  /**
   * Allow RFC1918 private targets (10/8, 172.16/12, 192.168/16). Defaults by source:
   * human → true, agent → false. Cloud-metadata / link-local is NEVER allowed regardless.
   */
  allowPrivate?: boolean;
  /**
   * Allow loopback (127.0.0.0/8, ::1) INDEPENDENTLY of RFC1918. Defaults to the effective
   * `allowPrivate` value, so studio-nav / watch callers (which don't set it) keep their
   * loopback-follows-private semantics unchanged. The CONTENT-PATH callers set it `true` so the
   * agent can reach a local dev server (127.x) while RFC1918 stays agent-blocked.
   */
  allowLoopback?: boolean;
}

/**
 * The Studio navigation guard. Public is always allowed; cloud-metadata /
 * link-local is always blocked; loopback/private follow the source policy.
 * Returns a structured result (callers shape their own user-facing message).
 */
export function guardNavigation(raw: string, opts: GuardNavigationOptions): GuardResult {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, code: 'empty' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, code: 'parse' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, code: 'protocol', protocol: parsed.protocol };
  }

  const category = classifyHost(parsed.hostname);
  if (category === 'public') return { ok: true, url: parsed, category };

  // Cloud-metadata / IPv6 link-local: never reachable, by either party.
  if (category === 'link_local') {
    return { ok: false, code: 'blocked', category, host: parsed.hostname };
  }

  // loopback and private are gated SEPARATELY: loopback (127.x/::1) can be reachable by both
  // parties for the content path while RFC1918 stays agent-blocked. `allowLoopback` defaults to
  // the effective `allowPrivate` so studio-nav / watch (which set neither for the agent) keep
  // their current loopback-follows-private behavior.
  const allowPrivate = opts.allowPrivate ?? opts.source === 'human';
  const allowLoopback = opts.allowLoopback ?? allowPrivate;
  const permitted = category === 'loopback' ? allowLoopback : allowPrivate;
  if (permitted) return { ok: true, url: parsed, category };
  return { ok: false, code: 'blocked', category, host: parsed.hostname };
}
