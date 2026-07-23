import { describe, it, expect, vi } from 'vitest';
import {
  isRedditUrl,
  mapRedditUrlToEndpoint,
  mapRedditApiPayload,
  RedditTokenManager,
  RedditRateLimitError,
  fetchViaRedditApi,
  type RedditCredentials,
  type FetchFn,
} from '../../../src/fetch/reddit-api.js';

const CREDS: RedditCredentials = {
  clientId: 'client-id-123',
  clientSecret: 'super-secret-value',
  userAgent: 'web:wigolo:test',
};

/** Build a minimal Response-like object for the injected fetch. */
function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// isRedditUrl
// ---------------------------------------------------------------------------

describe('isRedditUrl', () => {
  it('matches reddit host families', () => {
    expect(isRedditUrl('https://reddit.com/r/rust')).toBe(true);
    expect(isRedditUrl('https://www.reddit.com/r/rust')).toBe(true);
    expect(isRedditUrl('https://old.reddit.com/r/rust/comments/abc/x')).toBe(true);
    expect(isRedditUrl('https://np.reddit.com/r/rust')).toBe(true);
    expect(isRedditUrl('https://redd.it/abc123')).toBe(true);
    expect(isRedditUrl('https://foo.reddit.com/x')).toBe(true);
  });

  it('rejects non-reddit hosts', () => {
    expect(isRedditUrl('https://example.com/r/rust')).toBe(false);
    expect(isRedditUrl('https://notreddit.com')).toBe(false);
    // A host that merely contains the substring but is a different domain.
    expect(isRedditUrl('https://reddit.com.evil.example')).toBe(false);
    expect(isRedditUrl('not a url')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// URL → endpoint mapping
// ---------------------------------------------------------------------------

describe('mapRedditUrlToEndpoint', () => {
  it('maps a subreddit listing (default hot)', () => {
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/rust')).toBe('/r/rust/hot');
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/rust/')).toBe('/r/rust/hot');
  });

  it('maps a subreddit listing with an explicit sort', () => {
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/rust/top')).toBe('/r/rust/top');
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/rust/new')).toBe('/r/rust/new');
  });

  it('maps a comments / post URL', () => {
    expect(
      mapRedditUrlToEndpoint('https://www.reddit.com/r/rust/comments/abc123/some_title/'),
    ).toBe('/r/rust/comments/abc123');
  });

  it('maps a user URL', () => {
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/user/spez')).toBe('/user/spez/about');
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/u/spez')).toBe('/user/spez/about');
  });

  it('returns null for unknown reddit shapes (falls through)', () => {
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/')).toBeNull();
    expect(mapRedditUrlToEndpoint('https://redd.it/abc123')).toBeNull();
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/settings')).toBeNull();
  });

  it('sanitizes path segments so no injection reaches the endpoint', () => {
    // A crafted segment must not smuggle characters outside [A-Za-z0-9_-] into
    // the constructed endpoint path.
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/ru$st!/hot')).toBe('/r/rust/hot');
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/a.b.c/hot')).toBe('/r/abc/hot');
  });
});

// ---------------------------------------------------------------------------
// Token manager
// ---------------------------------------------------------------------------

describe('RedditTokenManager', () => {
  it('mints a token once and caches it within the validity window', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ access_token: 'tok-1', expires_in: 3600 }),
    );
    let clock = 1_000_000;
    const mgr = new RedditTokenManager(CREDS, fetchFn as unknown as FetchFn, () => clock);

    expect(await mgr.getToken()).toBe('tok-1');
    clock += 60_000; // still well inside the window
    expect(await mgr.getToken()).toBe('tok-1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refreshes the token after expiry', async () => {
    const fetchFn = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-2', expires_in: 3600 }));
    let clock = 0;
    const mgr = new RedditTokenManager(CREDS, fetchFn as unknown as FetchFn, () => clock);

    expect(await mgr.getToken()).toBe('tok-1');
    clock += 3_600_000 + 1; // past expiry
    expect(await mgr.getToken()).toBe('tok-2');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('sends a correct Basic auth header and never leaks the secret in a logged line', async () => {
    const logSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ access_token: 'tok-1', expires_in: 3600 }),
    );
    const mgr = new RedditTokenManager(CREDS, fetchFn as unknown as FetchFn, () => 0);
    await mgr.getToken();

    const [tokenUrl, opts] = fetchFn.mock.calls[0];
    expect(tokenUrl).toBe('https://www.reddit.com/api/v1/access_token');
    const headers = (opts as RequestInit).headers as Record<string, string>;
    const expectedBasic = Buffer.from('client-id-123:super-secret-value').toString('base64');
    expect(headers.Authorization).toBe(`Basic ${expectedBasic}`);
    expect((opts as RequestInit).body).toBe('grant_type=client_credentials');

    // No stderr line contains the raw secret.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('super-secret-value');
    logSpy.mockRestore();
  });

  it('throws when the token response is not ok', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(jsonResponse({}, { status: 401 }));
    const mgr = new RedditTokenManager(CREDS, fetchFn as unknown as FetchFn, () => 0);
    await expect(mgr.getToken()).rejects.toThrow(/HTTP 401/);
  });
});

// ---------------------------------------------------------------------------
// JSON → result mapping
// ---------------------------------------------------------------------------

describe('mapRedditApiPayload', () => {
  it('maps a comments thread payload into title/markdown/comments', () => {
    const payload = [
      {
        kind: 'Listing',
        data: {
          children: [
            {
              kind: 't3',
              data: {
                title: 'Why is Rust great',
                author: 'alice',
                subreddit: 'rust',
                selftext: 'Because of ownership.',
                score: 42,
                upvote_ratio: 0.98,
                created_utc: 1_700_000_000,
              },
            },
          ],
        },
      },
      {
        kind: 'Listing',
        data: {
          children: [
            { kind: 't1', data: { author: 'bob', body: 'Agreed!', score: 10, replies: '' } },
            { kind: 't1', data: { author: 'carol', body: 'Best takes', score: 99, replies: '' } },
          ],
        },
      },
    ];
    const result = mapRedditApiPayload(payload, '/r/rust/comments/abc123');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Why is Rust great');
    expect(result!.markdown).toContain('# Why is Rust great');
    expect(result!.markdown).toContain('Because of ownership.');
    const sd = result!.site_data as { comments: Array<{ author: string; score: number }> };
    // Comments sorted by score desc.
    expect(sd.comments[0].author).toBe('carol');
    expect(sd.comments[0].score).toBe(99);
    expect(sd.comments[1].author).toBe('bob');
  });

  it('maps a subreddit listing into a link index', () => {
    const payload = {
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't3',
            data: {
              title: 'Post One',
              subreddit: 'rust',
              score: 5,
              num_comments: 3,
              permalink: '/r/rust/comments/p1/post_one/',
            },
          },
        ],
      },
    };
    const result = mapRedditApiPayload(payload, '/r/rust/hot');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('r/rust');
    expect(result!.markdown).toContain('[Post One](https://www.reddit.com/r/rust/comments/p1/post_one/)');
  });

  it('maps a user about payload', () => {
    const payload = { kind: 't2', data: { name: 'spez', link_karma: 100, comment_karma: 200, created_utc: 0 } };
    const result = mapRedditApiPayload(payload, '/user/spez/about');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('u/spez');
    expect(result!.markdown).toContain('Link karma: 100');
  });
});

