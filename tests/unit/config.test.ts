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

  describe('config --- CDP discovery', () => {
    beforeEach(() => { resetConfig(); });
    afterEach(() => { resetConfig(); });

    it('defaults cdpUrl to null', () => {
      expect(getConfig().cdpUrl).toBeNull();
    });

    it('reads WIGOLO_CDP_URL as string', () => {
      process.env.WIGOLO_CDP_URL = 'http://localhost:9222';
      resetConfig();
      expect(getConfig().cdpUrl).toBe('http://localhost:9222');
    });

    it('reads custom CDP port', () => {
      process.env.WIGOLO_CDP_URL = 'http://localhost:9333';
      resetConfig();
      expect(getConfig().cdpUrl).toBe('http://localhost:9333');
    });

    it('reads remote CDP URL', () => {
      process.env.WIGOLO_CDP_URL = 'http://192.168.1.100:9222';
      resetConfig();
      expect(getConfig().cdpUrl).toBe('http://192.168.1.100:9222');
    });

    it('handles empty string as null', () => {
      process.env.WIGOLO_CDP_URL = '';
      resetConfig();
      expect(getConfig().cdpUrl).toBeNull();
    });
  });

  describe('config — multi-query', () => {
    it('multiQueryConcurrency defaults to 5', () => {
      expect(getConfig().multiQueryConcurrency).toBe(5);
    });

    it('multiQueryConcurrency reads from WIGOLO_MULTI_QUERY_CONCURRENCY', () => {
      process.env.WIGOLO_MULTI_QUERY_CONCURRENCY = '3';
      resetConfig();
      expect(getConfig().multiQueryConcurrency).toBe(3);
    });

    it('multiQueryMax defaults to 10', () => {
      expect(getConfig().multiQueryMax).toBe(10);
    });

    it('multiQueryMax reads from WIGOLO_MULTI_QUERY_MAX', () => {
      process.env.WIGOLO_MULTI_QUERY_MAX = '20';
      resetConfig();
      expect(getConfig().multiQueryMax).toBe(20);
    });

    it('multiQueryConcurrency falls back to default on non-numeric', () => {
      process.env.WIGOLO_MULTI_QUERY_CONCURRENCY = 'abc';
      resetConfig();
      expect(getConfig().multiQueryConcurrency).toBe(5);
    });

    it('multiQueryMax falls back to default on non-numeric', () => {
      process.env.WIGOLO_MULTI_QUERY_MAX = '';
      resetConfig();
      expect(getConfig().multiQueryMax).toBe(10);
    });
  });

  describe('config — lightpanda', () => {
    it('reads WIGOLO_LIGHTPANDA_URL', () => {
      process.env.WIGOLO_LIGHTPANDA_URL = 'http://localhost:9222';
      resetConfig();
      const config = getConfig();
      expect(config.lightpandaUrl).toBe('http://localhost:9222');
      delete process.env.WIGOLO_LIGHTPANDA_URL;
      resetConfig();
    });

    it('defaults lightpandaUrl to null', () => {
      delete process.env.WIGOLO_LIGHTPANDA_URL;
      resetConfig();
      const config = getConfig();
      expect(config.lightpandaUrl).toBeNull();
    });

    it('reads WIGOLO_LIGHTPANDA_ENABLED', () => {
      process.env.WIGOLO_LIGHTPANDA_ENABLED = 'true';
      resetConfig();
      const config = getConfig();
      expect(config.lightpandaEnabled).toBe(true);
      delete process.env.WIGOLO_LIGHTPANDA_ENABLED;
      resetConfig();
    });

    it('defaults lightpandaEnabled to false', () => {
      delete process.env.WIGOLO_LIGHTPANDA_ENABLED;
      resetConfig();
      const config = getConfig();
      expect(config.lightpandaEnabled).toBe(false);
    });

    it('lightpandaEnabled is false when set to "false"', () => {
      process.env.WIGOLO_LIGHTPANDA_ENABLED = 'false';
      resetConfig();
      const config = getConfig();
      expect(config.lightpandaEnabled).toBe(false);
      delete process.env.WIGOLO_LIGHTPANDA_ENABLED;
      resetConfig();
    });

    it('reads WIGOLO_LIGHTPANDA_FAILURE_THRESHOLD', () => {
      process.env.WIGOLO_LIGHTPANDA_FAILURE_THRESHOLD = '5';
      resetConfig();
      const config = getConfig();
      expect(config.lightpandaFailureThreshold).toBe(5);
      delete process.env.WIGOLO_LIGHTPANDA_FAILURE_THRESHOLD;
      resetConfig();
    });

    it('defaults lightpandaFailureThreshold to 3', () => {
      delete process.env.WIGOLO_LIGHTPANDA_FAILURE_THRESHOLD;
      resetConfig();
      const config = getConfig();
      expect(config.lightpandaFailureThreshold).toBe(3);
    });
  });

  describe('config — embedding', () => {
    it('embeddingModel defaults to bge-small-en-v1.5', () => {
      expect(getConfig().embeddingModel).toBe('BAAI/bge-small-en-v1.5');
    });

    it('embeddingModel reads from WIGOLO_EMBEDDING_MODEL', () => {
      process.env.WIGOLO_EMBEDDING_MODEL = 'all-MiniLM-L6-v2';
      resetConfig();
      expect(getConfig().embeddingModel).toBe('all-MiniLM-L6-v2');
    });

    it('embeddingIdleTimeoutMs defaults to 120000', () => {
      expect(getConfig().embeddingIdleTimeoutMs).toBe(120000);
    });

    it('embeddingIdleTimeoutMs reads from WIGOLO_EMBEDDING_IDLE_TIMEOUT', () => {
      process.env.WIGOLO_EMBEDDING_IDLE_TIMEOUT = '60000';
      resetConfig();
      expect(getConfig().embeddingIdleTimeoutMs).toBe(60000);
    });

    it('embeddingMaxTextLength defaults to 8000', () => {
      expect(getConfig().embeddingMaxTextLength).toBe(8000);
    });

    it('embeddingMaxTextLength reads from WIGOLO_EMBEDDING_MAX_TEXT_LENGTH', () => {
      process.env.WIGOLO_EMBEDDING_MAX_TEXT_LENGTH = '4000';
      resetConfig();
      expect(getConfig().embeddingMaxTextLength).toBe(4000);
    });

    it('embeddingIdleTimeoutMs falls back to default on non-numeric', () => {
      process.env.WIGOLO_EMBEDDING_IDLE_TIMEOUT = 'invalid';
      resetConfig();
      expect(getConfig().embeddingIdleTimeoutMs).toBe(120000);
    });

    it('embeddingMaxTextLength falls back to default on non-numeric', () => {
      process.env.WIGOLO_EMBEDDING_MAX_TEXT_LENGTH = 'abc';
      resetConfig();
      expect(getConfig().embeddingMaxTextLength).toBe(8000);
    });
  });
});
