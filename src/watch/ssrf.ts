/**
 * SSRF guard for the `watch` tool — applied to both the watched URL and any
 * webhook notification URL. Pre-merge review on A1 (the stub PR) flagged
 * that the schema allowed unguarded URLs of either field; B3 closes that
 * gap before any real fetch fires.
 *
 * Reject:
 *   - non-http(s) schemes (file://, ftp://, gopher://, data:, javascript:, ...)
 *   - loopback (localhost, 127.0.0.0/8, ::1)
 *   - all-zeros (0.0.0.0)
 *   - RFC 1918 private ranges (10/8, 172.16/12, 192.168/16)
 *   - link-local (169.254/16, fe80::/10)
 *   - IPv6 unique-local (fc00::/7) and IPv6 loopback
 *
 * Accept ordinary public hostnames + their IPs. DNS rebinding is out of
 * scope — we never actually resolve here. This guard is the gate before a
 * job is persisted; a follow-up tier could re-check at fetch time, but for
 * the v0.3.0 surface the input-side guard is the documented contract.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  // Common SSRF metadata hostnames; cheap to reject by name even though the
  // IPv4 guards below would catch the canonical addresses.
  'metadata.google.internal',
]);

export interface SsrfRejection {
  ok: false;
  reason: string;
  hint: string;
}

export interface SsrfAllowed {
  ok: true;
  url: URL;
}

export type SsrfResult = SsrfAllowed | SsrfRejection;

function isLoopbackIpv4(host: string): boolean {
  // Anything in 127.0.0.0/8 — `127.x.y.z`. Also catch the broken `127.1`
  // / `2130706433` shortforms by parsing the first octet.
  if (host === '0.0.0.0') return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const o1 = Number(m[1]);
  const o2 = Number(m[2]);
  if (o1 === 127) return true;
  if (o1 === 0) return true; // 0.0.0.0/8 is reserved + commonly routes to local
  if (o1 === 10) return true; // 10.0.0.0/8
  if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
  if (o1 === 169 && o2 === 254) return true; // link-local 169.254.0.0/16
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // strip brackets if present
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1') return true;
  if (h === '::') return true;
  if (h === '0:0:0:0:0:0:0:1') return true;
  if (h === '0:0:0:0:0:0:0:0') return true;
  // link-local fe80::/10
  if (h.startsWith('fe80:') || h.startsWith('fe8') || h.startsWith('fe9') ||
      h.startsWith('fea') || h.startsWith('feb')) return true;
  // unique-local fc00::/7 — fc.. or fd..
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  // IPv4-mapped IPv6: literal dotted form (::ffff:127.0.0.1) or the
  // URL-normalized hex form Node emits (::ffff:7f00:1 for 127.0.0.1).
  const v4mappedDotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mappedDotted && isLoopbackIpv4(v4mappedDotted[1])) return true;

  const v4mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4mappedHex) {
    const high = parseInt(v4mappedHex[1], 16);
    const low = parseInt(v4mappedHex[2], 16);
    if (!Number.isNaN(high) && !Number.isNaN(low)) {
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      if (isLoopbackIpv4(dotted)) return true;
    }
  }

  // IPv4-compatible IPv6: deprecated `::a.b.c.d` form (no `ffff:` segment).
  // WHATWG URL parsing normalizes `[::127.0.0.1]` to `[::7f00:1]`, so the
  // guard must decode the bare two-hextet trailer the same way it decodes
  // the `::ffff:...` variant above. Some Linux kernels still route this
  // form to the embedded IPv4 — documented SSRF bypass class.
  const v4compatDotted = h.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4compatDotted && isLoopbackIpv4(v4compatDotted[1])) return true;

  const v4compatHex = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4compatHex) {
    const high = parseInt(v4compatHex[1], 16);
    const low = parseInt(v4compatHex[2], 16);
    if (!Number.isNaN(high) && !Number.isNaN(low)) {
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      if (isLoopbackIpv4(dotted)) return true;
    }
  }
  return false;
}

/**
 * Guard a single URL string. Returns `{ ok:true, url }` on accept, or
 * `{ ok:false, reason, hint }` on reject. Callers should pipe the reject
 * payload straight into a StageError envelope.
 */
export function guardUrl(raw: string, fieldLabel: string): SsrfResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      reason: `${fieldLabel} is required and must be a non-empty string`,
      hint: 'Pass a fully qualified http(s) URL.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      reason: `${fieldLabel} is not a valid URL`,
      hint: 'Pass a fully qualified http(s) URL (e.g. "https://example.com/path").',
    };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      reason: `${fieldLabel} uses a forbidden protocol (${parsed.protocol})`,
      hint: 'Only http: and https: are allowed.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOSTNAMES.has(host)) {
    return {
      ok: false,
      reason: `${fieldLabel} hostname is a loopback/private alias (${host})`,
      hint: 'Use a public hostname; localhost / metadata aliases are blocked.',
    };
  }

  if (isLoopbackIpv4(host)) {
    return {
      ok: false,
      reason: `${fieldLabel} resolves to a loopback / private IPv4 (${host})`,
      hint: 'Public addresses only — 10/8, 127/8, 172.16/12, 192.168/16, 169.254/16, 0.0.0.0 are blocked.',
    };
  }

  if (host.includes(':') || /^\[/.test(parsed.host)) {
    if (isPrivateIpv6(host)) {
      return {
        ok: false,
        reason: `${fieldLabel} resolves to a loopback / private IPv6 (${host})`,
        hint: 'Public addresses only — ::1, fe80::/10, fc00::/7 are blocked.',
      };
    }
  }

  return { ok: true, url: parsed };
}

