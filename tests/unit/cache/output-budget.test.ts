import { describe, it, expect } from 'vitest';
import {
  applyCacheOutputBudget,
  DEFAULT_CACHE_MAX_TOKENS_OUT,
} from '../../../src/cache/output-budget.js';
import type { CacheResultItem } from '../../../src/types.js';

function row(markdown: string, url = 'https://example.com/a'): CacheResultItem {
  return {
    url,
    title: 'A page',
    markdown,
    fetched_at: '2026-08-15T00:00:00',
    source: 'cache',
    trusted: false,
  };
}

const prose =
  'The pool keeps a bounded set of open sockets so a request does not pay the ' +
  'handshake cost every time. When it is exhausted the caller waits.\n\n';

describe('applyCacheOutputBudget', () => {
  // MUST NOT FIRE. A budget that reports truncation on content it did not touch
  // teaches callers to ignore the field.
  it('reports nothing when every body already fits', () => {
    const rows = [row(prose), row(prose, 'https://example.com/b')];
    const out = applyCacheOutputBudget(rows, 5000);

    expect(out.truncation).toBeUndefined();
    expect(out.results[0].markdown).toBe(prose);
    expect(out.results[0].truncated).toBeUndefined();
  });

  // OVER-FIRE PROBE.
  it('reports nothing for an empty result list', () => {
    expect(applyCacheOutputBudget([], 1).truncation).toBeUndefined();
  });

  // MUST NOT FIRE. A cached row with no body was already empty; the budget did
  // not drop it and must not claim it did.
  it('does not label a row that had no body to begin with', () => {
    const out = applyCacheOutputBudget([row(''), row(prose.repeat(400), 'https://example.com/b')], 50);

    expect(out.results[0].truncated).toBeUndefined();
    expect(out.truncation!.results_omitted + out.truncation!.results_truncated).toBe(1);
  });

  it('accounts for every dropped character', () => {
    const rows = [
      row(prose.repeat(400)),
      row(prose.repeat(400), 'https://example.com/b'),
      row(prose.repeat(400), 'https://example.com/c'),
    ];
    const original = rows.reduce((n, r) => n + r.markdown.length, 0);

    const out = applyCacheOutputBudget(rows, 300);

    const returned = out.results.reduce((n, r) => n + r.markdown.length, 0);
    expect(out.truncation!.original_chars).toBe(original);
    expect(out.truncation!.returned_chars).toBe(returned);
    expect(out.truncation!.dropped_chars).toBe(original - returned);
  });

  it('falls back to the default budget when the caller passes none', () => {
    const out = applyCacheOutputBudget([row(prose.repeat(5000))], undefined);
    expect(out.truncation!.budget_tokens).toBe(DEFAULT_CACHE_MAX_TOKENS_OUT);
  });

  // Boundary-aware truncation, consistent with the repair the brief-text cut
  // already uses: a cut inside a construct is dropped, never shipped half-open.
  it('does not leave a fenced code block hanging open', () => {
    const body = `${prose}Here is the config:\n\n\`\`\`json\n${'  "retries": 3,\n'.repeat(200)}`;
    const out = applyCacheOutputBudget([row(body)], 400);

    const md = out.results[0].markdown;
    expect(md.length).toBeLessThan(body.length);
    expect((md.match(/```/g) ?? []).length % 2).toBe(0);
    expect(md).toMatch(/content truncated/);
  });

  // A body that IS one code fence — a gist, a raw config, a source-file page —
  // is where the subtractive repair has nothing to fall back to: it deletes the
  // fence and everything in it, leaving the cut unrepaired. The fixture above
  // cannot catch this because its prose survives the repair and takes the fence
  // count to zero. No prose here, so the fence is the whole body.
  it.each([400, 1000])('closes the fence on a body that is nothing but code (@%i tokens)', (budget) => {
    const body = '```json\n' + '  "retries": 3,\n'.repeat(3000) + '```\n';

    const out = applyCacheOutputBudget([row(body)], budget);

    const md = out.results[0].markdown;
    expect((md.match(/```/g) ?? []).length % 2).toBe(0);
    // The row must still carry code — repairing it away to a bare marker is the
    // silent-empty-body failure this budget exists to avoid.
    expect(md).toMatch(/"retries": 3,/);
    // And the cut must not land mid-line inside the block.
    const code = md.replace(/\n\n\[\.\.\. content truncated\]$/, '');
    expect(code.trimEnd().endsWith('```')).toBe(true);
  });

  // A body with no sentence or paragraph break near the cut point falls through
  // to the hard cut, which is what actually lands inside a link — prose with
  // paragraph breaks never gets there, so it cannot test this.
  it.each([
    [200, 'an unclosed link label'],
    [500, 'a half-written link target'],
  ])('does not leave %i-token cut ending in %s', (budget) => {
    const body = Array.from({ length: 80 }, (_, i) =>
      `[pooling guide ${i}](https://example.com/docs/pooling/section-${i}/deep/path)`,
    ).join(' ');

    const out = applyCacheOutputBudget([row(body)], budget);

    const md = out.results[0].markdown.replace(/\n\n\[\.\.\. content truncated\]$/, '');
    expect(md.length).toBeLessThan(body.length);
    expect(md).not.toMatch(/\[[^\]]*$/);
    expect(md).not.toMatch(/\]\([^)]*$/);
  });
});
