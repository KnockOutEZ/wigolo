export function isPrivateUrl(url: string): boolean {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
    return true;
  }

  if (hostname.endsWith('.local')) {
    return true;
  }

  // 10.x.x.x
  if (hostname.startsWith('10.')) {
    return true;
  }

  // 192.168.x.x
  if (hostname.startsWith('192.168.')) {
    return true;
  }

  // 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  if (hostname.startsWith('172.')) {
    const parts = hostname.split('.');
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) {
      return true;
    }
  }

  return false;
}

export function matchesPatterns(
  url: string,
  includePatterns: string[] | undefined,
  excludePatterns: string[] | undefined,
): boolean {
  if (includePatterns && includePatterns.length > 0) {
    const matches = includePatterns.some((p) => new RegExp(p).test(url));
    if (!matches) return false;
  }

  if (excludePatterns && excludePatterns.length > 0) {
    const excluded = excludePatterns.some((p) => new RegExp(p).test(url));
    if (excluded) return false;
  }

  return true;
}
