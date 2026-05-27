/**
 * Builds a minimal SmartRouter wired with just the HTTP client (no browser
 * pool) for the capability smoke probes in verifyEndToEnd.
 *
 * We intentionally avoid spinning up a full Playwright pool here — the smoke
 * probe targets a stable URL (example.com) that never needs JS rendering.
 * This keeps the probe cheap and avoids browser-cold-start latency.
 */
import { SmartRouter, type HttpClient } from '../../../fetch/router.js';
import { httpFetch } from '../../../fetch/http-client.js';

let cached: SmartRouter | null = null;

export async function buildMinimalRouter(): Promise<SmartRouter> {
  if (cached) return cached;
  const httpClient: HttpClient = {
    fetch: (url, options) => httpFetch(url, options),
  };
  cached = new SmartRouter({ httpClient });
  return cached;
}
