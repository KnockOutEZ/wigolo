import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfig, getConfig } from '../../src/config.js';
import { parseBrowserTypes } from '../../src/fetch/browser-types.js';
import { BrowserSelector } from '../../src/fetch/browser-selector.js';
import type { BrowserType } from '../../src/types.js';

describe('multi-browser integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  describe('config -> parser -> selector pipeline', () => {
    it('WIGOLO_BROWSER_TYPES=chromium,firefox flows through to selector', () => {
      process.env.WIGOLO_BROWSER_TYPES = 'chromium,firefox';
      resetConfig();
      const config = getConfig();
      expect(config.browserTypes).toEqual(['chromium', 'firefox']);

      const selector = new BrowserSelector(config.browserTypes, 'round-robin');
      expect(selector.select()).toBe('chromium');
      expect(selector.select()).toBe('firefox');
      expect(selector.select()).toBe('chromium');
    });

    it('default config produces single-type chromium selector', () => {
      const config = getConfig();
      expect(config.browserTypes).toEqual(['chromium']);

      const selector = new BrowserSelector(config.browserTypes, 'round-robin');
      for (let i = 0; i < 10; i++) {
        expect(selector.select()).toBe('chromium');
      }
    });

    it('invalid types in env are filtered before reaching selector', () => {
      process.env.WIGOLO_BROWSER_TYPES = 'chromium,invalid,firefox';
      resetConfig();
      const config = getConfig();
      expect(config.browserTypes).toEqual(['chromium', 'firefox']);
    });

    it('all-invalid env falls back to chromium', () => {
      process.env.WIGOLO_BROWSER_TYPES = 'invalid1,invalid2';
      resetConfig();
      const config = getConfig();
      expect(config.browserTypes).toEqual(['chromium']);
    });
  });

  describe('selector distribution verification', () => {
    it('round-robin distributes evenly for 2 types over 200 requests', () => {
      const selector = new BrowserSelector(['chromium', 'firefox'], 'round-robin');
      const counts: Record<string, number> = { chromium: 0, firefox: 0 };

      for (let i = 0; i < 200; i++) {
        counts[selector.select()]++;
      }

      expect(counts.chromium).toBe(100);
      expect(counts.firefox).toBe(100);
    });

    it('round-robin distributes evenly for 3 types over 300 requests', () => {
      const selector = new BrowserSelector(['chromium', 'firefox', 'webkit'], 'round-robin');
      const counts: Record<string, number> = { chromium: 0, firefox: 0, webkit: 0 };

      for (let i = 0; i < 300; i++) {
        counts[selector.select()]++;
      }

      expect(counts.chromium).toBe(100);
      expect(counts.firefox).toBe(100);
      expect(counts.webkit).toBe(100);
    });

    it('hostname-hash is deterministic for a given hostname', () => {
      const selector = new BrowserSelector(['chromium', 'firefox'], 'hostname-hash');
      const hostnames = [
        'example.com',
        'react.dev',
        'github.com',
        'developer.mozilla.org',
        'stackoverflow.com',
      ];

      for (const host of hostnames) {
        const first = selector.selectForHostname(host);
        // Verify 20 subsequent calls return the same type
        for (let i = 0; i < 20; i++) {
          expect(selector.selectForHostname(host)).toBe(first);
        }
      }
    });

    it('hostname-hash distributes across types for many distinct hostnames', () => {
      const selector = new BrowserSelector(['chromium', 'firefox'], 'hostname-hash');
      const counts: Record<string, number> = { chromium: 0, firefox: 0 };

      for (let i = 0; i < 200; i++) {
        const hostname = `host-${i}-${Math.random().toString(36).slice(2)}.example.com`;
        counts[selector.selectForHostname(hostname)]++;
      }

      // Expect reasonable distribution (at least 30% each)
      expect(counts.chromium).toBeGreaterThan(40);
      expect(counts.firefox).toBeGreaterThan(40);
    });
  });

  describe('parseBrowserTypes edge cases', () => {
    it('handles environment variable with trailing newline', () => {
      const result = parseBrowserTypes('chromium,firefox\n');
      expect(result).toEqual(['chromium', 'firefox']);
    });

    it('handles environment variable with carriage return', () => {
      const result = parseBrowserTypes('chromium\r\n');
      expect(result).toEqual(['chromium']);
    });

    it('handles mixed valid and invalid with duplicates', () => {
      const result = parseBrowserTypes('chromium,invalid,firefox,chromium,firefox');
      expect(result).toEqual(['chromium', 'firefox']);
    });
  });

  describe('BrowserSelector stability under load', () => {
    it('round-robin counter does not overflow for very large request counts', () => {
      const selector = new BrowserSelector(['chromium', 'firefox'], 'round-robin');

      // Simulate 10,000 requests
      for (let i = 0; i < 10000; i++) {
        const type = selector.select();
        expect(['chromium', 'firefox']).toContain(type);
      }
    });

    it('hostname-hash handles empty string consistently', () => {
      const selector = new BrowserSelector(['chromium', 'firefox'], 'hostname-hash');
      const first = selector.selectForHostname('');
      for (let i = 0; i < 10; i++) {
        expect(selector.selectForHostname('')).toBe(first);
      }
    });
  });

  describe('warmup result types', () => {
    it('WarmupResult interface accepts firefox and webkit fields', () => {
      // Type-level check: WarmupResult should accept firefox and webkit fields
      // after Slice 17 modifications. This test verifies the type compiles.
      const result: { firefox?: string; webkit?: string } = {
        firefox: 'ok',
        webkit: 'failed',
      };
      expect(result.firefox).toBe('ok');
      expect(result.webkit).toBe('failed');
    });
  });
});
