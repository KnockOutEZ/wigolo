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

import { lookup as nodeLookup } from 'node:dns';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  // Common SSRF metadata hostnames; cheap to reject by name even though the
  // IPv4 guards below would catch the canonical addresses.
  'metadata.google.internal',
]);

/**
 * Stable machine-readable reason codes for a rejection. The REST error adapter
 * keys the HTTP status on these codes — never on the human-readable `reason`
 * prose (which embeds variable host values and can be reworded freely). A test
 * pins the adapter's key set against this object so wording drift can never
 * silently break status mapping.
 */
export const SSRF_CODES = {
  INVALID_URL: 'ssrf_invalid_url',
  BAD_PROTOCOL: 'ssrf_bad_protocol',
  PRIVATE_TARGET: 'ssrf_private_target',
  METADATA: 'ssrf_metadata',
} as const;

export type SsrfCode = (typeof SSRF_CODES)[keyof typeof SSRF_CODES];

export interface SsrfRejection {
  ok: false;
  code: SsrfCode;
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
      code: SSRF_CODES.INVALID_URL,
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
      code: SSRF_CODES.INVALID_URL,
      reason: `${fieldLabel} is not a valid URL`,
      hint: 'Pass a fully qualified http(s) URL (e.g. "https://example.com/path").',
    };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      code: SSRF_CODES.BAD_PROTOCOL,
      reason: `${fieldLabel} uses a forbidden protocol (${parsed.protocol})`,
      hint: 'Only http: and https: are allowed.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOSTNAMES.has(host)) {
    return {
      ok: false,
      code: host === 'metadata.google.internal' ? SSRF_CODES.METADATA : SSRF_CODES.PRIVATE_TARGET,
      reason: `${fieldLabel} hostname is a loopback/private alias (${host})`,
      hint: 'Use a public hostname; localhost / metadata aliases are blocked.',
    };
  }

  if (isLoopbackIpv4(host)) {
    return {
      ok: false,
      code: /^169\.254\./.test(host) ? SSRF_CODES.METADATA : SSRF_CODES.PRIVATE_TARGET,
      reason: `${fieldLabel} resolves to a loopback / private IPv4 (${host})`,
      hint: 'Public addresses only — 10/8, 127/8, 172.16/12, 192.168/16, 169.254/16, 0.0.0.0 are blocked.',
    };
  }

  if (host.includes(':') || /^\[/.test(parsed.host)) {
    if (isPrivateIpv6(host)) {
      return {
        ok: false,
        code: SSRF_CODES.PRIVATE_TARGET,
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
      code: SSRF_CODES.INVALID_URL,
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
      code: SSRF_CODES.INVALID_URL,
      reason: `${fieldLabel} is not a valid URL`,
      hint: 'Pass a fully qualified http(s) URL (e.g. "https://example.com/path").',
    };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      code: SSRF_CODES.BAD_PROTOCOL,
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
      code: SSRF_CODES.METADATA,
      reason: `${fieldLabel} hostname is a private / metadata alias (${host})`,
      hint: 'Use a public hostname; cloud-metadata aliases are blocked.',
    };
  }

  // 0.0.0.0 — unspecified address. Always blocked (binds to all local
  // interfaces and commonly routes to localhost when used client-side).
  if (host === '0.0.0.0') {
    return {
      ok: false,
      code: SSRF_CODES.PRIVATE_TARGET,
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
      code: SSRF_CODES.METADATA,
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
          code: SSRF_CODES.PRIVATE_TARGET,
          reason: `${fieldLabel} resolves to a private IPv4 (${host}, 10/8)`,
          hint: 'Private LAN addresses are blocked by default. Set WIGOLO_FETCH_ALLOW_PRIVATE=1 if you need to fetch a home LAN device.',
        };
      }
      if (o1 === 192 && o2 === 168) {
        return {
          ok: false,
          code: SSRF_CODES.PRIVATE_TARGET,
          reason: `${fieldLabel} resolves to a private IPv4 (${host}, 192.168/16)`,
          hint: 'Private LAN addresses are blocked by default. Set WIGOLO_FETCH_ALLOW_PRIVATE=1 if you need to fetch a home LAN device.',
        };
      }
      if (o1 === 172 && o2 >= 16 && o2 <= 31) {
        return {
          ok: false,
          code: SSRF_CODES.PRIVATE_TARGET,
          reason: `${fieldLabel} resolves to a private IPv4 (${host}, 172.16/12)`,
          hint: 'Private LAN addresses are blocked by default. Set WIGOLO_FETCH_ALLOW_PRIVATE=1 if you need to fetch a home LAN device.',
        };
      }
      if (o1 === 100 && o2 >= 64 && o2 <= 127) {
        return {
          ok: false,
          code: SSRF_CODES.PRIVATE_TARGET,
          reason: `${fieldLabel} resolves to a CGN IPv4 (${host}, 100.64/10)`,
          hint: 'Carrier-grade NAT addresses are blocked by default. Set WIGOLO_FETCH_ALLOW_PRIVATE=1 if you need to fetch a CGN address.',
        };
      }
    }
  }

  if (host.includes(':') || /^\[/.test(parsed.host)) {
    // IPv6 loopback (::1) — explicitly allowed for fetch/crawl (local dev),
    // mirroring the 127.0.0.0/8 IPv4 exemption above. This function's own
    // docstring already promised this ("EXEMPTS loopback (127.0.0.0/8,
    // ::1)"), but the exemption was never implemented for the IPv6 form — it
    // fell through to the unconditional isPrivateIpv6 check below, which
    // blocked ::1 even with allowPrivate:true. That silently broke any
    // dual-stack "localhost" (resolves to both 127.0.0.1 AND ::1 on a typical
    // host) once a caller reaches this guard with the resolved ::1 address —
    // surfaced by the fetch-time DNS-resolved re-check (guardResolvedHost /
    // guardResolvedServeTarget), which runs every resolved address back
    // through this function. Restoring the documented exemption here.
    const bracketless = host.replace(/^\[|\]$/g, '');
    if (bracketless === '::1' || bracketless === '0:0:0:0:0:0:0:1') {
      return { ok: true, url: parsed };
    }
    if (isPrivateIpv6(host)) {
      return {
        ok: false,
        code: SSRF_CODES.PRIVATE_TARGET,
        reason: `${fieldLabel} resolves to a loopback / private IPv6 (${host})`,
        hint: 'Public IPv6 addresses only — ::1, fe80::/10, fc00::/7 are blocked.',
      };
    }
  }

  return { ok: true, url: parsed };
}

