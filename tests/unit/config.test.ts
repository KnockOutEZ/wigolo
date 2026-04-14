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

  describe('config — bootstrap reliability', () => {
    it('defaults bootstrapMaxAttempts to 3', () => {
      expect(getConfig().bootstrapMaxAttempts).toBe(3);
    });

    it('reads WIGOLO_BOOTSTRAP_MAX_ATTEMPTS as integer', () => {
      process.env.WIGOLO_BOOTSTRAP_MAX_ATTEMPTS = '5';
      resetConfig();
      expect(getConfig().bootstrapMaxAttempts).toBe(5);
    });

    it('defaults bootstrapBackoffSeconds to [30, 3600, 86400]', () => {
      expect(getConfig().bootstrapBackoffSeconds).toEqual([30, 3600, 86400]);
    });

    it('parses WIGOLO_BOOTSTRAP_BACKOFF_SECONDS as comma-separated ints', () => {
      process.env.WIGOLO_BOOTSTRAP_BACKOFF_SECONDS = '10,60,3600';
      resetConfig();
      expect(getConfig().bootstrapBackoffSeconds).toEqual([10, 60, 3600]);
    });

    it('ignores malformed backoff entries and falls back to default', () => {
      process.env.WIGOLO_BOOTSTRAP_BACKOFF_SECONDS = 'abc,def';
      resetConfig();
      expect(getConfig().bootstrapBackoffSeconds).toEqual([30, 3600, 86400]);
    });

    it('defaults healthProbeIntervalMs to 30000', () => {
      expect(getConfig().healthProbeIntervalMs).toBe(30000);
    });

    it('reads WIGOLO_HEALTH_PROBE_INTERVAL_MS as integer', () => {
      process.env.WIGOLO_HEALTH_PROBE_INTERVAL_MS = '5000';
      resetConfig();
      expect(getConfig().healthProbeIntervalMs).toBe(5000);
    });
  });

  describe('config -- daemon mode', () => {
    it('defaults daemonPort to 3333', () => {
      expect(getConfig().daemonPort).toBe(3333);
    });

    it('reads WIGOLO_DAEMON_PORT as integer', () => {
      process.env.WIGOLO_DAEMON_PORT = '4444';
      resetConfig();
      expect(getConfig().daemonPort).toBe(4444);
    });

    it('defaults daemonHost to 127.0.0.1', () => {
      expect(getConfig().daemonHost).toBe('127.0.0.1');
    });

    it('reads WIGOLO_DAEMON_HOST from env', () => {
      process.env.WIGOLO_DAEMON_HOST = '0.0.0.0';
      resetConfig();
      expect(getConfig().daemonHost).toBe('0.0.0.0');
    });

    it('ignores non-numeric WIGOLO_DAEMON_PORT and falls back to default', () => {
      process.env.WIGOLO_DAEMON_PORT = 'not-a-number';
      resetConfig();
      expect(getConfig().daemonPort).toBe(3333);
    });

    it('handles empty WIGOLO_DAEMON_PORT string', () => {
      process.env.WIGOLO_DAEMON_PORT = '';
      resetConfig();
      expect(getConfig().daemonPort).toBe(3333);
    });

    it('handles WIGOLO_DAEMON_PORT=0 (valid port for OS-assigned)', () => {
      process.env.WIGOLO_DAEMON_PORT = '0';
      resetConfig();
      expect(getConfig().daemonPort).toBe(0);
    });

    it('handles negative WIGOLO_DAEMON_PORT (parsed but caller validates)', () => {
      process.env.WIGOLO_DAEMON_PORT = '-1';
      resetConfig();
      expect(getConfig().daemonPort).toBe(-1);
    });

    it('handles float WIGOLO_DAEMON_PORT (parseInt truncates)', () => {
      process.env.WIGOLO_DAEMON_PORT = '3333.7';
      resetConfig();
      expect(getConfig().daemonPort).toBe(3333);
    });

    it('WIGOLO_DAEMON_HOST can be an IPv6 address', () => {
      process.env.WIGOLO_DAEMON_HOST = '::1';
      resetConfig();
      expect(getConfig().daemonHost).toBe('::1');
    });

    it('WIGOLO_DAEMON_HOST can be a hostname', () => {
      process.env.WIGOLO_DAEMON_HOST = 'localhost';
      resetConfig();
      expect(getConfig().daemonHost).toBe('localhost');
    });

    it('empty WIGOLO_DAEMON_HOST falls back to default', () => {
      process.env.WIGOLO_DAEMON_HOST = '';
      resetConfig();
      expect(getConfig().daemonHost).toBe('127.0.0.1');
    });

    it('whitespace-only WIGOLO_DAEMON_HOST falls back to default', () => {
      process.env.WIGOLO_DAEMON_HOST = '   ';
      resetConfig();
      expect(getConfig().daemonHost).toBe('127.0.0.1');
    });
  });
});
