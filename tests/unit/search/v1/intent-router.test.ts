import { describe, it, expect } from 'vitest';
import { classifyIntent, VERTICALS } from '../../../../src/search/v1/intent-router.js';

describe('classifyIntent', () => {
  describe('hint override', () => {
    it('uses hint over keyword classification', () => {
      expect(classifyIntent('latest news about react', { hint: 'general' })).toBe('general');
    });

    it('hint beats papers keyword', () => {
      expect(classifyIntent('arxiv paper on transformers', { hint: 'code' })).toBe('code');
    });

    it('hint beats docs keyword', () => {
      expect(classifyIntent('how to fix a bug', { hint: 'news' })).toBe('news');
    });
  });

  describe('papers vertical', () => {
    it('matches arxiv', () => {
      expect(classifyIntent('arxiv paper on diffusion models')).toBe('papers');
    });

    it('matches doi', () => {
      expect(classifyIntent('doi 10.1234/abc lookup')).toBe('papers');
    });

    it('matches citation', () => {
      expect(classifyIntent('citation for attention is all you need')).toBe('papers');
    });

    it('matches preprint', () => {
      expect(classifyIntent('preprint server alternatives')).toBe('papers');
    });

    it('matches pubmed', () => {
      expect(classifyIntent('pubmed query for COVID studies')).toBe('papers');
    });
  });

  describe('code vertical', () => {
    it('matches github', () => {
      expect(classifyIntent('github issue tracker')).toBe('code');
    });

    it('matches stack overflow', () => {
      expect(classifyIntent('stack overflow answer about async')).toBe('code');
    });

    it('matches stackoverflow as single token', () => {
      expect(classifyIntent('stackoverflow accepted answer')).toBe('code');
    });

    it('matches typeerror', () => {
      expect(classifyIntent('TypeError in my script')).toBe('code');
    });

    it('matches traceback', () => {
      expect(classifyIntent('python traceback exception')).toBe('code');
    });

    it('matches "pull request"', () => {
      expect(classifyIntent('opening a pull request workflow')).toBe('code');
    });

    it('matches language token adjacent to fix verb', () => {
      expect(classifyIntent('fix python regex bug')).toBe('code');
    });

    it('matches language token adjacent to error', () => {
      expect(classifyIntent('rust compile error help')).toBe('code');
    });

    it('matches "npm error"', () => {
      expect(classifyIntent('npm error code EACCES')).toBe('code');
    });
  });

  describe('docs vertical', () => {
    it('matches "how to X" without code signals', () => {
      expect(classifyIntent('how to bake sourdough')).toBe('docs');
    });

    it('matches "X tutorial"', () => {
      expect(classifyIntent('react tutorial')).toBe('docs');
    });

    it('matches "X reference"', () => {
      expect(classifyIntent('css reference')).toBe('docs');
    });

    it('matches "docs for X"', () => {
      expect(classifyIntent('docs for tailwind')).toBe('docs');
    });

    it('matches mdn', () => {
      expect(classifyIntent('mdn array.map')).toBe('docs');
    });

    it('matches "learn python" as docs (not code)', () => {
      expect(classifyIntent('learn python')).toBe('docs');
    });

    it('matches "getting started"', () => {
      expect(classifyIntent('vue getting started')).toBe('docs');
    });
  });

  describe('news vertical', () => {
    it('matches "latest"', () => {
      expect(classifyIntent('latest iphone release')).toBe('news');
    });

    it('matches "today"', () => {
      expect(classifyIntent('stock market today')).toBe('news');
    });

    it('matches "breaking"', () => {
      expect(classifyIntent('breaking story on tech layoffs')).toBe('news');
    });

    it('matches a recent year token', () => {
      expect(classifyIntent('AI conference 2025 highlights')).toBe('news');
    });

    it('hasDateBound: true forces news', () => {
      expect(classifyIntent('quantum computing', { hasDateBound: true })).toBe('news');
    });
  });

  describe('priority ordering', () => {
    it('code beats docs when both signals present', () => {
      expect(classifyIntent('how to fix TypeError in python')).toBe('code');
    });

    it('papers beats code when both signals present', () => {
      expect(classifyIntent('arxiv paper on rust GC')).toBe('papers');
    });

    it('papers beats news when both signals present', () => {
      expect(classifyIntent('latest arxiv preprint on diffusion')).toBe('papers');
    });

    it('code beats news when both signals present', () => {
      expect(classifyIntent('latest typeerror fix in python')).toBe('code');
    });

    it('docs beats news when both signals present', () => {
      expect(classifyIntent('latest react tutorial')).toBe('docs');
    });
  });

  describe('negative cases / false positives', () => {
    it('"citizen journalism" is not papers (cite substring)', () => {
      expect(classifyIntent('citizen journalism')).not.toBe('papers');
    });

    it('"going to the store" is not code (go substring)', () => {
      expect(classifyIntent('going to the store')).not.toBe('code');
    });

    it('"goose recipe" is not code', () => {
      expect(classifyIntent('goose recipe')).not.toBe('code');
    });

    it('plain "python" without verb is not code', () => {
      expect(classifyIntent('python')).toBe('general');
    });

    it('"bash scripting basics" is docs not code', () => {
      // bash is a language token but next verb is "basics" not error/fix/debug
      // however "scripting basics" doesn't trigger docs either, so general
      const result = classifyIntent('bash scripting basics');
      expect(result).not.toBe('code');
    });
  });

  describe('default / edge cases', () => {
    it('empty string is general', () => {
      expect(classifyIntent('')).toBe('general');
    });

    it('whitespace is general', () => {
      expect(classifyIntent('   ')).toBe('general');
    });

    it('falls back to general for plain queries', () => {
      expect(classifyIntent('best pizza in new york')).toBe('general');
    });

    it('handles mixed case', () => {
      expect(classifyIntent('GitHub PUll ReQUest')).toBe('code');
    });

    it('handles punctuation', () => {
      expect(classifyIntent('how to fix TypeError!')).toBe('code');
    });

    it('handles emoji', () => {
      expect(classifyIntent('latest news today 🔥')).toBe('news');
    });
  });

  describe('VERTICALS export', () => {
    it('exports all five verticals', () => {
      expect(VERTICALS).toEqual(['general', 'news', 'code', 'docs', 'papers']);
    });
  });
});