/** DNS lookup shape used by {@link guardResolvedHost}; the Node default is injected in prod. */
export type LookupAll = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void,
) => void;

export type ResolveGuardResult = { ok: true } | SsrfRejection;

/**
 * Fetch-time SSRF re-check. `guardFetchUrl` validates only the LITERAL hostname,
 * so a public hostname whose DNS record points at a blocked address (cloud
 * metadata / RFC-1918 / loopback in serve mode) passes the input guard and is
 * only caught once we resolve. This resolves the host and runs EVERY resolved
 * address back through `guardFetchUrl` (an `http://<ip>/` literal), so the
 * resolved-IP policy is identical to the literal-IP policy — no drift.
 *
 * Call this right before the actual fetch (and on each redirect hop) for any
 * non-IP-literal host. For full rebinding (TOCTOU) safety the connection should
 * additionally be pinned to the validated address — a `lookup` hook / custom
 * dispatcher — which callers can layer on; this guard closes the static-record
 * bypass (the metadata-credential-theft case) on its own.
 */
/** Resolve every A/AAAA record for a host, or null on NXDOMAIN / timeout / empty. */
async function resolveAll(
  hostname: string,
  lookup?: LookupAll,
): Promise<{ address: string; family: number }[] | null> {
  const lookupFn = lookup ?? (nodeLookup as unknown as LookupAll);
  try {
    const addresses = await new Promise<{ address: string; family: number }[]>(
      (resolve, reject) => {
        lookupFn(hostname, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
      },
    );
    return addresses && addresses.length > 0 ? addresses : null;
  } catch {
    return null;
  }
}

/** Is a resolved IP a loopback address (127.0.0.0/8 or ::1)? Used for serve-mode refusal. */
function isResolvedLoopback(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  return /^127\./.test(a) || a === '::1' || a === '::ffff:127.0.0.1' || a === '0:0:0:0:0:0:0:1';
}

/**
 * Fetch-time SSRF re-check for the plain fetch/crawl policy. Resolves the host and runs EVERY
 * resolved address back through `guardFetchUrl` (as an `http://<ip>/` literal), so the resolved-IP
 * policy is identical to the literal-IP one (metadata/RFC-1918 blocked, loopback allowed for the
 * local-dev promise). A host that does not resolve is NOT a bypass — there is no IP to connect to,
 * so we fall through (`ok: true`) and let the real fetch surface the natural DNS error.
 */
export async function guardResolvedHost(
  hostname: string,
  fieldLabel: string,
  opts: { allowPrivate?: boolean; lookup?: LookupAll } = {},
): Promise<ResolveGuardResult> {
  const addresses = await resolveAll(hostname, opts.lookup);
  if (!addresses) return { ok: true };
  for (const { address, family } of addresses) {
    const ipUrl = family === 6 ? `http://[${address}]/` : `http://${address}/`;
    const res = guardFetchUrl(ipUrl, fieldLabel, { allowPrivate: opts.allowPrivate });
    if (!res.ok) {
      return {
        ...res,
        reason: `${fieldLabel} hostname (${hostname}) resolves to a blocked address (${address}) — ${res.reason}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Fetch-time SSRF re-check for serve mode. Same as {@link guardResolvedHost} but ALSO applies the
 * serve-mode loopback refusal to the resolved IPs (the resolved-IP counterpart of
 * `guardServeTarget`'s literal loopback check): under a non-loopback bind, a hostname that resolves
 * to 127.0.0.0/8 or ::1 is refused so a remote caller cannot reach the box's own services by name.
 * Unresolvable hosts fall through (no IP to connect to). `WIGOLO_SERVE_ALLOW_LOCAL_TARGETS=1`
 * restores the loopback allowance, matching `guardServeTarget`.
 */
export async function guardResolvedServeTarget(
  hostname: string,
  fieldLabel: string,
  opts: { allowPrivate?: boolean; bindIsLoopback: boolean; lookup?: LookupAll },
): Promise<ResolveGuardResult> {
  const addresses = await resolveAll(hostname, opts.lookup);
  if (!addresses) return { ok: true };
  const refuseLoopback =
    !opts.bindIsLoopback && process.env.WIGOLO_SERVE_ALLOW_LOCAL_TARGETS !== '1';
  for (const { address, family } of addresses) {
    const ipUrl = family === 6 ? `http://[${address}]/` : `http://${address}/`;
    const res = guardFetchUrl(ipUrl, fieldLabel, { allowPrivate: opts.allowPrivate });
    if (!res.ok) {
      return {
        ...res,
        reason: `${fieldLabel} hostname (${hostname}) resolves to a blocked address (${address}) — ${res.reason}`,
      };
    }
    if (refuseLoopback && isResolvedLoopback(address)) {
      return {
        ok: false,
        code: SSRF_CODES.PRIVATE_TARGET,
        reason: `${fieldLabel} hostname (${hostname}) resolves to a loopback address (${address}) while the server is bound to a non-loopback interface`,
        hint: 'Remote-exposed serve mode blocks loopback/localhost targets. Set WIGOLO_SERVE_ALLOW_LOCAL_TARGETS=1 to allow them.',
      };
    }
  }
  return { ok: true };
}
