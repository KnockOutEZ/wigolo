/**
 * Validation shared by the remote rerank and remote embedding providers.
 *
 * Both providers accept a base URL and an optional bearer key. The rules are
 * the same, so they live here once:
 *   - the base must be a plain http(s) URL with no credentials, query or hash;
 *   - a key needs HTTPS unless the endpoint is on this machine.
 */

/** True for hostnames that never leave this machine. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

export interface RemoteEndpointOptions {
  /** Feature name used in the missing-base error, such as 'Remote reranker'. */
  label: string;
  /** Env var that holds the base URL. */
  varName: string;
  /** Env var that holds the optional key, used in the HTTPS error. */
  keyVarName: string;
  /** Resolved key value, or null when unset. */
  apiKey: string | null;
}

/**
 * Return the configured base URL without trailing slashes.
 *
 * The call throws on a missing or malformed value, and when a key would cross
 * plain HTTP to a non-loopback host.
 */
export function resolveRemoteBase(
  raw: string | null | undefined,
  options: RemoteEndpointOptions,
): string {
  const base = raw?.trim().replace(/\/+$/, '');
  if (!base) throw new Error(`${options.label} requires ${options.varName}`);
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`${options.varName} must be an http(s) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || /[?#]/.test(base)) {
    throw new Error(`${options.varName} must be an http(s) URL without credentials, query, or fragment`);
  }
  if (options.apiKey && parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`${options.keyVarName} requires HTTPS unless the endpoint is on loopback`);
  }
  return base;
}
