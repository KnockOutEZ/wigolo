import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logger.js', () => {
  const calls: { level: string; msg: string; meta: unknown }[] = [];
  const make = () => ({
    info: (msg: string, meta?: unknown) => calls.push({ level: 'info', msg, meta }),
    warn: (msg: string, meta?: unknown) => calls.push({ level: 'warn', msg, meta }),
    error: (msg: string, meta?: unknown) => calls.push({ level: 'error', msg, meta }),
    debug: (msg: string, meta?: unknown) => calls.push({ level: 'debug', msg, meta }),
  });
  return {
    createLogger: () => make(),
    __getLastCalls: () => calls,
  };
});

import { extractStructuredData } from '../../../src/extraction/structured-data.js';

describe('structured-data logging', () => {
  it('warns on malformed JSON-LD', async () => {
    const html = '<html><head><script type="application/ld+json">{not json</script></head></html>';
    extractStructuredData(html);
    const logger = await import('../../../src/logger.js');
    // @ts-expect-error helper exposed by mock
    const calls = logger.__getLastCalls();
    expect(calls.some((c: { level: string; msg: string }) => c.level === 'warn' && /JSON-LD/i.test(c.msg))).toBe(true);
  });
});
