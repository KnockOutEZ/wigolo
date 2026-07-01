import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleExtract } from '../../src/tools/extract.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';
import type { SmartRouter } from '../../src/fetch/router.js';

// Build a single HTML table with N rows of long fixed text. Each row is ~600
// chars before JSON serialization — 60 rows is comfortably over the 30000-char
// default cap once serialized as JSON.
function buildBigTableHtml(rows: number): string {
  const headerRow = '<tr>' + ['Quarter', 'Revenue', 'Notes'].map((h) => `<th>${h}</th>`).join('') + '</tr>';
  const longCellText = 'Long descriptive text segment about a quarterly result for testing token discipline. '.repeat(
    6,
  );
  const bodyRows: string[] = [];
  for (let i = 0; i < rows; i++) {
    bodyRows.push(
      '<tr>' +
        `<td>Q${i}</td>` +
        `<td>$${1000 + i}M</td>` +
        `<td>${longCellText}</td>` +
        '</tr>',
    );
  }
  return `<html><body><table>${headerRow}${bodyRows.join('')}</table></body></html>`;
}

function makeRouter(): SmartRouter {
  // Not used — tests pass html directly.
  return {} as unknown as SmartRouter;
}

// extract mode=tables should apply an implicit cap (~30000 chars) when no
// max_tokens_out is provided, AND surface a `truncated: true` marker so the
// caller knows the payload was clipped.
describe('extract mode=tables — H3 default size cap + truncation marker', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('returns truncated:true when the table payload exceeds the default cap', async () => {
    const html = buildBigTableHtml(60);
    const __r = await handleExtract({ html, mode: 'tables' }, makeRouter());
    expect(__r.ok).toBe(true);
    const out = __r.ok ? __r.data : ({ ...__r } as any);
    expect(out.mode).toBe('tables');
    expect(Array.isArray(out.data)).toBe(true);
    // Truncation marker must surface so callers can detect the clip.
    expect(out.truncated).toBe(true);
    // The serialized payload must be below the 30000-char default cap.
    const serialized = JSON.stringify(out.data);
    expect(serialized.length).toBeLessThanOrEqual(30000);
  });

  it('does NOT mark truncated when the payload fits under the default cap', async () => {
    // Small table that comfortably fits.
    const html = buildBigTableHtml(2);
    const __r = await handleExtract({ html, mode: 'tables' }, makeRouter());
    expect(__r.ok).toBe(true);
    const out = __r.ok ? __r.data : ({ ...__r } as any);
    expect(out.mode).toBe('tables');
    expect(out.truncated).toBeFalsy();
  });

  it('honors an explicit max_tokens_out instead of the default cap', async () => {
    const html = buildBigTableHtml(60);
    const __r = await handleExtract(
      { html, mode: 'tables', max_tokens_out: 2000 },
      makeRouter(),
    );
    expect(__r.ok).toBe(true);
    const out = __r.ok ? __r.data : ({ ...__r } as any);
    expect(out.mode).toBe('tables');
    // With explicit max_tokens_out, the existing token-based clamp runs and
    // produces a smaller payload than the default-cap path.
    const serialized = JSON.stringify(out.data);
    expect(serialized.length).toBeLessThan(30000);
  });
});
