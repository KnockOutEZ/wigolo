import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  githubExtractor,
  extractGithubBlobWithRawFallback,
} from '../../../../src/extraction/site-extractors/github.js';

const fixturesDir = join(import.meta.dirname, '../../../fixtures/site-extractors');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

const ISSUE_HTML = loadFixture('github-issue.html');
const README_HTML = loadFixture('github-readme.html');
const BLOB_MODERN_HTML = loadFixture('github-blob-modern.html');
const BLOB_TRUNCATED_HTML = loadFixture('github-blob-truncated.html');
const BLOB_LEGACY_HTML = loadFixture('github-blob-legacy.html');

describe('githubExtractor.canHandle', () => {
  it('matches GitHub issue URLs', () => {
    expect(githubExtractor.canHandle('https://github.com/owner/repo/issues/42')).toBe(true);
  });

  it('matches GitHub PR URLs', () => {
    expect(githubExtractor.canHandle('https://github.com/owner/repo/pull/7')).toBe(true);
  });

  it('matches GitHub blob URLs', () => {
    expect(githubExtractor.canHandle('https://github.com/owner/repo/blob/main/README.md')).toBe(true);
  });

  it('matches GitHub repo root (README)', () => {
    expect(githubExtractor.canHandle('https://github.com/owner/repo')).toBe(true);
  });

  it('does not match non-GitHub URLs', () => {
    expect(githubExtractor.canHandle('https://stackoverflow.com/questions/123')).toBe(false);
  });

  it('does not match URLs that merely mention github in path', () => {
    expect(githubExtractor.canHandle('https://example.com/github/stuff')).toBe(false);
  });

  it('does not match GitLab URLs', () => {
    expect(githubExtractor.canHandle('https://gitlab.com/owner/repo/issues/1')).toBe(false);
  });
});

describe('githubExtractor — issue extraction', () => {
  const url = 'https://github.com/owner/repo/issues/42';

  it('returns a non-null result', () => {
    const result = githubExtractor.extract(ISSUE_HTML, url);
    expect(result).not.toBeNull();
  });

  it('extracts the issue title', () => {
    const result = githubExtractor.extract(ISSUE_HTML, url)!;
    expect(result.title).toContain('Fix memory leak in event listener cleanup');
  });

  it('sets extractor to site-specific', () => {
    const result = githubExtractor.extract(ISSUE_HTML, url)!;
    expect(result.extractor).toBe('site-specific');
  });

  it('includes the issue body in markdown', () => {
    const result = githubExtractor.extract(ISSUE_HTML, url)!;
    expect(result.markdown).toContain('removeEventListener');
  });

  it('includes labels in markdown', () => {
    const result = githubExtractor.extract(ISSUE_HTML, url)!;
    expect(result.markdown).toContain('bug');
    expect(result.markdown).toContain('memory');
  });

  it('includes comments in markdown', () => {
    const result = githubExtractor.extract(ISSUE_HTML, url)!;
    expect(result.markdown).toContain('boundHandler');
  });

  it('produces markdown output', () => {
    const result = githubExtractor.extract(ISSUE_HTML, url)!;
    expect(result.markdown.length).toBeGreaterThan(50);
  });
});

describe('githubExtractor — PR extraction', () => {
  const url = 'https://github.com/owner/repo/pull/7';

  it('returns non-null result for PR URL', () => {
    const result = githubExtractor.extract(ISSUE_HTML, url);
    expect(result).not.toBeNull();
  });

  it('includes body content for PR', () => {
    const result = githubExtractor.extract(ISSUE_HTML, url)!;
    expect(result.markdown.length).toBeGreaterThan(0);
  });
});

describe('githubExtractor — README extraction', () => {
  const url = 'https://github.com/owner/awesome-lib';

  it('returns a non-null result', () => {
    const result = githubExtractor.extract(README_HTML, url);
    expect(result).not.toBeNull();
  });

  it('extracts the repository title', () => {
    const result = githubExtractor.extract(README_HTML, url)!;
    expect(result.title).toContain('awesome-lib');
  });

  it('includes README content in markdown', () => {
    const result = githubExtractor.extract(README_HTML, url)!;
    expect(result.markdown).toContain('awesome-lib');
    expect(result.markdown).toContain('Installation');
  });

  it('includes features section', () => {
    const result = githubExtractor.extract(README_HTML, url)!;
    expect(result.markdown).toContain('Zero dependencies');
  });

  it('sets extractor to site-specific', () => {
    const result = githubExtractor.extract(README_HTML, url)!;
    expect(result.extractor).toBe('site-specific');
  });
});

