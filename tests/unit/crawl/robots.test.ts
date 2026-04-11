import { describe, it, expect } from 'vitest';
import { RobotsParser } from '../../../src/crawl/robots.js';

describe('RobotsParser', () => {
  it('allows all paths when robots.txt is empty', () => {
    const parser = new RobotsParser('');
    expect(parser.isAllowed('/anything')).toBe(true);
  });

  it('respects Disallow rules for wildcard user-agent', () => {
    const robots = `User-agent: *\nDisallow: /private/\nDisallow: /admin/`;
    const parser = new RobotsParser(robots);
    expect(parser.isAllowed('/public/page')).toBe(true);
    expect(parser.isAllowed('/private/secret')).toBe(false);
    expect(parser.isAllowed('/admin/dashboard')).toBe(false);
  });

  it('respects Allow rules that override Disallow', () => {
    const robots = `User-agent: *\nDisallow: /docs/\nAllow: /docs/public/`;
    const parser = new RobotsParser(robots);
    expect(parser.isAllowed('/docs/private')).toBe(false);
    expect(parser.isAllowed('/docs/public/page')).toBe(true);
  });

  it('extracts Crawl-delay', () => {
    const robots = `User-agent: *\nCrawl-delay: 2\nDisallow: /`;
    const parser = new RobotsParser(robots);
    expect(parser.getCrawlDelay()).toBe(2);
  });

  it('returns null Crawl-delay when not specified', () => {
    const parser = new RobotsParser('User-agent: *\nDisallow:');
    expect(parser.getCrawlDelay()).toBeNull();
  });

  it('handles Disallow with empty value (allow all)', () => {
    const robots = `User-agent: *\nDisallow:`;
    const parser = new RobotsParser(robots);
    expect(parser.isAllowed('/anything')).toBe(true);
  });

  it('is case-insensitive for directives', () => {
    const robots = `user-agent: *\ndisallow: /secret/\ncrawl-delay: 5`;
    const parser = new RobotsParser(robots);
    expect(parser.isAllowed('/secret/page')).toBe(false);
    expect(parser.getCrawlDelay()).toBe(5);
  });

  it('Disallow: / blocks everything', () => {
    const robots = `User-agent: *\nDisallow: /`;
    const parser = new RobotsParser(robots);
    expect(parser.isAllowed('/')).toBe(false);
    expect(parser.isAllowed('/page')).toBe(false);
  });
});
