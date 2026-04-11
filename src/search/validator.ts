import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

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
      try {
        const response = await fetch(result.url, {
          method: 'HEAD',
          redirect: 'follow',
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
