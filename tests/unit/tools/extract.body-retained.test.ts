import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn(),
  isExpired: vi.fn(),
}));

import { handleExtract } from '../../../src/tools/extract.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

function makeRouter(html: string): SmartRouter {
  return {
    fetch: async () => ({
      url: 'https://example.com/article',
      finalUrl: 'https://example.com/article',
      html,
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

// Bench (v0.1.12 stress test) flagged: `named_schema=Article` returns
// {title, url, author, date, language} only. body got dropped because the
// per-object token clamp skipped over-budget fields instead of truncating
// them. Result: callers think the schema is "too thin" / has no content.

describe('extract named_schema=Article retains body even on tight budget', () => {
  it('keeps a truncated body string when max_tokens_out is below full size', async () => {
    const bodyText = 'PostgreSQL 18 introduces async I/O. '.repeat(200);
    const html = `
      <html>
        <head><title>PG 18 Release</title></head>
        <body>
          <article>
            <h1>PG 18 Release</h1>
            <p>${bodyText}</p>
          </article>
        </body>
      </html>
    `;

    const result = await handleExtract(
      { url: 'https://example.com/article', mode: 'schema', named_schema: 'Article', max_tokens_out: 400 },
      makeRouter(html),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data.data as Record<string, unknown>;
      expect(data.title).toBeTruthy();
      // The bug: body would be missing/empty entirely.
      expect(typeof data.body).toBe('string');
      expect((data.body as string).length).toBeGreaterThan(50);
      // The body was truncated to fit the budget — that clip must be signaled.
      expect(result.data.truncated).toBe(true);
    }
  });
});
