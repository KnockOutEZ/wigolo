import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent } from '../../src/cache/store.js';
import { _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { resetConfig } from '../../src/config.js';
import { handleIndex } from '../../src/tools/index.js';
import { handleCache } from '../../src/tools/cache.js';
import type { RawFetchResult, ExtractionResult } from '../../src/types.js';

vi.mock('../../src/embedding/background-queue.js', () => ({
  getBackgroundIndexQueue: () => ({
    enqueue: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  }),
}));

function seedWebPage(url: string, title: string, markdown: string): void {
  const raw: RawFetchResult = {
    url,
    finalUrl: url,
    html: `<html><body>${markdown}</body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  const extraction: ExtractionResult = {
    title,
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
  cacheContent(raw, extraction);
}

describe('index → cache search integration', () => {
  let dir: string;
  let docsDir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-index-int-'));
    docsDir = join(dir, 'docs');
    mkdirSync(docsDir);
    process.env.WIGOLO_DATA_DIR = dir;
    resetConfig();
    initDatabase(join(dir, 'wigolo.db'));
  });

  afterEach(() => {
    closeDatabase();
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes local markdown and finds it via cache FTS with source=internal', async () => {
    writeFileSync(join(docsDir, 'architecture.md'), '# Architecture\n\nindex tool ingestion');
    writeFileSync(join(docsDir, 'readme.md'), '# Readme\n\ngetting started');

    const indexed = await handleIndex({
      source: docsDir,
      namespace: 'docs',
      glob: '*.md',
    });
    expect(indexed.error).toBeUndefined();
    expect(indexed.indexed).toBe(2);
    expect(indexed.scanned).toBe(2);

    const internal = await handleCache({
      query: 'architecture',
      source: 'internal',
    });
    expect(internal.error).toBeUndefined();
    expect(internal.results).toHaveLength(1);
    expect(internal.results![0].url).toBe('internal://docs/architecture.md');
    expect(internal.results![0].markdown).toMatch(/index tool ingestion/);
  });

  it('source=web excludes internal documents from mixed cache', async () => {
    writeFileSync(join(docsDir, 'runbook.md'), '# Runbook\n\nrestart the service');
    seedWebPage(
      'https://example.com/runbook',
      'Web Runbook',
      '# Web Runbook\n\nrestart from the web',
    );

    await handleIndex({ source: join(docsDir, 'runbook.md'), namespace: 'wiki' });

    const webHits = await handleCache({ query: 'runbook', source: 'web' });
    expect(webHits.results?.every((r) => !r.url.startsWith('internal://'))).toBe(true);
    expect(webHits.results?.some((r) => r.url.includes('example.com'))).toBe(true);

    const internalHits = await handleCache({ query: 'runbook', source: 'internal' });
    expect(internalHits.results?.every((r) => r.url.startsWith('internal://'))).toBe(true);
    expect(internalHits.results?.[0].url).toBe('internal://wiki/runbook.md');
  });

  it('second index of unchanged directory is idempotent', async () => {
    writeFileSync(join(docsDir, 'stable.md'), '# Stable\n\nunchanged body');
    const first = await handleIndex({ source: docsDir });
    const second = await handleIndex({ source: docsDir });
    expect(first.indexed).toBe(1);
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('stats report internal vs web counts after mixed ingest', async () => {
    writeFileSync(join(docsDir, 'internal-only.md'), '# Internal\n\nlocal doc');
    seedWebPage('https://example.com/page', 'Web', '# Web\n\nremote');

    await handleIndex({ source: join(docsDir, 'internal-only.md') });

    const stats = await handleCache({ stats: true });
    expect(stats.stats?.internal_urls).toBe(1);
    expect(stats.stats?.web_urls).toBe(1);
    expect(stats.stats?.by_namespace?.docs).toBe(1);
    expect(stats.stats?.by_namespace?.web).toBe(1);
  });
});
