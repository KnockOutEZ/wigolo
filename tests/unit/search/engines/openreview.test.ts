import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenReviewEngine } from '../../../../src/search/engines/openreview.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(body: unknown, ok = true, status = 200): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  return { calls };
}

/** Wrap plain title/abstract strings in OpenReview's `{ value: ... }` fields. */
function note(fields: { forum?: string; title?: string; abstract?: string }): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  if (fields.title !== undefined) content.title = { value: fields.title };
  if (fields.abstract !== undefined) content.abstract = { value: fields.abstract };
  return { forum: fields.forum, content };
}

function orBody(notes: Array<Record<string, unknown>>): Record<string, unknown> {
  return { notes };
}

describe('OpenReviewEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to openreview', () => {
    expect(new OpenReviewEngine().name).toBe('openreview');
  });

  it('maps a successful response into RawSearchResult fields', async () => {
    const body = orBody([
      note({ forum: 'abc123', title: 'Block Transformer', abstract: 'We introduce the Block Transformer.' }),
      note({ forum: 'def456', title: 'Diffusion Models' }),
    ]);
    captureFetch(body);
    const results = await new OpenReviewEngine().search('transformer');

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Block Transformer');
    // URL is built from the forum id, not returned directly.
    expect(results[0].url).toBe('https://openreview.net/forum?id=abc123');
    expect(results[0].snippet).toBe('We introduce the Block Transformer.');
    expect(results[0].engine).toBe('openreview');
    expect(results[0].relevance_score).toBe(1);
    // OpenReview notes carry no publication date on this endpoint.
    expect(results[0].published_date).toBeUndefined();
    // No abstract field → empty snippet, not padded noise.
    expect(results[1].snippet).toBe('');
  });

  // The source=forum filter is the design decision that keeps this engine
  // returning papers rather than their reviews. Lock it into the request so a
  // refactor can't silently drop it and let reviews back into the result set.
  it('sends source=forum so only paper submissions are searched', async () => {
    const { calls } = captureFetch(orBody([]));
    await new OpenReviewEngine().search('q');
    expect(calls[0].url).toContain('source=forum');
  });

  it('reads title and abstract out of the { value } wrapper', async () => {
    const body = orBody([note({ forum: 'f', title: 'Wrapped', abstract: 'Also wrapped.' })]);
    captureFetch(body);
    const results = await new OpenReviewEngine().search('q');
    expect(results[0].title).toBe('Wrapped');
    expect(results[0].snippet).toBe('Also wrapped.');
  });

  it('truncates the abstract to the snippet limit', async () => {
    const body = orBody([note({ forum: 'f', title: 't', abstract: 'x'.repeat(500) })]);
    captureFetch(body);
    const results = await new OpenReviewEngine().search('q');
    expect(results[0].snippet.length).toBe(200);
  });

  it('skips a note with no title', async () => {
    const body = orBody([
      note({ forum: 'f1', abstract: 'orphan abstract' }),
      note({ forum: 'f2', title: 'real' }),
    ]);
    captureFetch(body);
    const results = await new OpenReviewEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('real');
  });

  it('skips a note with no forum id', async () => {
    const body = orBody([
      note({ title: 'no forum' }),
      note({ forum: 'f', title: 'keeper' }),
    ]);
    captureFetch(body);
    const results = await new OpenReviewEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('keeper');
  });

  it('returns empty array when notes are empty', async () => {
    captureFetch(orBody([]));
    expect(await new OpenReviewEngine().search('q')).toEqual([]);
  });

  it('returns empty array when the notes key is missing', async () => {
    captureFetch({});
    expect(await new OpenReviewEngine().search('q')).toEqual([]);
  });

  it('throws on non-ok responses', async () => {
    captureFetch({}, false, 500);
    await expect(new OpenReviewEngine().search('q')).rejects.toThrow(/OpenReview returned 500/);
  });

  it('throws on malformed JSON', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('invalid json');
        },
      } as unknown as Response;
    });
    await expect(new OpenReviewEngine().search('q')).rejects.toThrow(/invalid json/);
  });

  it('passes AbortSignal.timeout to fetch', async () => {
    const { calls } = captureFetch(orBody([]));
    await new OpenReviewEngine().search('q', { timeoutMs: 5000 });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('encodes query and limit from the query and maxResults', async () => {
    const { calls } = captureFetch(orBody([]));
    await new OpenReviewEngine().search('graph neural', { maxResults: 15 });
    expect(calls[0].url).toContain('query=graph+neural');
    expect(calls[0].url).toContain('limit=15');
  });
});
