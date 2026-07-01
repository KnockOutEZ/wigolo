import { describe, it, expect } from 'vitest';
import {
  classifyIntent,
  classifyIntentDetailed,
  VERTICALS,
} from '../../../../src/search/core/intent-router.js';

const NOW = new Date('2026-05-21T12:00:00.000Z');
function isoDaysAgo(days: number, now: Date = NOW): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

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

    it('does not promote a bare year token to news (no news keyword)', () => {
      // "vector database choice 2026" used to land in news → bing_news → BEST
      // Express Vietnam logistics noise. Years alone are not news intent.
      expect(classifyIntent('AI conference 2025 highlights')).toBe('general');
      expect(classifyIntent('vector database choice 2026')).toBe('general');
    });

    it('still classifies year + explicit news keyword as news', () => {
      expect(classifyIntent('AI news 2026')).toBe('news');
      expect(classifyIntent('breaking story 2025')).toBe('news');
      expect(classifyIntent('latest 2024 conference recap')).toBe('news');
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
    it('exports all six verticals (including images)', () => {
      expect(VERTICALS).toEqual([
        'general',
        'news',
        'code',
        'docs',
        'papers',
        'images',
      ]);
    });
  });
});

describe('classifyIntentDetailed', () => {
  describe('vertical parity with classifyIntent', () => {
    const cases: Array<{ q: string; hint?: 'news' | 'code' }> = [
      { q: 'latest news about react' },
      { q: 'arxiv paper on transformers' },
      { q: 'github issue tracker' },
      { q: 'how to bake sourdough' },
      { q: 'best pizza in new york' },
      { q: '' },
      { q: 'fix python regex bug' },
      { q: 'latest react tutorial' },
      { q: 'quantum computing', hint: 'news' },
    ];
    for (const c of cases) {
      it(`matches classifyIntent for "${c.q}"`, () => {
        const opts = c.hint ? { hint: c.hint } : undefined;
        const a = classifyIntent(c.q, opts);
        const b = classifyIntentDetailed(c.q, opts).vertical;
        expect(b).toBe(a);
      });
    }
  });

  describe('date hint parsing', () => {
    it('parses "between 2023 and 2024"', () => {
      const out = classifyIntentDetailed('rust news between 2023 and 2024');
      expect(out.dateHint).toEqual({
        fromDate: '2023-01-01',
        toDate: '2024-12-31',
      });
    });

    it('parses "from 2022 to 2025"', () => {
      const out = classifyIntentDetailed('papers from 2022 to 2025');
      expect(out.dateHint).toEqual({
        fromDate: '2022-01-01',
        toDate: '2025-12-31',
      });
    });

    it('parses "since 2021"', () => {
      const out = classifyIntentDetailed('changes since 2021');
      expect(out.dateHint).toEqual({ fromDate: '2021-01-01' });
    });

    it('parses "in 2024"', () => {
      const out = classifyIntentDetailed('events in 2024');
      expect(out.dateHint).toEqual({ fromDate: '2024-01-01' });
    });

    it('parses "after 2023"', () => {
      const out = classifyIntentDetailed('research after 2023');
      expect(out.dateHint).toEqual({ fromDate: '2023-01-01' });
    });

    it('parses "starting 2022"', () => {
      const out = classifyIntentDetailed('records starting 2022');
      expect(out.dateHint).toEqual({ fromDate: '2022-01-01' });
    });

    it('parses "before 2024"', () => {
      const out = classifyIntentDetailed('history before 2024');
      expect(out.dateHint).toEqual({ toDate: '2023-12-31' });
    });

    it('parses "last 30 days"', () => {
      const out = classifyIntentDetailed('articles last 30 days', { now: NOW });
      expect(out.dateHint?.fromDate).toBe(isoDaysAgo(30));
      expect(out.dateHint?.toDate).toBeUndefined();
    });

    it('parses "last 2 weeks"', () => {
      const out = classifyIntentDetailed('news last 2 weeks', { now: NOW });
      expect(out.dateHint?.fromDate).toBe(isoDaysAgo(14));
    });

    it('parses "last 3 months"', () => {
      const out = classifyIntentDetailed('updates last 3 months', { now: NOW });
      expect(out.dateHint?.fromDate).toBe(isoDaysAgo(90));
    });

    it('parses "last 1 year"', () => {
      const out = classifyIntentDetailed('releases last 1 year', { now: NOW });
      expect(out.dateHint?.fromDate).toBe(isoDaysAgo(365));
    });

    it('parses "past 5 days"', () => {
      const out = classifyIntentDetailed('news past 5 days', { now: NOW });
      expect(out.dateHint?.fromDate).toBe(isoDaysAgo(5));
    });

    it('parses "today"', () => {
      const out = classifyIntentDetailed('news today', { now: NOW });
      const todayIso = isoDaysAgo(0);
      expect(out.dateHint).toEqual({ fromDate: todayIso, toDate: todayIso });
    });

    it('parses "yesterday"', () => {
      const out = classifyIntentDetailed('news yesterday', { now: NOW });
      const y = isoDaysAgo(1);
      expect(out.dateHint).toEqual({ fromDate: y, toDate: y });
    });

    it('parses "this week"', () => {
      const out = classifyIntentDetailed('news this week', { now: NOW });
      expect(out.dateHint?.fromDate).toBe(isoDaysAgo(7));
    });

    it('parses "this month"', () => {
      const out = classifyIntentDetailed('news this month', { now: NOW });
      expect(out.dateHint?.fromDate).toBe(isoDaysAgo(30));
    });

    it('parses "this year"', () => {
      const out = classifyIntentDetailed('news this year', { now: NOW });
      expect(out.dateHint?.fromDate).toBe('2026-01-01');
    });

    it('classifies query as news + sets dateHint for "latest rust news between 2023 and 2024"', () => {
      const out = classifyIntentDetailed('latest rust news between 2023 and 2024');
      expect(out.vertical).toBe('news');
      expect(out.dateHint).toEqual({
        fromDate: '2023-01-01',
        toDate: '2024-12-31',
      });
    });

    it('first pattern wins on multiple patterns in same query', () => {
      const out = classifyIntentDetailed('between 2023 and 2024 since 2020');
      expect(out.dateHint).toEqual({
        fromDate: '2023-01-01',
        toDate: '2024-12-31',
      });
    });

    it('rejects invalid years (1800)', () => {
      const out = classifyIntentDetailed('history since 1800');
      expect(out.dateHint).toBeUndefined();
    });

    it('rejects inverted year ranges', () => {
      const out = classifyIntentDetailed('between 2024 and 2023');
      expect(out.dateHint).toBeUndefined();
    });

    it('returns no hint when no date keywords are present', () => {
      const out = classifyIntentDetailed('how to bake sourdough');
      expect(out.dateHint).toBeUndefined();
    });

    it('returns no hint for empty string', () => {
      const out = classifyIntentDetailed('');
      expect(out.dateHint).toBeUndefined();
    });
  });
});
