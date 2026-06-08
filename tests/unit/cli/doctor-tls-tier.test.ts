import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:child_process', () => ({ execSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});
vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/playwright/chromium/chrome'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/playwright/firefox/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/playwright/webkit/webkit'), launch: vi.fn(okLaunch) },
  };
});
vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank: vi.fn().mockResolvedValue([{ id: '0', score: 0.9 }]),
  })),
}));
vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({
    modelId: 'BAAI/bge-small-en-v1.5',
    dim: 384,
    embed: vi.fn(),
  })),
}));
vi.mock('../../../src/cache/db.js', () => {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (typeof sql === 'string' && sql.includes('vec_version')) {
        return { get: vi.fn(() => ({ v: '0.1.7-alpha.2' })) };
      }
      return { get: vi.fn(() => ({ n: 0, last_at: null })) };
    }),
  };
  return {
    initDatabase: vi.fn(() => db),
    closeDatabase: vi.fn(),
    getDatabase: vi.fn(() => db),
    isVecExtensionLoaded: vi.fn(() => true),
  };
});
vi.mock('../../../src/search/core/rss/feed-config.js', () => ({
  loadFeedConfig: vi.fn(() => ({ feeds: [], sources: [] })),
}));

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { runDoctor, formatTlsTierLine } from '../../../src/cli/doctor.js';

function okProc(stdout = ''): ReturnType<typeof spawnSync> {
  return { status: 0, stdout, stderr: '', signal: null, pid: 1, output: [], error: undefined } as ReturnType<typeof spawnSync>;
}

describe('runDoctor — TLS tier visibility', () => {
  let outBuffer = '';
  const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    outBuffer += String(chunk);
    return true;
  });

  const originalEnv = process.env;

  beforeEach(() => {
    outBuffer = '';
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_TLS_TIER;
    delete process.env.WIGOLO_TLS_BROWSER;
    resetConfig();
    vi.clearAllMocks();
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/sx' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
      return '';
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    writeSpy.mockClear();
  });

  it('emits "tls_tier: off (default)" when WIGOLO_TLS_TIER is unset', async () => {
    await runDoctor('/tmp/.wigolo');
    expect(outBuffer).toMatch(/tls_tier:\s+off \(default\)/);
  });

  it('emits "tls_tier: off (default)" when WIGOLO_TLS_TIER=off', async () => {
    process.env.WIGOLO_TLS_TIER = 'off';
    resetConfig();
    await runDoctor('/tmp/.wigolo');
    expect(outBuffer).toMatch(/tls_tier:\s+off \(default\)/);
  });

  it('emits "tls_tier: auto (...)" when WIGOLO_TLS_TIER=auto', async () => {
    process.env.WIGOLO_TLS_TIER = 'auto';
    resetConfig();
    await runDoctor('/tmp/.wigolo');
    expect(outBuffer).toMatch(/tls_tier:\s+auto/);
  });

  it('emits "tls_tier: on (...)" when WIGOLO_TLS_TIER=on', async () => {
    process.env.WIGOLO_TLS_TIER = 'on';
    resetConfig();
    await runDoctor('/tmp/.wigolo');
    expect(outBuffer).toMatch(/tls_tier:\s+on/);
  });

  it('mentions wreq-js availability in the tls_tier line when mode != off', async () => {
    process.env.WIGOLO_TLS_TIER = 'auto';
    resetConfig();
    await runDoctor('/tmp/.wigolo');
    // Either ✓ when present, OR a "missing — fallback only" hint when absent.
    expect(outBuffer).toMatch(/wreq-js (✓|missing)/);
  });
});

describe('formatTlsTierLine', () => {
  it('returns "off (default)" for mode=off regardless of wreq availability', () => {
    expect(formatTlsTierLine('off', 'chrome_142', true)).toBe('off (default)');
    expect(formatTlsTierLine('off', 'chrome_142', false)).toBe('off (default)');
  });

  it('reports browser profile + wreq-js ✓ when wreq-js is available', () => {
    expect(formatTlsTierLine('auto', 'chrome_142', true)).toBe('auto (chrome_142, wreq-js ✓)');
    expect(formatTlsTierLine('on', 'chrome_142', true)).toBe('on (chrome_142, wreq-js ✓)');
  });

  it('reflects the configured browser profile when wreq-js is available', () => {
    expect(formatTlsTierLine('on', 'firefox_133', true)).toBe('on (firefox_133, wreq-js ✓)');
    expect(formatTlsTierLine('auto', 'safari_18', true)).toBe('auto (safari_18, wreq-js ✓)');
  });

  it('flags "wreq-js missing — fallback only" when the optional dep is absent', () => {
    expect(formatTlsTierLine('auto', 'chrome_142', false)).toBe('auto (wreq-js missing — fallback only)');
    expect(formatTlsTierLine('on', 'chrome_142', false)).toBe('on (wreq-js missing — fallback only)');
  });
});
