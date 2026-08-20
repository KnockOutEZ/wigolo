/** ASCII hostname-safe namespace: letters, digits, underscore, hyphen. */
export const VALID_NAMESPACE = /^[a-z0-9_-]+$/;

/**
 * Build an `internal://{namespace}/{posix-relative}` URL.
 * Namespace is lowercased to match `normalizeUrl`'s hostname folding.
 */
export function buildInternalUrl(namespace: string, relativePath: string): string {
  const ns = (namespace.trim() || 'docs').toLowerCase();
  if (!VALID_NAMESPACE.test(ns)) {
    throw new Error(`invalid namespace: ${JSON.stringify(namespace)}`);
  }
  const segments = relativePath
    .split(/[/\\]/)
    .filter((s) => s.length > 0 && s !== '.' && s !== '..')
    .map((s) => encodeURIComponent(s));
  return `internal://${ns}/${segments.join('/')}`;
}

/** First ATX H1, else basename without extension. */
export function titleFromMarkdown(markdown: string, fallbackBasename: string): string {
  const m = markdown.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return fallbackBasename.replace(/\.[^.]+$/, '') || fallbackBasename;
}
