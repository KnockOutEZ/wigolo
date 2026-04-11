import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubExtractor } from '../../../../src/extraction/site-extractors/github.js';

const fixturesDir = join(import.meta.dirname, '../../../fixtures/site-extractors');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

const ISSUE_HTML = loadFixture('github-issue.html');
const README_HTML = loadFixture('github-readme.html');

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
