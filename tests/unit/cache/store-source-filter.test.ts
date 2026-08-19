import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import {
  searchCacheFiltered,
  cacheContent,
} from '../../../src/cache/store.js';
import { buildContentHash, cacheIndexedDocument } from '../../../src/cache/internal-store.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { resetConfig } from '../../../src/config.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

function seedWeb(url: string, markdown: string): void {
  const raw: RawFetchResult = {
    url,
    finalUrl: url,
    html: markdown,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  const extraction: ExtractionResult = {
    title: 'Web',
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
  cacheContent(raw, extraction);
}

describe('searchCacheFiltered source/namespace', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-src-filter-'));
    process.env.WIGOLO_DATA_DIR = dir;
    resetConfig();
    initDatabase(join(dir, 'wigolo.db'));

    seedWeb('https://example.com/web-doc', '# Web\n\nshared keyword alpha');

    const path = join(dir, 'local.md');
    writeFileSync(path, '# Local\n\nshared keyword beta');
    cacheIndexedDocument({
      url: 'internal://docs/local.md',
      title: 'Local',
      markdown: '# Local\n\nshared keyword beta',
      contentHash: buildContentHash('# Local\n\nshared keyword beta'),
      namespace: 'docs',
      tags: [],
      expiresAt: null,
      extractorUsed: 'index:markdown',
      metadata: {},
      sourcePath: path,
      sourceRoot: dir,
    });

    const wikiPath = join(dir, 'wiki.md');
    writeFileSync(wikiPath, '# Wiki\n\nwiki keyword');
    cacheIndexedDocument({
      url: 'internal://wiki/page.md',
      title: 'Wiki',
      markdown: '# Wiki\n\nwiki keyword',
      contentHash: buildContentHash('# Wiki\n\nwiki keyword'),
      namespace: 'wiki',
      tags: [],
      expiresAt: null,
      extractorUsed: 'index:markdown',
      metadata: {},
      sourcePath: wikiPath,
      sourceRoot: dir,
    });
  });

  afterEach(() => {
    closeDatabase();
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  });

  it('source=internal returns only internal:// rows', () => {
    const rows = searchCacheFiltered({ query: 'keyword', source: 'internal' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.url.startsWith('internal://'))).toBe(true);
  });

  it('source=web excludes internal:// rows', () => {
    const rows = searchCacheFiltered({ query: 'keyword', source: 'web' });
    expect(rows.length).toBe(1);
    expect(rows[0].url).toBe('https://example.com/web-doc');
  });

  it('namespace filter narrows internal results', () => {
    const docsOnly = searchCacheFiltered({ query: 'keyword', source: 'internal', namespace: 'docs' });
    expect(docsOnly).toHaveLength(1);
    expect(docsOnly[0].url).toBe('internal://docs/local.md');

    const wikiOnly = searchCacheFiltered({ query: 'wiki', namespace: 'wiki' });
    expect(wikiOnly).toHaveLength(1);
    expect(wikiOnly[0].namespace).toBe('wiki');
  });

  it('urlPattern still works alongside source filter', () => {
    const rows = searchCacheFiltered({
      urlPattern: 'internal://wiki/*',
      source: 'internal',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('internal://wiki/page.md');
  });
});
