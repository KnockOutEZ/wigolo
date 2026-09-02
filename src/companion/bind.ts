/**
 * Bind-address policy for the Studio host and `wigolo serve`. Loopback binds are
 * unrestricted (back-compat). Binding a routable/wildcard address requires an
 * explicit opt-in and forces the auth token on — this closes the audit's
 * "unauthenticated daemon reachable on 0.0.0.0" hole. The decision is returned
 * (not thrown / printed) so callers stay testable; the CLI prints `message` and
 * exits when `ok` is false.
 */

export type BindDecision =
  | { ok: true; requireAuth: boolean }
  | { ok: false; reason: string; message: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function checkBindHost(host: string, opts: { allowRemote: boolean }): BindDecision {
  if (isLoopbackHost(host)) {
    return { ok: true, requireAuth: false };
  }
  if (!opts.allowRemote) {
    return {
      ok: false,
      reason: 'remote_bind_forbidden',
      message:
        `Refusing to bind to non-loopback host "${host}" without explicit opt-in. ` +
        'Pass --allow-remote (or set WIGOLO_STUDIO_ALLOW_REMOTE=1) to expose the host on a ' +
        'routable address; a bearer token will be required.',
    };
  }
  // Routable bind explicitly allowed → auth is mandatory.
  return { ok: true, requireAuth: true };
}
