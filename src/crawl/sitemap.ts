export interface SitemapEntry {
  url: string;
  lastmod?: string;
  priority?: number;
}

export function parseSitemap(xml: string): string[] {
  return parseSitemapEntries(xml).map(e => e.url);
}

export function parseSitemapEntries(xml: string): SitemapEntry[] {
  // A sitemapindex document should be parsed with parseSitemapIndex, not here
  if (xml.includes('<sitemapindex')) return [];

  if (!xml.includes('<urlset') && !xml.includes('<loc>')) return [];

  const entries: SitemapEntry[] = [];
  const urlBlocks = xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/g);
  for (const block of urlBlocks) {
    const body = block[1];
    const locMatch = body.match(/<loc>\s*([^<]+?)\s*<\/loc>/);
    if (!locMatch) continue;
    const url = locMatch[1].trim();
    if (!url) continue;

    const entry: SitemapEntry = { url };

    const lastmodMatch = body.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/);
    if (lastmodMatch) entry.lastmod = lastmodMatch[1].trim();

    const priorityMatch = body.match(/<priority>\s*([^<]+?)\s*<\/priority>/);
    if (priorityMatch) {
      const p = parseFloat(priorityMatch[1].trim());
      if (Number.isFinite(p)) entry.priority = p;
    }

    entries.push(entry);
  }

  return entries;
}

// Order URLs so the most recently modified pages survive a budget cap.
// Lastmod descending is primary; entries with no lastmod fall back to
// priority descending and then preserve input order (stable). A previous
// implementation returned URLs in document order, which most sitemaps emit
// alphabetically — useful pages got dropped at the cap.
export function sortSitemapEntries<T extends SitemapEntry>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aHasLastmod = !!a.entry.lastmod;
      const bHasLastmod = !!b.entry.lastmod;
      if (aHasLastmod !== bHasLastmod) return aHasLastmod ? -1 : 1;

      if (aHasLastmod && bHasLastmod) {
        const at = Date.parse(a.entry.lastmod!);
        const bt = Date.parse(b.entry.lastmod!);
        const aValid = Number.isFinite(at);
        const bValid = Number.isFinite(bt);
        if (aValid !== bValid) return aValid ? -1 : 1;
        if (aValid && bValid && at !== bt) return bt - at;
      }

      const ap = a.entry.priority;
      const bp = b.entry.priority;
      const aHasP = typeof ap === 'number';
      const bHasP = typeof bp === 'number';
      if (aHasP !== bHasP) return aHasP ? -1 : 1;
      if (aHasP && bHasP && ap !== bp) return (bp as number) - (ap as number);

      return a.index - b.index;
    })
    .map(x => x.entry);
}

export function parseSitemapIndex(xml: string): string[] {
  if (!xml.includes('<sitemapindex')) return [];

  const urls: string[] = [];
  const locMatches = xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g);
  for (const match of locMatches) {
    urls.push(match[1].trim());
  }
  return urls;
}

export function extractSitemapUrlFromRobots(robotsTxt: string): string[] {
  const urls: string[] = [];
  const lines = robotsTxt.split('\n');

  for (const line of lines) {
    const match = line.match(/^sitemap:\s*(.+)/i);
    if (match) {
      urls.push(match[1].trim());
    }
  }

  return urls;
}