// ---------------------------------------------------------------------------
// fetchViaRedditApi
// ---------------------------------------------------------------------------

describe('fetchViaRedditApi', () => {
  function tokenThen(dataResponse: Response): FetchFn {
    const fn = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(dataResponse);
    return fn as unknown as FetchFn;
  }

  it('fetches a listing and returns a RawFetchResult with method=reddit-api', async () => {
    const dataPayload = {
      kind: 'Listing',
      data: { children: [{ kind: 't3', data: { title: 'A', subreddit: 'rust', score: 1, num_comments: 0, permalink: '/r/rust/comments/a/a/' } }] },
    };
    const fetchFn = tokenThen(jsonResponse(dataPayload));
    const mgr = new RedditTokenManager(CREDS, fetchFn, () => 0);

    const result = await fetchViaRedditApi('https://www.reddit.com/r/rust', mgr, CREDS, fetchFn);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('reddit-api');
    expect(result!.statusCode).toBe(200);
    expect(result!.html).toContain('# r/rust');
    expect(result!.contentType).toBe('text/markdown');
  });

  it('returns null for an unsupported reddit shape (falls through)', async () => {
    const fetchFn = vi.fn<FetchFn>();
    const mgr = new RedditTokenManager(CREDS, fetchFn as unknown as FetchFn, () => 0);
    const result = await fetchViaRedditApi('https://redd.it/abc123', mgr, CREDS, fetchFn as unknown as FetchFn);
    expect(result).toBeNull();
    // Never even minted a token for an unsupported shape.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws RedditRateLimitError with Retry-After on 429', async () => {
    const fetchFn = tokenThen(jsonResponse({}, { status: 429, headers: { 'retry-after': '120' } }));
    const mgr = new RedditTokenManager(CREDS, fetchFn, () => 0);
    const err = await fetchViaRedditApi('https://www.reddit.com/r/rust', mgr, CREDS, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(RedditRateLimitError);
    expect((err as RedditRateLimitError).retryAfterSeconds).toBe(120);
  });

  it('throws RedditRateLimitError with null Retry-After when the header is absent', async () => {
    const fetchFn = tokenThen(jsonResponse({}, { status: 429 }));
    const mgr = new RedditTokenManager(CREDS, fetchFn, () => 0);
    const err = await fetchViaRedditApi('https://www.reddit.com/r/rust', mgr, CREDS, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(RedditRateLimitError);
    expect((err as RedditRateLimitError).retryAfterSeconds).toBeNull();
  });

  it('constructs an oauth.reddit.com endpoint host regardless of input path trickery (SSRF)', async () => {
    const dataPayload = { kind: 'Listing', data: { children: [] } };
    const fetchFn = tokenThen(jsonResponse(dataPayload));
    const mgr = new RedditTokenManager(CREDS, fetchFn, () => 0);

    // A hostile path with an embedded @ / host-like segment must not redirect
    // egress off oauth.reddit.com — the host comes from the fixed base only.
    await fetchViaRedditApi(
      'https://www.reddit.com/r/rust@evil.example/hot',
      mgr,
      CREDS,
      fetchFn,
    );
    const dataCall = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    const calledUrl = new URL(dataCall[0] as string);
    expect(calledUrl.hostname).toBe('oauth.reddit.com');
  });
});
