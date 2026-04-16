import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BingEngine } from '../../../../src/search/engines/bing.js';
import { DuckDuckGoEngine } from '../../../../src/search/engines/duckduckgo.js';
import { StartpageEngine } from '../../../../src/search/engines/startpage.js';

describe('date parsing from search engine results', () => {
  describe('BingEngine date extraction', () => {
    const engine = new BingEngine();

    it('extracts date from snippet prefix "Jan 15, 2025 -"', () => {
      const html = `<html><body><ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://example.com/news">News Article</a></h2>
          <div class="b_caption"><p class="b_lineclamp2">Jan 15, 2025 - Breaking news about tech layoffs.</p></div>
        </li>
      </ol></body></html>`;
      const results = engine.parseResults(html, 10);
      expect(results[0].published_date).toBeDefined();
      expect(new Date(results[0].published_date!).getFullYear()).toBe(2025);
    });

    it('extracts date from snippet prefix "2025-03-20 ·"', () => {
      const html = `<html><body><ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://example.com/blog">Blog Post</a></h2>
          <div class="b_caption"><p class="b_lineclamp2">2025-03-20 · A new approach to testing.</p></div>
        </li>
      </ol></body></html>`;
      const results = engine.parseResults(html, 10);
      expect(results[0].published_date).toBeDefined();
      expect(results[0].published_date).toContain('2025-03-20');
    });

    it('extracts relative date "3 days ago"', () => {
      const html = `<html><body><ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://example.com/recent">Recent</a></h2>
          <div class="b_caption"><p class="b_lineclamp2">3 days ago - Something happened recently.</p></div>
        </li>
      </ol></body></html>`;
      const results = engine.parseResults(html, 10);
      expect(results[0].published_date).toBeDefined();
      const parsed = new Date(results[0].published_date!);
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      // Within 1 day tolerance
      expect(Math.abs(parsed.getTime() - threeDaysAgo.getTime())).toBeLessThan(86400000);
    });

    it('returns undefined for snippets without dates', () => {
      const html = `<html><body><ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://example.com/page">Page</a></h2>
          <div class="b_caption"><p class="b_lineclamp2">A regular page with no date prefix.</p></div>
        </li>
      </ol></body></html>`;
      const results = engine.parseResults(html, 10);
      expect(results[0].published_date).toBeUndefined();
    });

    it('preserves existing behavior for fixture HTML', () => {
      const fixtureHtml = readFileSync('tests/fixtures/search/bing-results.html', 'utf-8');
      const results = engine.parseResults(fixtureHtml, 10);
      expect(results.length).toBe(3);
      expect(results[0].title).toBe('React');
      // Fixture has no dates
      expect(results[0].published_date).toBeUndefined();
    });
  });

  describe('DuckDuckGoEngine date extraction', () => {
    const engine = new DuckDuckGoEngine();

    it('extracts date from snippet prefix', () => {
      const html = `<html><body>
        <a class="result-link" href="https://example.com/news">News</a>
        <td class="result-snippet">Feb 10, 2025 - Breaking news.</td>
      </body></html>`;
      const results = engine.parseResults(html, 10);
      expect(results[0].published_date).toBeDefined();
      expect(new Date(results[0].published_date!).getFullYear()).toBe(2025);
    });

    it('returns undefined for snippets without dates', () => {
      const html = `<html><body>
        <a class="result-link" href="https://example.com/page">Page</a>
        <td class="result-snippet">A regular snippet without date.</td>
      </body></html>`;
      const results = engine.parseResults(html, 10);
      expect(results[0].published_date).toBeUndefined();
    });
  });

  describe('StartpageEngine date extraction', () => {
    const engine = new StartpageEngine();

    it('extracts date from snippet prefix', () => {
      const html = `<html><body>
        <div class="w-gl__result">
          <a class="w-gl__result-title" href="https://example.com/news">News</a>
          <p class="w-gl__description">Mar 5, 2025 - Latest update on the topic.</p>
        </div>
      </body></html>`;
      const results = engine.parseResults(html, 10);
      expect(results[0].published_date).toBeDefined();
      expect(new Date(results[0].published_date!).getFullYear()).toBe(2025);
    });

    it('returns undefined for snippets without dates', () => {
      const html = `<html><body>
        <div class="w-gl__result">
          <a class="w-gl__result-title" href="https://example.com/page">Page</a>
          <p class="w-gl__description">No date here, just content.</p>
        </div>
      </body></html>`;
      const results = engine.parseResults(html, 10);
      expect(results[0].published_date).toBeUndefined();
    });
  });
});