/**
 * Fetch/crawl-friendly URL guard. Same as `guardUrl` but EXEMPTS loopback
 * (127.0.0.0/8, ::1) and link-local IPv6 (fe80::/10) so local dev servers
 * (localhost:3000) keep working — the `fetch` tool explicitly documents this.
 *
 * Still blocks:
 *   - non-http(s) schemes (file://, ftp://, gopher://, data:, javascript:, ...)
 *   - 0.0.0.0/8 (unspecified / commonly routes to local)
 *   - RFC 1918 private ranges (10/8, 172.16/12, 192.168/16)
 *   - CGN (100.64/10) — ISP-grade NAT, often used by ISPs to share IPv4
 *   - link-local IPv4 (169.254/16) — covers AWS/GCP/Azure metadata endpoints
 *   - IPv6 unique-local (fc00::/7)
 *   - IPv6 IPv4-mapped / IPv4-compatible forms of any of the above
 *
 * When `allowPrivate` is true (e.g. WIGOLO_FETCH_ALLOW_PRIVATE=1), private
 * LAN ranges are permitted so home users can still fetch NAS / IoT / dev
 * boxes on 192.168.x.x. Metadata IPs (169.254/16) remain blocked in all
 * modes because they're never a legitimate target for a generic fetch.
 */
export function guardFetchUrl(
  raw: string,
  fieldLabel: string,
  opts: { allowPrivate?: boolean } = {},
): SsrfResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      reason: `${fieldLabel} is required and must be a non-empty string`,
      hint: 'Pass a fully qualified http(s) URL.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      reason: `${fieldLabel} is not a valid URL`,
      hint: 'Pass a fully qualified http(s) URL (e.g. "https://example.com/path").',
    };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      reason: `${fieldLabel} uses a forbidden protocol (${parsed.protocol})`,
      hint: 'Only http: and https: are allowed.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOSTNAMES.has(host)) {
    // Loopback aliases (localhost, localhost.localdomain) are exempted
    // for fetch/crawl — the docs promise local dev servers work. Metadata
    // hostnames (metadata.google.internal etc.) stay blocked unconditionally.
    if (
      host === 'localhost' ||
      host === 'localhost.localdomain'
    ) {
      return { ok: true, url: parsed };
    }
    return {
      ok: false,
      reason: `${fieldLabel} hostname is a private / metadata alias (${host})`,
      hint: 'Use a public hostname; cloud-metadata aliases are blocked.',
    };
  }

  // 0.0.0.0 — unspecified address. Always blocked (binds to all local
  // interfaces and commonly routes to localhost when used client-side).
  if (host === '0.0.0.0') {
    return {
      ok: false,
      reason: `${fieldLabel} resolves to an unspecified IPv4 (${host})`,
      hint: 'Specify a real host; 0.0.0.0 is the unspecified address.',
    };
  }

  // Loopback 127.0.0.0/8 — explicitly allowed for fetch/crawl (local dev).
  // We can't reuse isLoopbackIpv4 here because it also matches private +
  // link-local ranges; check just the 127/8 octet ourselves.
  if (/^127\./.test(host)) {
    return { ok: true, url: parsed };
  }

  // Link-local IPv4 (169.254/16) — ALWAYS blocked. Covers AWS / GCP / Azure
  // instance metadata endpoints (169.254.169.254). Never a legitimate
  // target for a generic fetch — even when allowPrivate=true.
  if (/^169\.254\./.test(host)) {
    return {
      ok: false,
      reason: `${fieldLabel} resolves to a link-local IPv4 (${host})`,
      hint: 'Link-local addresses (169.254/16, incl. cloud metadata endpoints) are always blocked.',
    };
  }

  if (!opts.allowPrivate) {
    // RFC 1918 + CGN.
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const o1 = Number(m[1]);
      const o2 = Number(m[2]);
      if (o1 === 10) {
        return {
          ok: false,
          reason: `${fieldLabel} resolves to a private IPv4 (${host}, 10/8)`,
          hint: 'Private LAN addresses are blocked by default. Set WIGOLO_FETCH_ALLOW_PRIVATE=1 if you need to fetch a home LAN device.',
        };
      }
      if (o1 === 192 && o2 === 168) {
        return {
          ok: false,
          reason: `${fieldLabel} resolves to a private IPv4 (${host}, 192.168/16)`,
          hint: 'Private LAN addresses are blocked by default. Set WIGOLO_FETCH_ALLOW_PRIVATE=1 if you need to fetch a home LAN device.',
        };
      }
      if (o1 === 172 && o2 >= 16 && o2 <= 31) {
        return {
          ok: false,
          reason: `${fieldLabel} resolves to a private IPv4 (${host}, 172.16/12)`,
          hint: 'Private LAN addresses are blocked by default. Set WIGOLO_FETCH_ALLOW_PRIVATE=1 if you need to fetch a home LAN device.',
        };
      }
      if (o1 === 100 && o2 >= 64 && o2 <= 127) {
        return {
          ok: false,
          reason: `${fieldLabel} resolves to a CGN IPv4 (${host}, 100.64/10)`,
          hint: 'Carrier-grade NAT addresses are blocked by default. Set WIGOLO_FETCH_ALLOW_PRIVATE=1 if you need to fetch a CGN address.',
        };
      }
    }
  }

  if (host.includes(':') || /^\[/.test(parsed.host)) {
    if (isPrivateIpv6(host)) {
      return {
        ok: false,
        reason: `${fieldLabel} resolves to a loopback / private IPv6 (${host})`,
        hint: 'Public IPv6 addresses only — ::1, fe80::/10, fc00::/7 are blocked.',
      };
    }
  }

  return { ok: true, url: parsed };
}
