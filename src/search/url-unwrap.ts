// Unwrap engine-side redirect URLs (DDG /l/?uddg=, Google /url?q=) into
// the real target URL. Returns null when the input is not a wrapped
// redirect, or the wrapped value is not a usable http(s) URL.

const REDIRECT_HOSTS: Record<string, string> = {
  'duckduckgo.com': 'uddg',
  'www.duckduckgo.com': 'uddg',
  'lite.duckduckgo.com': 'uddg',
  'html.duckduckgo.com': 'uddg',
  'google.com': 'q',
  'www.google.com': 'q',
};

export function unwrapRedirect(input: string): string | null {
  if (!input) return null;
  let candidate = input;
  if (candidate.startsWith('//')) candidate = 'https:' + candidate;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  const param = REDIRECT_HOSTS[parsed.hostname];
  if (!param) return null;
  const target = parsed.searchParams.get(param);
  if (!target) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(decoded)) return null;
  try {
    new URL(decoded);
  } catch {
    return null;
  }
  return decoded;
}

export function normalizeResultUrl(input: string): string {
  const unwrapped = unwrapRedirect(input);
  return unwrapped ?? input;
}
