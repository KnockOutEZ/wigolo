import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadManifest,
  loadFixtureHtml,
  loadGoldenMarkdown,
  runSingleBenchmark,
  filterManifestEntries,
  runBenchmark,
} from '../../../../benchmarks/extraction/runner.js';
import type { ManifestEntry, Manifest } from '../../../../benchmarks/extraction/types.js';

vi.mock('../../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ trafilatura: 'never' })),
}));

vi.mock('../../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { readFileSync, existsSync } from 'node:fs';
import { extractContent } from '../../../../src/extraction/pipeline.js';

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockExtractContent = vi.mocked(extractContent);

const sampleManifest: Manifest = {
  version: '1.0.0',
  created: '2026-04-14',
  entries: [
    {
      id: 'test-001',
      url: 'https://example.com/page1',
      category: 'article',
      htmlFixturePath: 'html/test-001.html',
      goldenPath: 'golden/test-001.md',
      expectedExtractor: 'defuddle',
    },
    {
      id: 'test-002',
      url: 'https://docs.example.com/api',
      category: 'docs',
      htmlFixturePath: 'html/test-002.html',
      goldenPath: 'golden/test-002.md',
      expectedExtractor: 'defuddle',
      tags: ['api'],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadManifest', () => {
  it('loads and parses manifest JSON', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleManifest));
    const manifest = loadManifest('/path/to/manifest.json');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.entries).toHaveLength(2);
  });

  it('throws for invalid JSON', () => {
    mockReadFileSync.mockReturnValue('not json');
    expect(() => loadManifest('/path/to/manifest.json')).toThrow();
  });

  it('throws for missing entries field', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0' }));
    expect(() => loadManifest('/path/to/manifest.json')).toThrow();
  });

  it('throws for empty entries array', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.0', entries: [] }));
    expect(() => loadManifest('/path/to/manifest.json')).toThrow();
  });
});

describe('loadFixtureHtml', () => {
  it('reads HTML file from fixtures directory', () => {
    mockReadFileSync.mockReturnValue('<html><body>test</body></html>');
    const html = loadFixtureHtml('/fixtures', 'html/test.html');
    expect(html).toContain('<html>');
  });

  it('throws when file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => loadFixtureHtml('/fixtures', 'html/missing.html')).toThrow();
  });
});

describe('loadGoldenMarkdown', () => {
  it('reads golden markdown file', () => {
    mockReadFileSync.mockReturnValue('# Title\n\nContent');
    const md = loadGoldenMarkdown('/golden', 'golden/test.md');
    expect(md).toContain('# Title');
  });

  it('throws when golden file is missing', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => loadGoldenMarkdown('/golden', 'golden/missing.md')).toThrow();
  });
});

describe('filterManifestEntries', () => {
  it('returns all entries when no filter', () => {
    const result = filterManifestEntries(sampleManifest.entries);
    expect(result).toHaveLength(2);
  });

  it('filters by category', () => {
    const result = filterManifestEntries(sampleManifest.entries, 'docs');
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('docs');
  });

  it('filters by ID substring', () => {
    const result = filterManifestEntries(sampleManifest.entries, 'test-001');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('test-001');
  });

  it('returns empty for non-matching filter', () => {
    const result = filterManifestEntries(sampleManifest.entries, 'nonexistent');
    expect(result).toHaveLength(0);
  });

  it('filters by tag', () => {
    const result = filterManifestEntries(sampleManifest.entries, 'api');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('test-002');
  });
});

describe('runSingleBenchmark', () => {
  it('returns result with metrics for successful extraction', async () => {
    const entry: ManifestEntry = {
      id: 'bench-001',
      url: 'https://example.com',
      category: 'article',
      htmlFixturePath: 'html/bench-001.html',
      goldenPath: 'golden/bench-001.md',
      expectedExtractor: 'defuddle',
    };

    const html = '<html><body><h1>Title</h1><p>Content</p></body></html>';
    const golden = '# Title\n\nContent';

    mockExtractContent.mockResolvedValue({
      title: 'Title',
      markdown: '# Title\n\nContent',
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle',
    });

    const result = await runSingleBenchmark(entry, html, golden);

    expect(result.id).toBe('bench-001');
    expect(result.extractorUsed).toBe('defuddle');
    expect(result.extractorMatch).toBe(true);
    expect(result.metrics.f1).toBeGreaterThan(0);
    expect(result.extractionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('marks extractor mismatch when wrong extractor used', async () => {
    const entry: ManifestEntry = {
      id: 'bench-002',
      url: 'https://example.com',
      category: 'article',
      htmlFixturePath: 'html/bench-002.html',
      goldenPath: 'golden/bench-002.md',
      expectedExtractor: 'defuddle',
    };

    mockExtractContent.mockResolvedValue({
      title: 'Title',
      markdown: '# Title\n\nContent',
      metadata: {},
      links: [],
      images: [],
      extractor: 'readability',
    });

    const result = await runSingleBenchmark(entry, '<html></html>', '# Title');
    expect(result.extractorMatch).toBe(false);
  });

  it('captures error when extraction throws', async () => {
    const entry: ManifestEntry = {
      id: 'bench-err',
      url: 'https://example.com',
      category: 'article',
      htmlFixturePath: 'html/err.html',
      goldenPath: 'golden/err.md',
    };

    mockExtractContent.mockRejectedValue(new Error('extraction boom'));

    const result = await runSingleBenchmark(entry, '<html></html>', '# Golden');
    expect(result.error).toBe('extraction boom');
    expect(result.metrics.f1).toBe(0);
  });

  it('handles empty HTML gracefully', async () => {
    const entry: ManifestEntry = {
      id: 'bench-empty',
      url: 'https://example.com',
      category: 'article',
      htmlFixturePath: 'html/empty.html',
      goldenPath: 'golden/empty.md',
    };

    mockExtractContent.mockResolvedValue({
      title: '',
      markdown: '',
      metadata: {},
      links: [],
      images: [],
      extractor: 'turndown',
    });

    const result = await runSingleBenchmark(entry, '', '# Expected Content');
    expect(result.metrics.recall).toBe(0);
  });

  it('records markdown lengths', async () => {
    const entry: ManifestEntry = {
      id: 'bench-len',
      url: 'https://example.com',
      category: 'article',
      htmlFixturePath: 'html/len.html',
      goldenPath: 'golden/len.md',
    };

    mockExtractContent.mockResolvedValue({
      title: 'T',
      markdown: 'Extracted content here',
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle',
    });

    const result = await runSingleBenchmark(entry, '<html></html>', 'Golden content here');
    expect(result.markdownLength).toBe('Extracted content here'.length);
    expect(result.goldenLength).toBe('Golden content here'.length);
  });
});

describe('runBenchmark', () => {
  it('throws when manifest path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(runBenchmark({
      manifestPath: '/nonexistent/manifest.json',
      fixturesDir: '/fixtures',
      goldenDir: '/golden',
      outputDir: '/output',
    })).rejects.toThrow();
  });
});
