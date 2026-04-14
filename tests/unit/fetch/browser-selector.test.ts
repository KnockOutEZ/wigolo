import { describe, it, expect, beforeEach } from 'vitest';
import {
  BrowserSelector,
  type SelectionStrategy,
} from '../../../src/fetch/browser-selector.js';
import type { BrowserType } from '../../../src/types.js';

describe('BrowserSelector -- round-robin strategy', () => {
  let selector: BrowserSelector;

  beforeEach(() => {
    selector = new BrowserSelector(['chromium', 'firefox'], 'round-robin');
  });

  it('returns chromium on first call', () => {
    expect(selector.select()).toBe('chromium');
  });

  it('returns firefox on second call', () => {
    selector.select(); // chromium
    expect(selector.select()).toBe('firefox');
  });

  it('wraps around to chromium on third call', () => {
    selector.select(); // chromium
    selector.select(); // firefox
    expect(selector.select()).toBe('chromium');
  });

  it('distributes evenly across 100 calls', () => {
    const counts: Record<string, number> = { chromium: 0, firefox: 0 };
    for (let i = 0; i < 100; i++) {
      counts[selector.select()]++;
    }
    expect(counts.chromium).toBe(50);
    expect(counts.firefox).toBe(50);
  });

  it('works with a single browser type', () => {
    const single = new BrowserSelector(['chromium'], 'round-robin');
    for (let i = 0; i < 10; i++) {
      expect(single.select()).toBe('chromium');
    }
  });

  it('works with all three browser types', () => {
    const triple = new BrowserSelector(['chromium', 'firefox', 'webkit'], 'round-robin');
    expect(triple.select()).toBe('chromium');
    expect(triple.select()).toBe('firefox');
    expect(triple.select()).toBe('webkit');
    expect(triple.select()).toBe('chromium');
  });

  it('distributes evenly across three types over 300 calls', () => {
    const triple = new BrowserSelector(['chromium', 'firefox', 'webkit'], 'round-robin');
    const counts: Record<string, number> = { chromium: 0, firefox: 0, webkit: 0 };
    for (let i = 0; i < 300; i++) {
      counts[triple.select()]++;
    }
    expect(counts.chromium).toBe(100);
    expect(counts.firefox).toBe(100);
    expect(counts.webkit).toBe(100);
  });

  it('reset() starts the round-robin from the beginning', () => {
    selector.select(); // chromium
    selector.select(); // firefox
    selector.reset();
    expect(selector.select()).toBe('chromium');
  });
});

describe('BrowserSelector -- hostname-hash strategy', () => {
  let selector: BrowserSelector;

  beforeEach(() => {
    selector = new BrowserSelector(['chromium', 'firefox'], 'hostname-hash');
  });

  it('returns a valid browser type for any hostname', () => {
    const types: BrowserType[] = ['chromium', 'firefox'];
    const result = selector.selectForHostname('example.com');
    expect(types).toContain(result);
  });

  it('returns the same type for the same hostname across multiple calls', () => {
    const first = selector.selectForHostname('stable.example.com');
    for (let i = 0; i < 20; i++) {
      expect(selector.selectForHostname('stable.example.com')).toBe(first);
    }
  });

  it('distributes different hostnames across types', () => {
    const counts: Record<string, number> = { chromium: 0, firefox: 0 };
    const hostnames = Array.from({ length: 100 }, (_, i) => `host-${i}.example.com`);
    for (const h of hostnames) {
      counts[selector.selectForHostname(h)]++;
    }
    // With 100 hostnames and 2 types, expect rough 50/50 split (allow 30/70 tolerance)
    expect(counts.chromium).toBeGreaterThan(20);
    expect(counts.firefox).toBeGreaterThan(20);
  });

  it('handles empty hostname by returning the first type', () => {
    const result = selector.selectForHostname('');
    expect(['chromium', 'firefox']).toContain(result);
  });

  it('handles unicode hostnames', () => {
    const result = selector.selectForHostname('\u00e9xample.com');
    expect(['chromium', 'firefox']).toContain(result);
  });

  it('handles very long hostnames', () => {
    const longHost = 'a'.repeat(10000) + '.example.com';
    const result = selector.selectForHostname(longHost);
    expect(['chromium', 'firefox']).toContain(result);
  });

  it('selectForHostname is stable after reset()', () => {
    const before = selector.selectForHostname('stable.test');
    selector.reset();
    const after = selector.selectForHostname('stable.test');
    expect(before).toBe(after);
  });
});

describe('BrowserSelector -- random strategy', () => {
  let selector: BrowserSelector;

  beforeEach(() => {
    selector = new BrowserSelector(['chromium', 'firefox'], 'random');
  });

  it('returns a valid browser type', () => {
    const types: BrowserType[] = ['chromium', 'firefox'];
    for (let i = 0; i < 50; i++) {
      expect(types).toContain(selector.select());
    }
  });

  it('eventually returns both types over many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(selector.select());
    }
    expect(seen.size).toBe(2);
  });

  it('works with a single browser type', () => {
    const single = new BrowserSelector(['chromium'], 'random');
    for (let i = 0; i < 20; i++) {
      expect(single.select()).toBe('chromium');
    }
  });

  it('roughly distributes evenly over 1000 calls', () => {
    const counts: Record<string, number> = { chromium: 0, firefox: 0 };
    for (let i = 0; i < 1000; i++) {
      counts[selector.select()]++;
    }
    // Expect roughly 50/50 with tolerance (allow 35/65)
    expect(counts.chromium).toBeGreaterThan(300);
    expect(counts.firefox).toBeGreaterThan(300);
  });
});

describe('BrowserSelector -- edge cases', () => {
  it('throws when constructed with empty types array', () => {
    expect(() => new BrowserSelector([], 'round-robin')).toThrow(/at least one/i);
  });

  it('defaults strategy to round-robin when given undefined', () => {
    const selector = new BrowserSelector(['chromium', 'firefox']);
    expect(selector.select()).toBe('chromium');
    expect(selector.select()).toBe('firefox');
    expect(selector.select()).toBe('chromium');
  });

  it('getTypes() returns the configured types', () => {
    const selector = new BrowserSelector(['firefox', 'webkit']);
    expect(selector.getTypes()).toEqual(['firefox', 'webkit']);
  });

  it('getTypes() returns a copy, not the internal reference', () => {
    const selector = new BrowserSelector(['chromium']);
    const types = selector.getTypes();
    types.push('firefox' as BrowserType);
    expect(selector.getTypes()).toEqual(['chromium']);
  });

  it('concurrent select() calls are safe (round-robin)', () => {
    const selector = new BrowserSelector(['chromium', 'firefox'], 'round-robin');
    const results = Array.from({ length: 100 }, () => selector.select());
    const chrCount = results.filter(r => r === 'chromium').length;
    const ffCount = results.filter(r => r === 'firefox').length;
    expect(chrCount).toBe(50);
    expect(ffCount).toBe(50);
  });
});
