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
// doctor now probes browser health via a real headless launch (shared with
// warmup, GH #116). launch() defaults to a clean-closing browser; tests that
// need a launch failure override it.
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
      // feed_items lookup — default to empty.
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
import { runDoctor } from '../../../src/cli/doctor.js';
import { getEmbedProvider } from '../../../src/providers/embed-provider.js';
import { initDatabase } from '../../../src/cache/db.js';
import { loadFeedConfig } from '../../../src/search/core/rss/feed-config.js';

function okProc(stdout = ''): ReturnType<typeof spawnSync> {
  return { status: 0, stdout, stderr: '', signal: null, pid: 1, output: [], error: undefined } as ReturnType<typeof spawnSync>;
}

describe('runDoctor', () => {
  let outBuffer = '';
  const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    outBuffer += String(chunk);
    return true;
  });

  beforeEach(() => { outBuffer = ''; resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); writeSpy.mockClear(); });

  it('exits 0 when everything is healthy', async () => {
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'python3' || cmd === 'docker') return okProc('Python 3.12.4');
      return okProc();
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
      return '';
    });
    const code = await runDoctor('/tmp/.wigolo');
    expect(code).toBe(0);
    expect(outBuffer).toMatch(/Overall: OK/i);
  });

  it('exits 1 when SearXNG state is failed', async () => {
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('state.json'));
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      status: 'failed',
      attempts: 2,
      lastAttemptAt: '2026-04-13T09:15:01Z',
      nextRetryAt: '2026-04-13T10:15:01Z',
      lastError: { message: 'pip install failed: 1', stderr: 'ERROR: ...', exitCode: 1, command: 'pip install', timestamp: '2026-04-13T09:15:01Z' },
    }));
    const code = await runDoctor('/tmp/.wigolo');
    expect(code).toBe(1);
    expect(outBuffer).toContain('attempts:      2');
    expect(outBuffer).toContain('pip install failed');
    expect(outBuffer).toContain('warmup --force');
    expect(outBuffer).toMatch(/Overall: DEGRADED/);
  });

  it('exits 1 when Playwright is installed but chromium browser is missing', async () => {
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const joined = [cmd, ...((args ?? []) as string[])].join(' ');
      if (joined.includes('--version')) return okProc('1.50.0');
      return okProc();
    });
    // chromium binary path resolves but the file is not on disk
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.includes('/fake/playwright/chromium/')) return false;
      return true;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
      return '';
    });
    const code = await runDoctor('/tmp/.wigolo');
    expect(code).toBe(1);
    expect(outBuffer).toContain('chromium missing');
    expect(outBuffer).toContain('npx playwright install chromium');
  });

  it('exits 1 with the install-deps hint when chromium is on disk but will not launch on Linux (GH #116)', async () => {
    // WHY: on bare Linux the binary lands on disk (existsSync true) yet
    // launch() fails for missing OS shared libs. existsSync alone lied; the
    // shared probe's launch smoke-test catches this and doctor must point the
    // user at the EXACT remediation: install-deps, not re-install.
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      vi.mocked(spawnSync).mockImplementation((cmd, args) => {
        const joined = [cmd, ...((args ?? []) as string[])].join(' ');
        if (joined.includes('--version')) return okProc('1.50.0');
        return okProc();
      });
      // Binary present on disk for every path.
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
        if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
        return '';
      });
      // chromium launch throws → not launchable despite being on disk.
      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockRejectedValueOnce(
        new Error('libnss3.so: cannot open shared object file') as never,
      );

      const code = await runDoctor('/tmp/.wigolo');
      expect(code).toBe(1);
      expect(outBuffer).toContain('chromium missing');
      expect(outBuffer).toContain('on disk but will not launch');
      expect(outBuffer).toContain('sudo npx playwright install-deps chromium');
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it('exits 1 when no state file exists', async () => {
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockReturnValue(false);
    const code = await runDoctor('/tmp/.wigolo');
    expect(code).toBe(1);
    expect(outBuffer).toContain('not bootstrapped');
  });

  describe('LLM fallback section', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GROQ_API_KEY;
      delete process.env.WIGOLO_LLM_PROVIDER;
      vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith('state.json'))
          return JSON.stringify({ status: 'ready', searxngPath: '/tmp/sx' });
        if (s.endsWith('searxng.lock'))
          return JSON.stringify({ pid: process.pid, port: 8888 });
        return '';
      });
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('lists all four providers and marks unset ones', async () => {
      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/LLM \(extract \/ research \/ agent\)/);
      expect(outBuffer).toMatch(/anthropic\s+no key/);
      expect(outBuffer).toMatch(/openai\s+no key/);
      expect(outBuffer).toMatch(/gemini\s+no key/);
      expect(outBuffer).toMatch(/groq\s+no key/);
    });

    it('shows resolved model when a provider is configured', async () => {
      process.env.GOOGLE_API_KEY = 'k';
      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/gemini\s+configured.*<- active/);
      expect(outBuffer).toMatch(/model:\s+gemini-2\.5-flash-lite \(default\)/);
    });

    it('shows custom model when WIGOLO_LLM_MODEL set', async () => {
      process.env.GOOGLE_API_KEY = 'k';
      process.env.WIGOLO_LLM_MODEL = 'gemini-2.5-pro';
      try {
        await runDoctor('/tmp/.wigolo');
        expect(outBuffer).toMatch(/model:\s+gemini-2\.5-pro/);
        expect(outBuffer).toMatch(/WIGOLO_LLM_MODEL: gemini-2\.5-pro/);
      } finally {
        delete process.env.WIGOLO_LLM_MODEL;
      }
    });

    it('shows custom URL when WIGOLO_LLM_PROVIDER is URL', async () => {
      process.env.WIGOLO_LLM_PROVIDER = 'http://localhost:11434';
      try {
        await runDoctor('/tmp/.wigolo');
        expect(outBuffer).toMatch(/custom URL.*http:\/\/localhost:11434/);
      } finally {
        delete process.env.WIGOLO_LLM_PROVIDER;
      }
    });

    it('marks providers with their key set as configured', async () => {
      process.env.ANTHROPIC_API_KEY = 'k';
      process.env.GROQ_API_KEY = 'k';
      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/anthropic\s+configured/);
      expect(outBuffer).toMatch(/groq\s+configured/);
      expect(outBuffer).toMatch(/openai\s+no key/);
    });

    it('shows override and budget settings', async () => {
      process.env.WIGOLO_LLM_PROVIDER = 'gemini';
      process.env.WIGOLO_LLM_CACHE_TTL_DAYS = '14';
      process.env.WIGOLO_LLM_MAX_CALLS_PER_REQUEST = '3';
      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/WIGOLO_LLM_PROVIDER=gemini/);
      expect(outBuffer).toMatch(/cache TTL:\s+14 days/);
      expect(outBuffer).toMatch(/per-request:\s+3 call/);
    });

    it('warns when GOOGLE_API_KEY is set with a gemini pro model (free-tier footgun)', async () => {
      process.env.GOOGLE_API_KEY = 'k';
      process.env.WIGOLO_LLM_MODEL_GEMINI = 'gemini-2.5-pro';
      try {
        await runDoctor('/tmp/.wigolo');
        expect(outBuffer).toMatch(/gemini-2\.5-pro/);
        expect(outBuffer).toMatch(/pro.*free.?tier|free.?tier.*pro/i);
        expect(outBuffer).toMatch(/gemini-2\.5-flash/i);
      } finally {
        delete process.env.WIGOLO_LLM_MODEL_GEMINI;
      }
    });

    it('does not warn when gemini model is a flash variant', async () => {
      process.env.GOOGLE_API_KEY = 'k';
      process.env.WIGOLO_LLM_MODEL_GEMINI = 'gemini-2.5-flash';
      try {
        await runDoctor('/tmp/.wigolo');
        expect(outBuffer).not.toMatch(/free.?tier.*pro|pro.*free.?tier/i);
      } finally {
        delete process.env.WIGOLO_LLM_MODEL_GEMINI;
      }
    });

    it('does not warn for pro model when GOOGLE_API_KEY is not set', async () => {
      delete process.env.GOOGLE_API_KEY;
      process.env.WIGOLO_LLM_MODEL_GEMINI = 'gemini-2.5-pro';
      try {
        await runDoctor('/tmp/.wigolo');
        expect(outBuffer).not.toMatch(/free.?tier.*pro|pro.*free.?tier/i);
      } finally {
        delete process.env.WIGOLO_LLM_MODEL_GEMINI;
      }
    });
  });

  describe('V1 extension checks', () => {
    beforeEach(() => {
      vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/sx' });
        if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
        return '';
      });
    });

    it('reports embedding provider ready with model id and dim', async () => {
      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/Core embeddings:/);
      expect(outBuffer).toMatch(/provider:\s+ready \(fastembed BAAI\/bge-small-en-v1\.5, dim=384\)/);
    });

    it('reports embedding provider not ready on failure', async () => {
      vi.mocked(getEmbedProvider).mockRejectedValueOnce(new Error('model download failed'));
      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/provider:\s+not ready \(model download failed\)/);
      // Failure must not flip overall to DEGRADED on its own.
      expect(outBuffer).toMatch(/Overall: OK/);
    });

    it('reports sqlite-vec extension loaded with version', async () => {
      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/Core sqlite-vec:/);
      expect(outBuffer).toMatch(/extension:\s+loaded \(vec_version 0\.1\.7-alpha\.2\)/);
    });

    it('reports sqlite-vec extension not loaded when vec_version throws', async () => {
      vi.mocked(initDatabase).mockReturnValueOnce({
        prepare: () => ({ get: () => { throw new Error('no such function: vec_version'); } }),
      } as unknown as ReturnType<typeof initDatabase>);
      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/extension:\s+not loaded/);
      expect(outBuffer).toMatch(/Overall: OK/);
    });

    it('reports no RSS feeds when none configured', async () => {
      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/RSS feeds:/);
      expect(outBuffer).toMatch(/feeds:\s+none configured \(set WIGOLO_RSS_FEEDS to opt in\)/);
    });

    it('reports configured feeds with item counts and freshness', async () => {
      const fresh = new Date(Date.now() - 3 * 3600_000).toISOString();
      const stale = new Date(Date.now() - 30 * 3600_000).toISOString();
      vi.mocked(loadFeedConfig).mockReturnValueOnce({
        feeds: [
          { url: 'https://example.com/rss' },
          { url: 'https://stale.example/feed' },
          { url: 'https://empty.example/feed' },
        ],
        sources: ['env'],
      });
      const feedDb = {
        prepare: (sql: string) => {
          if (sql.includes('vec_version')) {
            return { get: () => ({ v: '0.1.7-alpha.2' }) };
          }
          return {
            get: (url: string) => {
              if (url === 'https://example.com/rss') return { n: 3, last_at: fresh };
              if (url === 'https://stale.example/feed') return { n: 12, last_at: stale };
              return { n: 0, last_at: null };
            },
          };
        },
      };
      vi.mocked(initDatabase).mockReturnValue(feedDb as unknown as ReturnType<typeof initDatabase>);

      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/https:\/\/example\.com\/rss\s+3 items.*\[fresh\]/);
      expect(outBuffer).toMatch(/https:\/\/stale\.example\/feed\s+12 items.*\[stale\]/);
      expect(outBuffer).toMatch(/https:\/\/empty\.example\/feed\s+0 items \[never polled\]/);
    });

    it('reports telemetry disabled by default', async () => {
      delete process.env.WIGOLO_TELEMETRY;
      await runDoctor('/tmp/.wigolo');
      expect(outBuffer).toMatch(/Telemetry: opt-in disabled \(WIGOLO_TELEMETRY=1/);
    });

    it('reports telemetry enabled when WIGOLO_TELEMETRY=1', async () => {
      process.env.WIGOLO_TELEMETRY = '1';
      try {
        await runDoctor('/tmp/.wigolo');
      } finally {
        delete process.env.WIGOLO_TELEMETRY;
      }
      expect(outBuffer).toMatch(/Telemetry: opt-in enabled/);
    });
  });
});
