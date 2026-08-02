import { readFileSync } from 'node:fs';
import { tokenMatches } from '../admin-token.js';

/**
 * Trim a raw token value; empty or whitespace-only → null. This is THE single
 * predicate for "token configured" — an empty `WIGOLO_API_TOKEN` counts as
 * unconfigured on both the bind gate and the request gate.
 */
export function normalizeToken(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the configured API token. `WIGOLO_API_TOKEN` env wins; otherwise the
 * trimmed contents of the file at `WIGOLO_API_TOKEN_FILE` (the standard
 * docker/systemd secret pattern). A missing/unreadable file → null (fail
 * closed). One rule, test-pinned.
 */
export function resolveApiToken(): string | null {
  const envToken = normalizeToken(process.env.WIGOLO_API_TOKEN);
  if (envToken) return envToken;

  const filePath = normalizeToken(process.env.WIGOLO_API_TOKEN_FILE);
  if (filePath) {
    try {
      return normalizeToken(readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Whether a bind host is loopback. TRUE only for 127.0.0.0/8 dotted literals,
 * the IPv6 loopback forms (`::1`, `[::1]`, `0:0:0:0:0:0:0:1`), and the literal
 * `localhost`. Everything else — `0.0.0.0`, `::`, empty, any hostname, any
 * LAN/public IP — is non-loopback. No DNS resolution: unknown = non-loopback
 * (fail closed).
 */
export function isLoopbackBind(host: string): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1' || h === '[::1]' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

export interface BindGateInput {
  host: string;
  token: string | null;
  allowUnauthenticated: boolean;
}

export type BindGateResult = { ok: true } | { ok: false; message: string };

/**
 * Bind-time fail-closed gate. A non-loopback bind with no configured token and
 * no explicit override refuses to start. The message names both the token env
 * var and the override so the operator can act.
 */
export function evaluateBindGate(input: BindGateInput): BindGateResult {
  const loopback = isLoopbackBind(input.host);
  if (loopback || input.token || input.allowUnauthenticated) {
    return { ok: true };
  }
  return {
    ok: false,
    message:
      `Refusing to start: binding to a non-loopback address (${input.host}) with no API token. ` +
      `Set WIGOLO_API_TOKEN (or WIGOLO_API_TOKEN_FILE) to require a bearer token, ` +
      `or pass --allow-unauthenticated (or WIGOLO_SERVE_ALLOW_UNAUTHENTICATED=1) to opt into open remote access.`,
  };
}

export interface AuthContext {
  /** The configured API token, or null (open mode). */
  token: string | null;
  /** Whether the daemon is bound to a loopback address. */
  bindIsLoopback: boolean;
  /** Whether the operator opted into open remote access. */
  allowUnauthenticated: boolean;
  /** The daemon's configured bind host, for the open-mode Host allowlist. */
  bindHost?: string;
}

export interface RequestAuthInput {
  hostHeader: string | undefined;
  originHeader: string | undefined;
  authHeader: string | undefined;
}

export type AuthResult =
  | { allow: true }
  | { allow: false; status: 401 | 403; reason: string; hint?: string };

function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  return authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null;
}

/** Strip the :port suffix from a Host header, preserving IPv6 brackets. */
function hostOnly(hostHeader: string): string {
  return hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
}

function isAllowedHost(hostHeader: string | undefined, bindHost: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostOnly(hostHeader);
  const allow = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (bindHost) allow.add(bindHost);
  return allow.has(host);
}

/**
 * Request-time auth gate, two modes:
 *   - Token mode (token configured): Bearer required (constant-time compare);
 *     Host allowlist SKIPPED, Origin ignored. Missing/wrong → 401.
 *   - Open mode (no token):
 *       - loopback bind: Host allowlist → Origin-reject → allow.
 *       - non-loopback + override: Host allowlist SKIPPED, Origin-reject KEPT.
 */
export function checkAuth(ctx: AuthContext, req: RequestAuthInput): AuthResult {
  if (ctx.token) {
    const provided = bearerToken(req.authHeader);
    if (!tokenMatches(ctx.token, provided)) {
      return {
        allow: false,
        status: 401,
        reason: 'unauthorized',
        hint: 'Provide a valid "Authorization: Bearer <token>" header. The token is set via WIGOLO_API_TOKEN (or WIGOLO_API_TOKEN_FILE).',
      };
    }
    return { allow: true };
  }

  // Open mode.
  const skipHost = !ctx.bindIsLoopback && ctx.allowUnauthenticated;
  if (!skipHost && !isAllowedHost(req.hostHeader, ctx.bindHost)) {
    return {
      allow: false,
      status: 403,
      reason: 'host_not_allowed',
      hint: 'Request Host is not on the loopback allowlist. Set WIGOLO_API_TOKEN to serve remote hosts.',
    };
  }
  if (req.originHeader !== undefined) {
    return {
      allow: false,
      status: 403,
      reason: 'origin_not_allowed',
      hint: 'Browser-origin requests are not supported on this API. Use a server-side or CLI client.',
    };
  }
  return { allow: true };
}
