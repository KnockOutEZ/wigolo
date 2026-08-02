/**
 * Credential handling for the opt-in proxy / challenge-solver / reader-service
 * URLs. These URLs may embed inline `user:pass@` credentials. We NEVER persist
 * that credential to config.json (a world-readable-ish file). Instead the
 * userinfo is split off and stashed in the OS keychain; config.json keeps only
 * the credential-free host URL, and the full URL is re-composed at resolve time.
 *
 * This module holds the pure string transforms + the stable naming; the
 * keychain read/write side-effects live in persisted-config (write path) and
 * config (resolve path) so those seams stay testable with an injected keychain.
 */

/** Settings keys whose values are URLs that may carry inline credentials. */
export const CREDENTIAL_URL_KEYS = new Set<string>(['proxyUrl', 'solverUrl', 'hostedReaderUrl']);

/** The keychain `user` (entry name) under which a field's userinfo is stored. */
export function credentialKeychainUser(settingsKey: string): string {
  return `${settingsKey}-cred`;
}

/** Playwright's structured proxy launch option. */
export interface PlaywrightProxyOption {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Build Playwright's structured `proxy` launch option from the resolved proxy
 * URL. Credentials are passed as `username`/`password` fields — NEVER inline in
 * the `server` string — so they don't leak into the browser child's process
 * args / environment. Returns undefined when the proxy is off, unset, or
 * unparseable (fail-safe: no proxy rather than a broken launch).
 */
export function playwrightProxyOption(
  proxyUrl: string | null,
  useProxy: boolean,
): PlaywrightProxyOption | undefined {
  if (!useProxy || !proxyUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return undefined;
  }
  const { username, password } = parsed;
  parsed.username = '';
  parsed.password = '';
  const opt: PlaywrightProxyOption = { server: parsed.toString() };
  if (username) opt.username = decodeURIComponent(username);
  if (password) opt.password = decodeURIComponent(password);
  return opt;
}

export interface SplitResult {
  /** The URL with any inline userinfo removed. Unchanged input if unparseable. */
  bareUrl: string;
  /** The `user:pass` (or `user`) string, or null when there was none. */
  userinfo: string | null;
}

/**
 * Split inline `user:pass@` userinfo out of a URL. Returns the credential-free
 * URL plus the raw userinfo (percent-encoded exactly as it appeared). An
 * unparseable input is returned unchanged with `userinfo: null` — the caller
 * decides how to treat a value we couldn't parse.
 */
export function splitUserinfo(raw: string): SplitResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { bareUrl: raw, userinfo: null };
  }
  const { username, password } = parsed;
  if (!username && !password) {
    return { bareUrl: parsed.toString(), userinfo: null };
  }
  const userinfo = password ? `${username}:${password}` : username;
  parsed.username = '';
  parsed.password = '';
  return { bareUrl: parsed.toString(), userinfo };
}

/**
 * Re-compose a bare URL with the given `user:pass` (or `user`) userinfo.
 * Returns the bare URL unchanged when userinfo is empty or the URL is
 * unparseable (fail-open to the credential-free URL — never throw at resolve).
 */
export function recomposeWithUserinfo(bareUrl: string, userinfo: string): string {
  if (!userinfo) return bareUrl;
  let parsed: URL;
  try {
    parsed = new URL(bareUrl);
  } catch {
    return bareUrl;
  }
  const colon = userinfo.indexOf(':');
  if (colon === -1) {
    parsed.username = userinfo;
  } else {
    parsed.username = userinfo.slice(0, colon);
    parsed.password = userinfo.slice(colon + 1);
  }
  return parsed.toString();
}
