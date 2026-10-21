import { describe, it, expect } from 'vitest';
import { mapRedditUrlToEndpoint } from '../../../src/fetch/reddit-api.js';

/**
 * The endpoint mapper strips characters that are invalid in a Reddit name so the
 * fixed-host URL can never be escaped. Stripping is the right defence, but
 * SILENTLY stripping changes which resource is fetched: `/r/foo.bar` became
 * `/r/foobar`, and the caller got a different subreddit's content back with no
 * signal that a substitution happened.
 *
 * A segment that had to be rewritten is not a segment we can serve — return null
 * so the router falls through to the normal ladder against the URL as given.
 */
describe('reddit endpoint mapping never silently substitutes a different resource', () => {
  it('refuses a subreddit whose name had to be rewritten', () => {
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/foo.bar/')).toBeNull();
  });

  it('refuses a percent-encoded traversal attempt rather than mangling it into a real sub', () => {
    // Previously mapped to /r/AskReddit2F2Fpolitics — a real, WRONG subreddit.
    expect(
      mapRedditUrlToEndpoint('https://www.reddit.com/r/AskReddit%2F..%2Fpolitics/'),
    ).toBeNull();
  });

  it('refuses a rewritten username', () => {
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/user/bad$name')).toBeNull();
  });

  it('refuses a rewritten thread id', () => {
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/rust/comments/ab!c12/title/')).toBeNull();
  });

  it('still maps clean URLs exactly as before', () => {
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/rust/comments/abc123/title/')).toBe(
      '/r/rust/comments/abc123',
    );
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/rust/')).toBe('/r/rust/hot');
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/rust/top')).toBe('/r/rust/top');
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/user/spez')).toBe('/user/spez/about');
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/u/spez')).toBe('/user/spez/about');
  });

  it('accepts the underscore and hyphen that are legal in reddit names', () => {
    expect(mapRedditUrlToEndpoint('https://www.reddit.com/r/my_sub-name/')).toBe(
      '/r/my_sub-name/hot',
    );
  });
});