describe('githubExtractor — modern blob (embedded React payload)', () => {
  const url = 'https://github.com/sindresorhus/is/blob/main/source/index.ts';

  it('returns a non-null result from the embedded payload', () => {
    const result = githubExtractor.extract(BLOB_MODERN_HTML, url);
    expect(result).not.toBeNull();
  });

  it('extracts the FULL file content from rawLines, not a ~500-char stub', () => {
    const result = githubExtractor.extract(BLOB_MODERN_HTML, url)!;
    // The bug produced a ~500-char stub. The real file content is > 2000 chars.
    expect(result.markdown.length).toBeGreaterThan(1500);
  });

  it('includes real source lines from the embedded payload', () => {
    const result = githubExtractor.extract(BLOB_MODERN_HTML, url)!;
    expect(result.markdown).toContain('import type {');
    expect(result.markdown).toContain('primitiveTypeNames');
  });

  it('wraps code in a fenced block tagged with the payload language', () => {
    const result = githubExtractor.extract(BLOB_MODERN_HTML, url)!;
    expect(result.markdown).toContain('```typescript');
    expect(result.markdown.trimEnd().endsWith('```')).toBe(true);
  });

  it('uses the file display name as the title', () => {
    const result = githubExtractor.extract(BLOB_MODERN_HTML, url)!;
    expect(result.title).toContain('index.ts');
  });

  it('sets extractor to site-specific', () => {
    const result = githubExtractor.extract(BLOB_MODERN_HTML, url)!;
    expect(result.extractor).toBe('site-specific');
  });
});

describe('githubExtractor — legacy blob (server-rendered selectors)', () => {
  const url = 'https://github.com/acme/legacy-repo/blob/v1/config.yml';

  it('still extracts via the old .highlight / blob-code selectors', () => {
    const result = githubExtractor.extract(BLOB_LEGACY_HTML, url);
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('port: 8080');
    expect(result!.markdown).toContain('host: localhost');
  });

  it('sets extractor to site-specific', () => {
    const result = githubExtractor.extract(BLOB_LEGACY_HTML, url)!;
    expect(result.extractor).toBe('site-specific');
  });
});

describe('extractGithubBlobWithRawFallback — raw.githubusercontent fallback', () => {
  const truncatedUrl = 'https://github.com/acme/repo/blob/main/big-data.json';
  const modernUrl = 'https://github.com/sindresorhus/is/blob/main/source/index.ts';

  it('fires the injected raw fetch when the payload is TRUNCATED and returns its content', async () => {
    const rawBody = '{"huge":"' + 'x'.repeat(5000) + '"}';
    const fetchImpl = vi.fn().mockResolvedValue(rawBody);

    const result = await extractGithubBlobWithRawFallback(BLOB_TRUNCATED_HTML, truncatedUrl, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // URL transformed to the raw host with owner/repo/ref/path preserved.
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/acme/repo/main/big-data.json',
    );
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('x'.repeat(5000));
    expect(result!.markdown.length).toBeGreaterThan(4000);
  });

  it('fires the raw fetch when the embedded payload is ABSENT (blob URL, no script tag)', async () => {
    const bareBlobHtml = '<html><body><div class="react-app"></div></body></html>';
    const fetchImpl = vi.fn().mockResolvedValue('line-one\nline-two\n');

    const result = await extractGithubBlobWithRawFallback(bareBlobHtml, modernUrl, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/sindresorhus/is/main/source/index.ts',
    );
    expect(result!.markdown).toContain('line-one');
  });

  it('NEGATIVE: a COMPLETE payload never triggers the network fallback (no double-fetch)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue('SHOULD NOT BE USED');

    const result = await extractGithubBlobWithRawFallback(BLOB_MODERN_HTML, modernUrl, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    // The content is the embedded payload, never the mocked raw body.
    expect(result!.markdown).toContain('import type {');
    expect(result!.markdown).not.toContain('SHOULD NOT BE USED');
  });

  it('NEGATIVE: a legacy blob (old selectors) extracts locally, no network fallback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue('SHOULD NOT BE USED');

    const result = await extractGithubBlobWithRawFallback(
      BLOB_LEGACY_HTML,
      'https://github.com/acme/legacy-repo/blob/v1/config.yml',
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result!.markdown).toContain('port: 8080');
  });

  it('returns null when the payload is truncated AND the raw fetch fails (no crash)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    const result = await extractGithubBlobWithRawFallback(BLOB_TRUNCATED_HTML, truncatedUrl, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });
});

describe('githubExtractor — edge cases', () => {
  it('returns null for empty HTML', () => {
    const result = githubExtractor.extract('', 'https://github.com/owner/repo/issues/1');
    expect(result).toBeNull();
  });

  it('returns null for HTML with no recognizable GitHub structure', () => {
    const result = githubExtractor.extract('<html><body><p>Nothing here</p></body></html>', 'https://github.com/owner/repo/issues/1');
    expect(result).toBeNull();
  });
});
