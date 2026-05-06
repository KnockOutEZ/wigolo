const BLOCKLIST: ReadonlySet<string> = new Set([
  'elitepvpers.com',
  'zhihu.com',
  'baidu.com',
  'zhidao.baidu.com',
  'jingyan.baidu.com',
  'wenku.baidu.com',
  'tieba.baidu.com',
]);

const REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  'duckduckgo.com',
  'r.jina.ai',
]);

export function isValidCandidateUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (REDIRECT_HOSTS.has(parsed.hostname)) {
      if (parsed.hostname === 'duckduckgo.com' && parsed.pathname.startsWith('/l/')) return false;
      if (parsed.hostname === 'r.jina.ai') return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isBlocklistedDomain(u: string): boolean {
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (BLOCKLIST.has(host)) return true;
    for (const dom of BLOCKLIST) {
      if (host.endsWith(`.${dom}`)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export interface PreFilterResult<T extends { url: string }> {
  kept: T[];
  excluded: { item: T; reason: 'invalid_url' | 'blocklisted_domain' }[];
}

export function preFilterCandidates<T extends { url: string }>(items: T[]): PreFilterResult<T> {
  const kept: T[] = [];
  const excluded: PreFilterResult<T>['excluded'] = [];
  for (const it of items) {
    if (!isValidCandidateUrl(it.url)) {
      excluded.push({ item: it, reason: 'invalid_url' });
      continue;
    }
    if (isBlocklistedDomain(it.url)) {
      excluded.push({ item: it, reason: 'blocklisted_domain' });
      continue;
    }
    kept.push(it);
  }
  return { kept, excluded };
}
