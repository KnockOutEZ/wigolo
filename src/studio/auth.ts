import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Studio host auth helpers. The host (and `wigolo serve` when bound to a
 * non-loopback address) mints a per-launch bearer token and validates it plus
 * the Origin/Host headers on every MCP request — a DNS-rebinding defense for a
 * loopback HTTP surface that the stdio path never needed.
 */

export type AuthCheck = { ok: true } | { ok: false; reason: string };

export interface AuthRequestLike {
  headers: Record<string, string | string[] | undefined>;
}

/** Hostnames that always map back to this machine, regardless of bound host. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const BEARER_PREFIX = 'Bearer ';

/** Per-launch, URL-safe (base64url of 32 random bytes → 43 chars). */
export function mintHostToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface HostTokenResolution {
  token: string;
  /** True when no operator token was supplied and a per-launch token was minted. */
  minted: boolean;
}

/**
 * Resolve the host's bearer token. An operator-supplied token (config/env) is
 * preferred — it is stable across restarts and composes with secret managers.
 * Only when none is set do we mint a per-launch token (callers should then warn
 * that restarting invalidates existing remote clients).
 */
export function resolveHostToken(configured: string | null | undefined): HostTokenResolution {
  const trimmed = configured?.trim();
  if (trimmed) return { token: trimmed, minted: false };
  return { token: mintHostToken(), minted: true };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function checkAuth(req: AuthRequestLike, expectedToken: string): AuthCheck {
  // An empty expected token must never authenticate — a misconfiguration here
  // would otherwise let `Bearer ` (empty provided) pass timingSafeEqual.
  if (expectedToken.length === 0) return { ok: false, reason: 'no_expected_token' };
  const raw = firstHeader(req.headers.authorization);
  if (!raw) return { ok: false, reason: 'missing_bearer' };
  if (!raw.startsWith(BEARER_PREFIX)) return { ok: false, reason: 'not_bearer' };

  const provided = Buffer.from(raw.slice(BEARER_PREFIX.length));
  const expected = Buffer.from(expectedToken);
  // timingSafeEqual throws on length mismatch; a length check leaks only the
  // length of a random 256-bit token, which is not secret-bearing.
  if (provided.length !== expected.length) return { ok: false, reason: 'bad_bearer' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'bad_bearer' };
  return { ok: true };
}

/** Parse the hostname out of an Origin URL or a `host[:port]` Host header. */
function hostnameOf(value: string): string | null {
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`http://${value}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function isAllowedHost(hostname: string | null, expectedHost: string): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h === expectedHost.toLowerCase();
}

/**
 * Reject requests whose Origin (if present) or Host header points at a host
 * other than loopback or the bound host. Origin absent is allowed — non-browser
 * clients (the stdio proxy) do not send it.
 */
export function checkOriginHost(req: AuthRequestLike, expected: { host: string }): AuthCheck {
  const origin = firstHeader(req.headers.origin);
  if (origin && !isAllowedHost(hostnameOf(origin), expected.host)) {
    return { ok: false, reason: 'bad_origin' };
  }

  const host = firstHeader(req.headers.host);
  if (host && !isAllowedHost(hostnameOf(host), expected.host)) {
    return { ok: false, reason: 'bad_host' };
  }

  return { ok: true };
}
