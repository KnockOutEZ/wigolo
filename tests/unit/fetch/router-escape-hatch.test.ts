import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

// Browser-acquire mock — report the engine "ready" without a real install so
// browser-tier paths reach the mocked browserPool. On a browserless CI runner
// the real ensureBrowser() attempts an install and hangs past the test timeout.
// Tests needing the "unavailable" branch spy on their own instance to override.
vi.mock('../../../src/fetch/browser-acquire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fetch/browser-acquire.js')>();
  return {
    ...actual,
    BrowserAcquirer: class {
      ensureBrowser = vi.fn(async () => 'ready');
    },
  };
});

import { SmartRouter } from '../../../src/fetch/router.js';
import type {
  HttpClient,
  BrowserPoolInterface,
  EscapeHatchFetchers,
} from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import { ChallengeBlockedError } from '../../../src/fetch/browser-pool.js';
import { expectContent, expectStageError } from '../../helpers/fetch-result.js';

const originalEnv = process.env;

function clearedResult(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html>cleared by escape hatch</html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
    escalated: true,
  };
}

describe('SmartRouter escape-hatch ladder', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  // Bound to the REAL rung types: declared ReturnType<typeof vi.fn> and cast in,
  // neither spy had to satisfy EscapeHatchFetchers.
  let solverFetch: MockedFunction<EscapeHatchFetchers['solverFetch']>;
  let hostedReaderFetch: MockedFunction<EscapeHatchFetchers['hostedReaderFetch']>;
  let escapeHatch: EscapeHatchFetchers;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    httpClient = { fetch: vi.fn() };
    // Browser tier always hits a hard challenge-block.
    browserPool = {
      fetchWithBrowser: vi.fn(async (url: string) => {
        throw new ChallengeBlockedError(url);
      }),
    };
    solverFetch = vi.fn(async () => null);
    hostedReaderFetch = vi.fn(async () => null);
    escapeHatch = { solverFetch, hostedReaderFetch };
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('does NOT invoke any rung when neither solver nor reader is configured', async () => {
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      escapeHatch,
    });
    const result = expectStageError(await router.fetch('https://blocked.example.com/x', { renderJs: 'always' }));
    expect(result.error).toBe('blocked_by_challenge');
    expect(solverFetch).not.toHaveBeenCalled();
    expect(hostedReaderFetch).not.toHaveBeenCalled();
  });

  it('tries solver first when solverUrl is set; a solved page short-circuits', async () => {
    process.env.WIGOLO_SOLVER_URL = 'http://127.0.0.1:8191';
    process.env.WIGOLO_HOSTED_READER_URL = 'https://reader.example.com';
    resetConfig();
    solverFetch.mockResolvedValueOnce(clearedResult('https://blocked.example.com/x'));
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      escapeHatch,
    });
    const result = expectContent(await router.fetch('https://blocked.example.com/x', { renderJs: 'always' }));
    expect(result.html).toContain('cleared by escape hatch');
    expect(solverFetch).toHaveBeenCalledOnce();
    // Solver cleared it — reader is never tried.
    expect(hostedReaderFetch).not.toHaveBeenCalled();
  });

  it('falls through to the reader when the solver returns null', async () => {
    process.env.WIGOLO_SOLVER_URL = 'http://127.0.0.1:8191';
    process.env.WIGOLO_HOSTED_READER_URL = 'https://reader.example.com';
    resetConfig();
    solverFetch.mockResolvedValueOnce(null);
    hostedReaderFetch.mockResolvedValueOnce(clearedResult('https://blocked.example.com/x'));
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      escapeHatch,
    });
    const result = expectContent(await router.fetch('https://blocked.example.com/x', { renderJs: 'always' }));
    expect(result.html).toContain('cleared by escape hatch');
    expect(solverFetch).toHaveBeenCalledOnce();
    expect(hostedReaderFetch).toHaveBeenCalledOnce();
  });

  it('returns the terminal blocked_by_challenge when all configured rungs fail', async () => {
    process.env.WIGOLO_SOLVER_URL = 'http://127.0.0.1:8191';
    resetConfig();
    solverFetch.mockResolvedValueOnce(null);
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      escapeHatch,
    });
    const result = expectStageError(await router.fetch('https://blocked.example.com/x', { renderJs: 'always' }));
    expect(result.error).toBe('blocked_by_challenge');
    expect(solverFetch).toHaveBeenCalledOnce();
  });

  it('only the reader rung fires when just hostedReaderUrl is set', async () => {
    process.env.WIGOLO_HOSTED_READER_URL = 'https://reader.example.com';
    resetConfig();
    hostedReaderFetch.mockResolvedValueOnce(clearedResult('https://blocked.example.com/x'));
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      escapeHatch,
    });
    const result = expectContent(await router.fetch('https://blocked.example.com/x', { renderJs: 'always' }));
    expect(result.html).toContain('cleared by escape hatch');
    expect(solverFetch).not.toHaveBeenCalled();
    expect(hostedReaderFetch).toHaveBeenCalledOnce();
  });
});
