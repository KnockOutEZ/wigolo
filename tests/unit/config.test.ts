import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, resetConfig } from '../../src/config.js';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns defaults when no env vars set', () => {
    const config = getConfig();
    expect(config.fetchTimeoutMs).toBe(10000);
    expect(config.fetchMaxRetries).toBe(2);
    expect(config.maxRedirects).toBe(5);
    expect(config.playwrightLoadTimeoutMs).toBe(15000);
    expect(config.playwrightNavTimeoutMs).toBe(10000);
    expect(config.maxBrowsers).toBe(3);
    expect(config.browserIdleTimeoutMs).toBe(60000);
    expect(config.browserFallbackThreshold).toBe(3);
    expect(config.cacheTtlContent).toBe(604800);
    expect(config.logLevel).toBe('info');
    expect(config.logFormat).toBe('json');
    expect(config.validateLinks).toBe(true);
    expect(config.respectRobotsTxt).toBe(true);
  });

  it('reads env var overrides', () => {
    process.env.FETCH_TIMEOUT_MS = '5000';
    process.env.MAX_BROWSERS = '5';
    process.env.LOG_LEVEL = 'debug';
    process.env.LOG_FORMAT = 'text';
    process.env.VALIDATE_LINKS = 'false';
    const config = getConfig();
    expect(config.fetchTimeoutMs).toBe(5000);
    expect(config.maxBrowsers).toBe(5);
    expect(config.logLevel).toBe('debug');
    expect(config.logFormat).toBe('text');
    expect(config.validateLinks).toBe(false);
  });

  it('reads auth paths', () => {
    process.env.WIGOLO_AUTH_STATE_PATH = '/tmp/state.json';
    process.env.WIGOLO_CHROME_PROFILE_PATH = '/tmp/chrome';
    const config = getConfig();
    expect(config.authStatePath).toBe('/tmp/state.json');
    expect(config.chromeProfilePath).toBe('/tmp/chrome');
  });

  it('resolves data dir with home expansion', () => {
    const config = getConfig();
    expect(config.dataDir).toContain('.wigolo');
  });

  describe('reranker configuration', () => {
    it('reads WIGOLO_RERANKER config', () => {
      process.env.WIGOLO_RERANKER = 'flashrank';
      resetConfig();
      expect(getConfig().reranker).toBe('flashrank');
    });

    it('defaults WIGOLO_RERANKER to none', () => {
      delete process.env.WIGOLO_RERANKER;
      resetConfig();
      expect(getConfig().reranker).toBe('none');
    });

    it('reads WIGOLO_RERANKER_MODEL config', () => {
      process.env.WIGOLO_RERANKER_MODEL = 'custom-model';
      resetConfig();
      expect(getConfig().rerankerModel).toBe('custom-model');
    });

    it('defaults WIGOLO_RERANKER_MODEL to ms-marco-MiniLM-L-12-v2', () => {
      delete process.env.WIGOLO_RERANKER_MODEL;
      resetConfig();
      expect(getConfig().rerankerModel).toBe('ms-marco-MiniLM-L-12-v2');
    });

    it('reads WIGOLO_RELEVANCE_THRESHOLD config', () => {
      process.env.WIGOLO_RELEVANCE_THRESHOLD = '0.3';
      resetConfig();
      expect(getConfig().relevanceThreshold).toBe(0.3);
    });

    it('defaults WIGOLO_RELEVANCE_THRESHOLD to 0', () => {
      delete process.env.WIGOLO_RELEVANCE_THRESHOLD;
      resetConfig();
      expect(getConfig().relevanceThreshold).toBe(0);
    });

    it('handles invalid WIGOLO_RELEVANCE_THRESHOLD (NaN falls back to 0)', () => {
      process.env.WIGOLO_RELEVANCE_THRESHOLD = 'not-a-number';
      resetConfig();
      expect(getConfig().relevanceThreshold).toBe(0);
    });

    it('reads WIGOLO_RERANKER value custom', () => {
      process.env.WIGOLO_RERANKER = 'custom';
      resetConfig();
      expect(getConfig().reranker).toBe('custom');
    });
  });

  describe('WIGOLO_TRAFILATURA config', () => {
    it('defaults to auto when env var is not set', () => {
      delete process.env.WIGOLO_TRAFILATURA;
      resetConfig();
      expect(getConfig().trafilatura).toBe('auto');
    });

    it('reads WIGOLO_TRAFILATURA=always', () => {
      process.env.WIGOLO_TRAFILATURA = 'always';
      resetConfig();
      expect(getConfig().trafilatura).toBe('always');
    });

    it('reads WIGOLO_TRAFILATURA=never', () => {
      process.env.WIGOLO_TRAFILATURA = 'never';
      resetConfig();
      expect(getConfig().trafilatura).toBe('never');
    });

    it('reads WIGOLO_TRAFILATURA=auto explicitly', () => {
      process.env.WIGOLO_TRAFILATURA = 'auto';
      resetConfig();
      expect(getConfig().trafilatura).toBe('auto');
    });
  });
});
