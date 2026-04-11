export function parseSitemap(xml: string): string[] {
  // A sitemapindex document should be parsed with parseSitemapIndex, not here
  if (xml.includes('<sitemapindex')) return [];

  if (!xml.includes('<urlset') && !xml.includes('<loc>')) return [];

  const urls: string[] = [];
  const locMatches = xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g);
  for (const match of locMatches) {
    const url = match[1].trim();
    if (url) {
      urls.push(url);
    }
  }

  return urls;
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
