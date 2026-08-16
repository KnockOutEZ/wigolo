import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defuddleExtract } from '../../../src/extraction/defuddle.js';
import { routedExtract } from '../../../src/extraction/v1/routed.js';

// The bundled content extractor ships "async extractors" that call third-party
// HTTP endpoints from inside the parse, on the bare global fetch — below
// wigolo's fetch layer, so they bypass the configured proxy, the timeouts, the
// headers and every wigolo log line. One known destination is an unaffiliated
// third party that receives the user's complete requested URL.
//
// These tests hold the invariant that MATTERS: extracting content from HTML
// wigolo already has must not put a single byte on the wire. They are written
// against the CLASS (any outbound request, from any extractor, to any host),
// not against the handful of destinations that happened to exist when the
// defect was found — a future library release that adds a new async extractor
// for a new site must turn them red without anyone editing this file.
//
// Nothing here performs a real request: the global fetch is replaced by a
// recorder for the duration of each test.

interface Recorder {
  calls: string[];
  restore(): void;
}

function recordFetch(): Recorder {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : ((input as { url?: string } | null)?.url ?? String(input));
    calls.push(url);
    // Deliberately unusable: if an extractor ever gets this far the test has
    // already failed, and no network is touched either way.
    return new Response('', { status: 599, statusText: 'blocked-by-test' });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// A body with no readable prose. This is the state that used to trigger the
// third-party fall-through: the library only reached for the network when its
// local parse produced zero words.
const CONTENT_FREE_BODY = `<!doctype html><html><head><title>t</title></head>
<body><div id="react-root"></div><shreddit-post></shreddit-post></body></html>`;

// The three destinations measured on the real dependency. Kept as an
// illustrative table, not as the definition of the invariant.
const KNOWN_EGRESS_URLS = [
  'https://x.com/janedoe/status/1899999999999999999',
  'https://twitter.com/janedoe/status/1899999999999999999',
  'https://www.reddit.com/r/typescript/comments/abc123/some_title/?sort=top',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtu.be/dQw4w9WgXcQ',
];

let rec: Recorder;

beforeEach(() => {
  rec = recordFetch();
});

afterEach(() => {
  rec.restore();
});

describe('extraction makes no third-party requests', () => {
  it.each(KNOWN_EGRESS_URLS)(
    'never leaves the process while extracting %s',
    async (url) => {
      await defuddleExtract(CONTENT_FREE_BODY, url);
      expect(rec.calls).toEqual([]);
    },
  );

  it('never leaves the process for any site the bundled extractor knows about', async () => {
    // Derive the URL set from the dependency's OWN extractor registry rather
    // than from a list maintained here. When a future release registers an
    // extractor for a new site, that site is swept automatically — which is the
    // whole point: the guarantee is about the class of async extractors, not
    // about the three destinations that were found by hand.
    const registrySource = readFileSync(
      join(dirname(fileURLToPath(import.meta.resolve('defuddle/node'))), 'extractor-registry.js'),
      'utf-8',
    );

    const hosts = new Set<string>();
    for (const [, host] of registrySource.matchAll(/['"]([a-z0-9-]+(?:\.[a-z0-9-]+)+)['"]/gi)) {
      // The registry matches string patterns against the hostname, so every
      // such literal IS a hostname and a URL can be built from it directly.
      if (/\.[a-z]{2,}$/i.test(host) && !host.endsWith('.js') && !host.endsWith('.ts')) {
        hosts.add(host.toLowerCase());
      }
    }

    // Fail loudly rather than pass vacuously: if the registry's shape changes
    // and nothing is derived, this test would otherwise silently guard nothing.
    expect(
      hosts.size,
      'derived zero hosts from the extractor registry — the sweep is not actually running',
    ).toBeGreaterThanOrEqual(8);
    expect([...hosts]).toEqual(expect.arrayContaining(['x.com', 'reddit.com', 'youtube.com']));

    for (const host of hosts) {
      // Two shapes per host: the bare page, and the sub-path shape the known
      // async extractors key on (`/status/<id>`, `/comments/`, `?v=`).
      for (const path of ['/', '/probe/status/123', '/r/probe/comments/abc/title/']) {
        await defuddleExtract(CONTENT_FREE_BODY, `https://${host}${path}`);
      }
    }

    expect(rec.calls).toEqual([]);
  });

  it('does not fire on ordinary pages — control', async () => {
    const article = `<!doctype html><html><head><title>A Blog Post</title></head><body>
      <article><h1>A Blog Post</h1>${'<p>Real prose that a normal extractor handles without any network access at all.</p>'.repeat(
        10,
      )}</article></body></html>`;
    const result = await defuddleExtract(article, 'https://example.com/blog/post');
    expect(rec.calls).toEqual([]);
    // The must-not-fire half: switching the async class off must not change
    // what an ordinary page extracts. A guard that also broke normal pages
    // would pass the egress assertions above and still be wrong.
    expect(result).not.toBeNull();
    expect(result!.extractor).toBe('defuddle');
    expect(result!.markdown).toContain('Real prose that a normal extractor handles');
    expect(result!.markdown.length).toBeGreaterThan(500);
  });

  it('makes no request through the full routed pipeline either', async () => {
    for (const url of KNOWN_EGRESS_URLS) {
      await routedExtract({ html: CONTENT_FREE_BODY, url });
    }
    expect(rec.calls).toEqual([]);
  });
});
