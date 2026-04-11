import { createHash } from 'node:crypto';
import { getDatabase } from '../cache/db.js';

export function splitIntoBlocks(markdown: string): string[] {
  if (!markdown.trim()) return [];

  const lines = markdown.split('\n');
  const headingIndices: { level: number; lineIdx: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match) {
      headingIndices.push({ level: match[1].length, lineIdx: i });
    }
  }

  // If no headings, split by double-newline (paragraph blocks)
  if (headingIndices.length === 0) {
    return markdown.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  }

  // Non-overlapping split: each heading starts a new block, ending at the next heading of ANY level
  const blocks: string[] = [];
  for (let i = 0; i < headingIndices.length; i++) {
    const start = headingIndices[i].lineIdx;
    const end = i + 1 < headingIndices.length ? headingIndices[i + 1].lineIdx : lines.length;
    blocks.push(lines.slice(start, end).join('\n').trim());
  }

  return blocks.filter(Boolean);
}

export function normalizeBlockText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hashBlock(text: string): string {
  return createHash('sha256').update(normalizeBlockText(text)).digest('hex');
}

interface PageInput {
  url: string;
  markdown: string;
}

interface PageOutput {
  url: string;
  markdown: string;
}

export function deduplicatePages(pages: PageInput[], domain?: string): PageOutput[] {
  if (pages.length <= 1) return pages.map((p) => ({ url: p.url, markdown: p.markdown }));

  // Pre-load stored boilerplate hashes for this domain
  const storedHashes = domain ? getStoredBoilerplate(domain) : [];
  const boilerplateHashes = new Set<string>(storedHashes);

  // Split each page into blocks and hash them
  const pageBlocks = pages.map((page) => ({
    url: page.url,
    blocks: splitIntoBlocks(page.markdown),
  }));

  // Count how many pages each block hash appears in
  const hashPageCount = new Map<string, number>();
  for (const page of pageBlocks) {
    const seenHashes = new Set<string>();
    for (const block of page.blocks) {
      const h = hashBlock(block);
      if (!seenHashes.has(h)) {
        seenHashes.add(h);
        hashPageCount.set(h, (hashPageCount.get(h) ?? 0) + 1);
      }
    }
  }

  // Mark hashes appearing in >50% of pages as boilerplate
  const threshold = pages.length / 2;
  for (const [hash, count] of hashPageCount) {
    if (count > threshold) {
      boilerplateHashes.add(hash);
    }
  }

  // Store updated boilerplate hashes for this domain
  if (domain) {
    storeBoilerplate(domain, Array.from(boilerplateHashes));
  }

  // Strip boilerplate blocks from each page
  return pageBlocks.map((page) => {
    const filtered = page.blocks.filter((block) => !boilerplateHashes.has(hashBlock(block)));
    return {
      url: page.url,
      markdown: filtered.join('\n\n'),
    };
  });
}

export function getStoredBoilerplate(domain: string): string[] {
  const db = getDatabase();
  const row = db.prepare('SELECT selectors FROM domain_boilerplate WHERE domain = ?').get(domain) as { selectors: string } | undefined;
  if (!row || !row.selectors) return [];
  return JSON.parse(row.selectors) as string[];
}

export function storeBoilerplate(domain: string, hashes: string[]): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO domain_boilerplate (domain, selectors, last_updated)
    VALUES (?, ?, datetime('now'))
  `).run(domain, JSON.stringify(hashes));
}
