import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { guardNavigation } from '../security/ssrf.js';

const log = createLogger('search');

export async function validateLinks<T extends { url: string }>(
  results: T[],
  options?: { maxConcurrent?: number },
): Promise<T[]> {
  const config = getConfig();

  if (!config.validateLinks) return results;

  const maxConcurrent = options?.maxConcurrent ?? 5;
  const timeoutMs = config.validateTimeoutMs;
  const valid: T[] = [];

  for (let i = 0; i < results.length; i += maxConcurrent) {
    const batch = results.slice(i, i + maxConcurrent);
    const checks = batch.map(async (result): Promise<{ result: T; ok: boolean }> => {
      // R1 seal (P6-a SSRF): guard the discovered URL before probing it. Agent-source content-path
      // matrix — block cloud-metadata/link-local + RFC1918; allow loopback. A blocked URL is dropped
      // from the validated set, NEVER fetched (no blind internal probe / metadata reach).
      if (!guardNavigation(result.url, { source: 'agent', allowLoopback: true }).ok) {
        return { result, ok: false };
      }
      try {
        // `redirect: 'manual'` — never auto-follow a hop (the SSRF-via-redirect bypass: a public URL
        // that 30x-redirects to an internal address). A 3xx is itself treated as reachable/valid.
        const response = await fetch(result.url, {
          method: 'HEAD',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { result, ok: response.status < 400 };
      } catch {
        log.debug('link validation failed', { url: result.url });
        return { result, ok: false };
      }
    });

    const batchResults = await Promise.all(checks);
    for (const { result, ok } of batchResults) {
      if (ok) valid.push(result);
    }
  }

  return valid;
}
