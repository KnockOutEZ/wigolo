import { COMMON_NOUNS } from '../hybrid/common-nouns.js';

export interface BrandCollisionWarning {
  detected: true;
  reason: string;
  brand_domains_in_top_3: string[];
  suggested_rewrites: string[];
}

const BRAND_TLD_RE = /\.(?:co\.uk|shop|store|deals|sale|boutique|fashion|com\.au|co\.nz)$/i;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function looksBrandy(host: string): boolean {
  return BRAND_TLD_RE.test(host);
}

function isBrandCollisionProne(query: string): boolean {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 2) return false;
  return tokens.every((t) => COMMON_NOUNS.has(t.toLowerCase()));
}

function suggestRewrites(query: string): string[] {
  const q = query.trim();
  const lower = q.toLowerCase();
  // Curated rewrites for the highest-traffic collision tokens. The general
  // fallback below handles every other common noun.
  if (lower === 'next') {
    return ['Next.js framework', 'next-router library', 'JavaScript "next" framework'];
  }
  if (lower === 'core') {
    return ['.NET Core', 'wigolo core search', '"core" library'];
  }
  if (lower === 'apple') {
    return ['Apple Inc.', 'apple programming language', 'apple fruit'];
  }
  if (lower === 'mint') {
    return ['Linux Mint OS', 'mint.com finance', 'mint programming'];
  }
  // Generic disambiguation suggestions.
  return [
    `${q} framework`,
    `${q} programming`,
    `"${q}" library documentation`,
  ];
}

/**
 * Detect a brand-collision condition: the query is a common-noun token that
 * commonly clashes with a brand domain AND the top-3 results actually contain
 * a brand-domain host. Emits a structured warning with disambiguation
 * suggestions; returns null when no collision is detected.
 */
export function detectBrandCollision(
  query: string,
  topUrls: string[],
): BrandCollisionWarning | null {
  if (!isBrandCollisionProne(query)) return null;
  const top3 = topUrls.slice(0, 3);
  const brandy: string[] = [];
  for (const url of top3) {
    const host = hostOf(url);
    if (!host) continue;
    if (looksBrandy(host)) brandy.push(host);
  }
  if (brandy.length === 0) return null;
  return {
    detected: true,
    reason: `query "${query.trim()}" is a common noun that also matches brand domain(s) in the top-3`,
    brand_domains_in_top_3: brandy,
    suggested_rewrites: suggestRewrites(query),
  };
}
