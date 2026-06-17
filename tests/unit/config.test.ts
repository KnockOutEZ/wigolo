import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, resetConfig } from '../../src/config.js';
import { resetPersistedConfig } from '../../src/persisted-config.js';

describe('config', () => {
  const originalEnv = process.env;
  let tmpConfigDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Hermetic isolation: point the persisted-config path at an empty temp dir.
    // config reads several fields (e.g. llmProvider) from persisted settings as
    // a fallback when the env var is unset. Without isolation these tests pick
    // up whatever is in the real ~/.wigolo/config.json or a sibling test's
    // leaked WIGOLO_CONFIG_PATH/cache, which made "defaults to null" flaky.
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'wigolo-config-test-'));
    process.env.WIGOLO_CONFIG_PATH = join(tmpConfigDir, 'config.json');
    resetPersistedConfig();
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    // Drop our temp-path cache entry so later test files start clean.
    resetPersistedConfig();
    resetConfig();
  });

  it('returns defaults when no env vars set', () => {
    const config = getConfig();
    expect(config.fetchTimeoutMs).toBe(10000);
    expect(config.fetchMaxRetries).toBe(2);
    expect(config.maxRedirects).toBe(5);
    expect(config.playwrightLoadTimeoutMs).toBe(15000);
    expect(config.playwrightNavTimeoutMs).toBe(30000);
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
    it('respects explicit WIGOLO_RERANKER=none to disable reranking', () => {
      process.env.WIGOLO_RERANKER = 'none';
      resetConfig();
      expect(getConfig().reranker).toBe('none');
    });

    it('reads WIGOLO_RERANKER_MODEL config', () => {
      process.env.WIGOLO_RERANKER_MODEL = 'custom-model';
      resetConfig();
      expect(getConfig().rerankerModel).toBe('custom-model');
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

  describe('config — embedding', () => {
    it('embeddingModel defaults to bge-small-en-v1.5', () => {
      expect(getConfig().embeddingModel).toBe('BAAI/bge-small-en-v1.5');
    });

    it('embeddingModel reads from WIGOLO_EMBEDDING_MODEL', () => {
      process.env.WIGOLO_EMBEDDING_MODEL = 'all-MiniLM-L6-v2';
      resetConfig();
      expect(getConfig().embeddingModel).toBe('all-MiniLM-L6-v2');
    });

    it('embeddingIdleTimeoutMs defaults to 1800000', () => {
      expect(getConfig().embeddingIdleTimeoutMs).toBe(1800000);
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
      expect(getConfig().embeddingIdleTimeoutMs).toBe(1800000);
    });

    it('embeddingMaxTextLength falls back to default on non-numeric', () => {
      process.env.WIGOLO_EMBEDDING_MAX_TEXT_LENGTH = 'abc';
      resetConfig();
      expect(getConfig().embeddingMaxTextLength).toBe(8000);
    });
  });

  describe('config — llm fallback', () => {
    it('llmProvider defaults to null', () => {
      delete process.env.WIGOLO_LLM_PROVIDER;
      resetConfig();
      expect(getConfig().llmProvider).toBeNull();
    });

    it('reads WIGOLO_LLM_PROVIDER', () => {
      process.env.WIGOLO_LLM_PROVIDER = 'openai';
      resetConfig();
      expect(getConfig().llmProvider).toBe('openai');
    });

    it('llmCacheTtlDays defaults to 7', () => {
      delete process.env.WIGOLO_LLM_CACHE_TTL_DAYS;
      resetConfig();
      expect(getConfig().llmCacheTtlDays).toBe(7);
    });

    it('reads WIGOLO_LLM_CACHE_TTL_DAYS', () => {
      process.env.WIGOLO_LLM_CACHE_TTL_DAYS = '30';
      resetConfig();
      expect(getConfig().llmCacheTtlDays).toBe(30);
    });

    it('llmMaxCallsPerRequest defaults to 1', () => {
      delete process.env.WIGOLO_LLM_MAX_CALLS_PER_REQUEST;
      resetConfig();
      expect(getConfig().llmMaxCallsPerRequest).toBe(1);
    });

    it('reads WIGOLO_LLM_MAX_CALLS_PER_REQUEST', () => {
      process.env.WIGOLO_LLM_MAX_CALLS_PER_REQUEST = '3';
      resetConfig();
      expect(getConfig().llmMaxCallsPerRequest).toBe(3);
    });

    it('non-numeric WIGOLO_LLM_CACHE_TTL_DAYS falls back to default', () => {
      process.env.WIGOLO_LLM_CACHE_TTL_DAYS = 'abc';
      resetConfig();
      expect(getConfig().llmCacheTtlDays).toBe(7);
    });
  });

  describe('reranker config rename (ticket #10)', () => {
    it('default reranker is "onnx"', () => {
      delete process.env.WIGOLO_RERANKER;
      resetConfig();
      expect(getConfig().reranker).toBe('onnx');
    });

    it('default rerankerModel is "bge-reranker-v2-m3"', () => {
      delete process.env.WIGOLO_RERANKER_MODEL;
      resetConfig();
      expect(getConfig().rerankerModel).toBe('bge-reranker-v2-m3');
    });

    it('legacy value "flashrank" is aliased to "onnx" (with warn log)', () => {
      process.env.WIGOLO_RERANKER = 'flashrank';
      resetConfig();
      expect(getConfig().reranker).toBe('onnx');
    });

    it('"minilm-l12" alias is preserved verbatim (resolution at use-site)', () => {
      process.env.WIGOLO_RERANKER_MODEL = 'minilm-l12';
      resetConfig();
      expect(getConfig().rerankerModel).toBe('minilm-l12');
    });

    it('reranker=none disables reranking', () => {
      process.env.WIGOLO_RERANKER = 'none';
      resetConfig();
      expect(getConfig().reranker).toBe('none');
    });
  });

  describe('config — studio screencast + session browser (phase 1)', () => {
    it('studioBrowserHeadless defaults to false (headed session browser per spec)', () => {
      expect(getConfig().studioBrowserHeadless).toBe(false);
    });

    it('reads WIGOLO_STUDIO_HEADLESS=1 as true (CI / headless host)', () => {
      process.env.WIGOLO_STUDIO_HEADLESS = '1';
      resetConfig();
      expect(getConfig().studioBrowserHeadless).toBe(true);
    });

    it('studioScreencastQuality defaults to 60', () => {
      expect(getConfig().studioScreencastQuality).toBe(60);
    });

    it('reads WIGOLO_STUDIO_SCREENCAST_QUALITY', () => {
      process.env.WIGOLO_STUDIO_SCREENCAST_QUALITY = '40';
      resetConfig();
      expect(getConfig().studioScreencastQuality).toBe(40);
    });

    it('studioScreencastMaxWidth / MaxHeight default to 1280 x 720', () => {
      expect(getConfig().studioScreencastMaxWidth).toBe(1280);
      expect(getConfig().studioScreencastMaxHeight).toBe(720);
    });

    it('reads WIGOLO_STUDIO_SCREENCAST_MAX_WIDTH / _HEIGHT', () => {
      process.env.WIGOLO_STUDIO_SCREENCAST_MAX_WIDTH = '1600';
      process.env.WIGOLO_STUDIO_SCREENCAST_MAX_HEIGHT = '900';
      resetConfig();
      expect(getConfig().studioScreencastMaxWidth).toBe(1600);
      expect(getConfig().studioScreencastMaxHeight).toBe(900);
    });

    it('studioScreencastEveryNthFrame defaults to 1', () => {
      expect(getConfig().studioScreencastEveryNthFrame).toBe(1);
    });

    it('studioFrameAckTimeoutMs defaults to 1000', () => {
      expect(getConfig().studioFrameAckTimeoutMs).toBe(1000);
    });

    it('reads WIGOLO_STUDIO_FRAME_ACK_TIMEOUT_MS', () => {
      process.env.WIGOLO_STUDIO_FRAME_ACK_TIMEOUT_MS = '500';
      resetConfig();
      expect(getConfig().studioFrameAckTimeoutMs).toBe(500);
    });

    it('studioBrowserCrashMaxRestarts defaults to 2', () => {
      expect(getConfig().studioBrowserCrashMaxRestarts).toBe(2);
    });

    it('reads WIGOLO_STUDIO_BROWSER_CRASH_MAX_RESTARTS', () => {
      process.env.WIGOLO_STUDIO_BROWSER_CRASH_MAX_RESTARTS = '5';
      resetConfig();
      expect(getConfig().studioBrowserCrashMaxRestarts).toBe(5);
    });

    it('studioNavAllowPrivateForHuman defaults to true (co-browsing localhost is a primary use case)', () => {
      expect(getConfig().studioNavAllowPrivateForHuman).toBe(true);
    });

    it('reads WIGOLO_STUDIO_NAV_ALLOW_PRIVATE_FOR_HUMAN=false as false', () => {
      process.env.WIGOLO_STUDIO_NAV_ALLOW_PRIVATE_FOR_HUMAN = 'false';
      resetConfig();
      expect(getConfig().studioNavAllowPrivateForHuman).toBe(false);
    });

    it('studioSnapshotTokenBudget defaults to 4000', () => {
      expect(getConfig().studioSnapshotTokenBudget).toBe(4000);
    });

    it('reads WIGOLO_STUDIO_SNAPSHOT_TOKEN_BUDGET', () => {
      process.env.WIGOLO_STUDIO_SNAPSHOT_TOKEN_BUDGET = '8000';
      resetConfig();
      expect(getConfig().studioSnapshotTokenBudget).toBe(8000);
    });

    it('vision budget caps default and read from env', () => {
      expect(getConfig().studioVisionMaxCallsPerTurn).toBe(3);
      expect(getConfig().studioVisionMaxBytesPerTurn).toBe(4_000_000);
      expect(getConfig().studioVisionInlineByteCap).toBe(262144);
      process.env.WIGOLO_STUDIO_VISION_MAX_CALLS_PER_TURN = '5';
      process.env.WIGOLO_STUDIO_VISION_INLINE_BYTE_CAP = '1000';
      resetConfig();
      expect(getConfig().studioVisionMaxCallsPerTurn).toBe(5);
      expect(getConfig().studioVisionInlineByteCap).toBe(1000);
    });
  });
});
