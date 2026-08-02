/**
 * Redact a URL for logging: strip any inline credentials (user:pass@) and the
 * query string (which can carry a token or the egressed target URL). Keeps
 * scheme + host + port + path so a log line still identifies the endpoint.
 *
 * Used wherever a proxy / challenge-solver / reader-service / target URL is
 * logged so a credential-bearing or token-bearing URL never lands in logs.
 */
export function redactUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '[unparseable-url]';
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}
