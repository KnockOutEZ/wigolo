import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stackoverflowExtractor } from '../../../../src/extraction/site-extractors/stackoverflow.js';

const fixturesDir = join(import.meta.dirname, '../../../fixtures/site-extractors');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

const SO_HTML = loadFixture('stackoverflow-question.html');

describe('stackoverflowExtractor.canHandle', () => {
  it('matches stackoverflow.com URLs', () => {
    expect(stackoverflowExtractor.canHandle('https://stackoverflow.com/questions/958908/how-do-i-reverse')).toBe(true);
  });

  it('matches stackexchange.com subdomains', () => {
    expect(stackoverflowExtractor.canHandle('https://superuser.stackexchange.com/questions/123/something')).toBe(true);
  });

  it('matches meta.stackoverflow.com', () => {
    expect(stackoverflowExtractor.canHandle('https://meta.stackoverflow.com/questions/456/meta-thing')).toBe(true);
  });

  it('does not match GitHub URLs', () => {
    expect(stackoverflowExtractor.canHandle('https://github.com/owner/repo/issues/1')).toBe(false);
  });

  it('does not match arbitrary URLs mentioning stackoverflow in path', () => {
    expect(stackoverflowExtractor.canHandle('https://example.com/stackoverflow/something')).toBe(false);
  });
});

describe('stackoverflowExtractor — question extraction', () => {
  const url = 'https://stackoverflow.com/questions/958908/how-do-i-reverse-a-string-in-javascript';

  it('returns a non-null result', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url);
    expect(result).not.toBeNull();
  });

  it('sets extractor to site-specific', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.extractor).toBe('site-specific');
  });

  it('extracts the question title', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.title).toContain('How do I reverse a string in JavaScript?');
  });

  it('includes tags in markdown', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.markdown).toContain('javascript');
    expect(result.markdown).toContain('string');
    expect(result.markdown).toContain('reverse');
  });

  it('includes vote count in markdown', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.markdown).toContain('1542');
  });

  it('includes question body in markdown', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.markdown).toContain('Hello World');
  });

  it('preserves code blocks in question body', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.markdown).toContain('console.log(str)');
  });
});

describe('stackoverflowExtractor — answers', () => {
  const url = 'https://stackoverflow.com/questions/958908/how-do-i-reverse-a-string-in-javascript';

  it('marks accepted answer', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.markdown).toContain('Accepted Answer');
  });

  it('includes accepted answer vote count', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.markdown).toContain('2103');
  });

  it('accepted answer appears first regardless of DOM order', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    const acceptedIdx = result.markdown.indexOf('Accepted Answer');
    const firstAnswerIdx = result.markdown.indexOf('## Answer');
    expect(acceptedIdx).toBeLessThan(firstAnswerIdx);
  });

  it('includes content from accepted answer', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.markdown).toContain('reverseString');
  });

  it('includes content from non-accepted answers', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.markdown).toContain('Array.from');
  });

  it('non-accepted answers are sorted by votes descending', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    const idx487 = result.markdown.indexOf('487');
    const idx112 = result.markdown.indexOf('112');
    expect(idx487).toBeLessThan(idx112);
  });

  it('preserves code blocks in answers', () => {
    const result = stackoverflowExtractor.extract(SO_HTML, url)!;
    expect(result.markdown).toContain("split('')");
  });
});

describe('stackoverflowExtractor — edge cases', () => {
  it('returns null for empty HTML', () => {
    const result = stackoverflowExtractor.extract('', 'https://stackoverflow.com/questions/1/test');
    expect(result).toBeNull();
  });

  it('returns null for HTML with no recognizable SO structure', () => {
    const result = stackoverflowExtractor.extract(
      '<html><body><p>Nothing here</p></body></html>',
      'https://stackoverflow.com/questions/1/test',
    );
    expect(result).toBeNull();
  });
});
