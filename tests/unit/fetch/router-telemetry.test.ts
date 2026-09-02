/**
 * `fetch.blocked` and `fetch.tier_escalated` at the router's terminal seam.
 *
 * The arms that matter are the negative ones: a URL with a path, a query and three host
 * labels goes in, and what comes out on the queue must be a bare eTLD+1 and nothing else.
 * The URL is planted with a distinctive token so its absence can be proven by byte search
 * over the serialized queue rather than by inspecting the props we happen to look at.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

vi.mock('../../../src/security/keychain.js', () => {
  const store = new Map<string, string>();
  return {
    keychainAvailable: vi.fn(() => true),
    keychainSet: vi.fn((s: string, u: string, v: string) => { store.set(`${s}:${u}`, v); }),
    keychainGet: vi.fn((s: string, u: string) => store.get(`${s}:${u}`) ?? null),
    keychainDelete: vi.fn((s: string, u: string) => { store.delete(`${s}:${u}`); }),
  };
});

vi.mock('../../../src/fetch/browser-acquire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fetch/browser-acquire.js')>();
  return {
    ...actual,
    BrowserAcquirer: class {
      ensureBrowser = vi.fn(async () => 'ready');
    },
  };
});

const { resetConfig } = await import('../../../src/config.js');
const { AccountStateStore } = await import('../../../src/account/state.js');
const { queuePath } = await import('../../../src/telemetry/queue.js');
const telemetry = await import('../../../src/telemetry/index.js');
const { SmartRouter } = await import('../../../src/fetch/router.js');
const { ChallengeBlockedError } = await import('../../../src/fetch/browser-pool.js');

import type { HttpClient, BrowserPoolInterface } from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';

const ORIGINAL_ENV = process.env;

/** Three host labels, a path and a query — every part of the Never list in one string. */
const PLANTED_URL = 'https://shop.eu.example.co.uk/private/report?q=zqxjkvw-secret-term';
const PLANTED_TOKENS = ['zqxjkvw-secret-term', '/private/report', 'shop.eu.', '?q='];

let dataDir: string;

function activate(): void {
  new AccountStateStore(dataDir).write({ account_id: 'acc_router_telemetry' });
}

/** The serialized queue as bytes — what would actually leave the machine. */
function queueBytes(): string {
  const path = queuePath(dataDir);
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function queuedEvents(): { name: string; props: Record<string, unknown> }[] {
  return queueBytes()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { name: string; props: Record<string, unknown> });
}

function httpResult(url: string, statusCode: number, html: string): RawFetchResult {
  return { url, finalUrl: url, html, contentType: 'text/html', statusCode, method: 'http', headers: {} };
}

