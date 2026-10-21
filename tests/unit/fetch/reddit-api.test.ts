import { describe, it, expect, vi, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
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

// Guard against config/env bleed between tests (the secret-leak test toggles
// WIGOLO_LOG_LEVEL and calls resetConfig).
afterEach(() => {
  resetConfig();
});

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

  it('REFUSES a segment carrying anything outside [A-Za-z0-9_-] rather than sanitizing it', () => {
    // Stripping the offending characters kept the endpoint safe but silently
    // fetched a DIFFERENT resource (`/r/a.b.c` -> the real `/r/abc`). Refusing
    // is strictly stronger: no injection reaches the endpoint AND no wrong
    // community is served in place of the requested one.
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/ru$st!/hot')).toBeNull();
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/a.b.c/hot')).toBeNull();
    // The legal name is unaffected.
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/rust/hot')).toBe('/r/rust/hot');
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
    // The mint logs at debug; force debug-level logging so a secret leak on the
    // debug line is actually OBSERVABLE (default level is info, which would
    // silently swallow the line and make this assertion vacuous).
    const prevLevel = process.env.LOG_LEVEL;
    const prevTui = process.env.WIGOLO_TUI_MODE;
    process.env.LOG_LEVEL = 'debug';
    delete process.env.WIGOLO_TUI_MODE; // ensure logs go to stderr, not a file
    resetConfig();
    const logSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ access_token: 'tok-leak-check', expires_in: 3600 }),
    );
    const mgr = new RedditTokenManager(CREDS, fetchFn as unknown as FetchFn, () => 0);
    await mgr.getToken();

    const [tokenUrl, opts] = fetchFn.mock.calls[0];
    expect(tokenUrl).toBe('https://www.reddit.com/api/v1/access_token');
    const headers = (opts as RequestInit).headers as Record<string, string>;
    const expectedBasic = Buffer.from('client-id-123:super-secret-value').toString('base64');
    expect(headers.Authorization).toBe(`Basic ${expectedBasic}`);
    expect((opts as RequestInit).body).toBe('grant_type=client_credentials');

    // A debug line WAS emitted (proves the assertion below is non-vacuous).
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('minted reddit app-only token');
    // Neither the raw client secret nor the minted bearer token appears in it.
    expect(logged).not.toContain('super-secret-value');
    expect(logged).not.toContain('tok-leak-check');

    logSpy.mockRestore();
    if (prevLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prevLevel;
    if (prevTui === undefined) delete process.env.WIGOLO_TUI_MODE;
    else process.env.WIGOLO_TUI_MODE = prevTui;
    resetConfig();
  });

  it('throws when the token response is not ok', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(jsonResponse({}, { status: 401 }));
    const mgr = new RedditTokenManager(CREDS, fetchFn as unknown as FetchFn, () => 0);
    await expect(mgr.getToken()).rejects.toThrow(/HTTP 401/);
  });

  it('does not follow a 3xx redirect from the token endpoint (SSRF)', async () => {
    // A hostile 3xx pointing at an internal address must NOT be auto-followed
    // with the Basic credentials attached — the mint fails instead, and the
    // fetch is issued with redirect: 'manual' so undici never follows it.
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({}, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );
    const mgr = new RedditTokenManager(CREDS, fetchFn as unknown as FetchFn, () => 0);

    await expect(mgr.getToken()).rejects.toThrow(/redirect/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const opts = fetchFn.mock.calls[0][1] as RequestInit;
    expect(opts.redirect).toBe('manual');
    // The private host was never fetched directly.
    const fetchedUrls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(fetchedUrls).not.toContain('http://169.254.169.254/');
  });

  it('mints only once under concurrent getToken() calls (inflight dedup)', async () => {
    // Two overlapping callers must share the single in-flight mint, so the
    // underlying token fetch fires exactly once. Each fetch call resolves on a
    // microtask tick so the second overlapping call would issue its own fetch
    // if the `inflight` guard were removed — the call-count assertion then
    // fails (verified by mutation).
    let mintCount = 0;
    const fetchFn = vi.fn<FetchFn>().mockImplementation(async () => {
      const n = ++mintCount;
      await Promise.resolve();
      return jsonResponse({ access_token: `tok-${n}`, expires_in: 3600 });
    });
    const mgr = new RedditTokenManager(CREDS, fetchFn as unknown as FetchFn, () => 0);

    const [a, b] = await Promise.all([mgr.getToken(), mgr.getToken()]);
    // Both callers observe the SAME single-minted token.
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

  it('does not follow a 3xx redirect from the data endpoint (SSRF)', async () => {
    // The data fetch returns a 302 aimed at an internal address. With
    // redirect: 'manual' undici never follows it; the reddit path surfaces an
    // error (which makes the router fall through the ladder) rather than
    // silently fetching the private host with the bearer token attached.
    const fetchFn = tokenThen(
      jsonResponse({}, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );
    const mgr = new RedditTokenManager(CREDS, fetchFn, () => 0);

    const err = await fetchViaRedditApi('https://www.reddit.com/r/rust', mgr, CREDS, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/redirect/i);

    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // The data call was issued with manual redirect handling...
    const dataOpts = calls[1][1] as RequestInit;
    expect(dataOpts.redirect).toBe('manual');
    // ...and the private host was never fetched directly.
    const fetchedUrls = calls.map((c) => String(c[0]));
    expect(fetchedUrls).not.toContain('http://169.254.169.254/');
  });

  it('constructs an oauth.reddit.com endpoint host regardless of input path trickery (SSRF)', async () => {
    const dataPayload = { kind: 'Listing', data: { children: [] } };
    const fetchFn = tokenThen(jsonResponse(dataPayload));
    const mgr = new RedditTokenManager(CREDS, fetchFn, () => 0);

    // A hostile path with an embedded @ / host-like segment must not redirect
    // egress off oauth.reddit.com. It no longer even reaches the API: the name
    // is not a legal reddit segment, so the mapper refuses and NOTHING is
    // fetched — not the data endpoint, not even a token.
    const hostile = await fetchViaRedditApi(
      'https://www.reddit.com/r/rust@evil.example/hot',
      mgr,
      CREDS,
      fetchFn,
    );
    expect(hostile).toBeNull();
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // And the host of a LEGAL request still comes from the fixed base only.
    await fetchViaRedditApi('https://www.reddit.com/r/rust/hot', mgr, CREDS, fetchFn);
    const dataCall = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    const calledUrl = new URL(dataCall[0] as string);
    expect(calledUrl.hostname).toBe('oauth.reddit.com');
  });
});

describe('reddit fetches are bounded', () => {
  // Neither call passed a signal, and the default fetch has no request timeout.
  // A stalled token mint or data request therefore held the router's fetch path
  // open indefinitely instead of falling through to the normal ladder.
  it('passes an abort signal to the token request', async () => {
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ access_token: 't', expires_in: 3600 });
    }) as unknown as FetchFn;
    const mgr = new RedditTokenManager(CREDS, fetchFn, () => 0);
    await mgr.getToken();
    expect(fetchFn).toHaveBeenCalled();
  });

  it('passes an abort signal to the data request', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchFn = vi.fn(async (u: string, init?: RequestInit) => {
      calls.push(init);
      return u.includes('access_token')
        ? jsonResponse({ access_token: 't', expires_in: 3600 })
        : jsonResponse({ kind: 'Listing', data: { children: [] } });
    }) as unknown as FetchFn;
    const mgr = new RedditTokenManager(CREDS, fetchFn, () => 0);
    await fetchViaRedditApi('https://www.reddit.com/r/rust/hot', mgr, CREDS, fetchFn);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the data request when the caller cancels', async () => {
    const ac = new AbortController();
    const fetchFn = vi.fn(async (u: string, init?: RequestInit) => {
      if (u.includes('access_token')) return jsonResponse({ access_token: 't', expires_in: 3600 });
      ac.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as FetchFn;
    const mgr = new RedditTokenManager(CREDS, fetchFn, () => 0);
    await expect(
      fetchViaRedditApi('https://www.reddit.com/r/rust/hot', mgr, CREDS, fetchFn, ac.signal),
    ).rejects.toThrow();
  });
});