describe('SmartRouter telemetry — fetch.blocked and fetch.tier_escalated', () => {
  let httpClient: HttpClient;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-router-telemetry-'));
    process.env = { ...ORIGINAL_ENV };
    process.env.WIGOLO_DATA_DIR = dataDir;
    // Forced ON rather than deleted: leaving it unset makes the switch depend on the
    // ambient absence of a persisted setting, and a byte search over a queue that was
    // silent for that reason passes vacuously. Measured — a settings file with
    // `telemetryEnabled: false` produced exactly that empty-queue false pass.
    process.env.WIGOLO_TELEMETRY = 'on';
    resetConfig();
    telemetry._resetTelemetryForTest();
    httpClient = { fetch: vi.fn() };
  });

  afterEach(() => {
    telemetry._resetTelemetryForTest();
    process.env = ORIGINAL_ENV;
    resetConfig();
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports a challenge block as eTLD+1 only, with no trace of the URL on the wire', async () => {
    activate();
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => { throw new ChallengeBlockedError(url, undefined, undefined, 403); }),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });

    await router.fetch(PLANTED_URL, { renderJs: 'always' });

    const blocked = queuedEvents().filter((e) => e.name === 'fetch.blocked');
    expect(blocked).toHaveLength(1);
    // eTLD+1 of shop.eu.example.co.uk — three labels of site structure reduced away.
    expect(blocked[0].props).toEqual({ domain: 'example.co.uk', signal: 'challenge' });

    // The negative arm. Not "we did not read these props" — these bytes are not present.
    const bytes = queueBytes();
    for (const token of PLANTED_TOKENS) {
      expect(bytes).not.toContain(token);
    }
    expect(bytes).not.toContain(PLANTED_URL);
  });

  it('prefers the challenge signal over the 403 that carried it', async () => {
    activate();
    // A Cloudflare interstitial served AT 403 — the common shape. Reading the status first
    // would relabel most anti-bot walls as ordinary forbidden responses.
    const challengeBody = '<html><head><title>Just a moment...</title></head><body><div id="cf-wrapper">Checking your browser</div></body></html>';
    httpClient = { fetch: vi.fn(async () => ({ url: PLANTED_URL, html: challengeBody, statusCode: 403, headers: { 'cf-mitigated': 'challenge' }, contentType: 'text/html' })) };
    const router = new SmartRouter({ httpClient, pdfProbe: async () => false });

    await router.fetch(PLANTED_URL, { renderJs: 'never' });

    const blocked = queuedEvents().filter((e) => e.name === 'fetch.blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].props.signal).toBe('challenge');
  });

  it('reports a bare 403 as http_403', async () => {
    activate();
    httpClient = { fetch: vi.fn(async () => ({ url: PLANTED_URL, html: '<html><body>Forbidden. You do not have access to this document.</body></html>', statusCode: 403, headers: {}, contentType: 'text/html' })) };
    const router = new SmartRouter({ httpClient, pdfProbe: async () => false });

    await router.fetch(PLANTED_URL, { renderJs: 'never' });

    const blocked = queuedEvents().filter((e) => e.name === 'fetch.blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].props).toEqual({ domain: 'example.co.uk', signal: 'http_403' });
  });

  it('reports the tier reached, once, when the fetch escalated past http', async () => {
    activate();
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => ({ ...httpResult(url, 200, '<html><body>rendered article body with plenty of real words in it</body></html>'), method: 'browser' as const })),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });

    await router.fetch('https://example.com/a', { renderJs: 'always' });

    const escalated = queuedEvents().filter((e) => e.name === 'fetch.tier_escalated');
    expect(escalated).toHaveLength(1);
    expect(escalated[0].props).toEqual({ to_tier: 'browser' });
  });

  it('reports nothing when the base http tier served the page', async () => {
    activate();
    httpClient = { fetch: vi.fn(async () => ({ url: 'https://example.com/a', html: '<html><body>a perfectly ordinary page with enough words to look substantive</body></html>', statusCode: 200, headers: {}, contentType: 'text/html' })) };
    const router = new SmartRouter({ httpClient, pdfProbe: async () => false });

    await router.fetch('https://example.com/a', { renderJs: 'never' });

    expect(queuedEvents()).toHaveLength(0);
  });

  it('drops the event rather than reporting a host with no registrable domain', async () => {
    activate();
    httpClient = { fetch: vi.fn(async () => ({ url: 'http://127.0.0.1:9/x', html: '<html><body>Forbidden. Access denied to this resource.</body></html>', statusCode: 403, headers: {}, contentType: 'text/html' })) };
    const router = new SmartRouter({ httpClient, pdfProbe: async () => false });

    await router.fetch('http://127.0.0.1:9/x', { renderJs: 'never', source: 'human' });

    // An IP literal has no eTLD+1. Reporting a placeholder would invent a domain that was
    // never fetched; reporting the literal would ship an address. Neither happens.
    expect(queuedEvents().filter((e) => e.name === 'fetch.blocked')).toHaveLength(0);
  });

  it('writes nothing at all on an install that was never activated', async () => {
    // No activate() — the state file has no account id.
    httpClient = { fetch: vi.fn(async () => ({ url: PLANTED_URL, html: '<html><body>Forbidden. No access.</body></html>', statusCode: 403, headers: {}, contentType: 'text/html' })) };
    const router = new SmartRouter({ httpClient, pdfProbe: async () => false });

    await router.fetch(PLANTED_URL, { renderJs: 'never' });

    expect(queueBytes()).toBe('');
  });
});
