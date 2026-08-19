import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import {
  cacheContent,
  normalizeUrl,
  getCachedContentByHash,
} from '../../../src/cache/store.js';
import { toVersionTimestamp } from '../../../src/cache/version-read.js';
import { handleCache } from '../../../src/tools/cache.js';
import { handleDiff } from '../../../src/tools/diff.js';
import { resetConfig } from '../../../src/config.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

/**
 * S14-2 — the read surface over the time axis.
 *
 * S14-1 put older bodies on disk; nothing could read them. These encode WHY the
 * read has to be exact rather than approximate: a point-in-time read that
 * silently answers with the CURRENT page, or with the nearest LATER version,
 * makes every provenance claim built on this feature false while looking like it
 * works. So the miss is an explicit result, never a fall-through (G-S14-2a).
 *
 * `diff`'s `old.content_hash` could not reach a past version at all before this
 * slice — `url_cache` is one row per URL, so a hash resolved only while it was
 * still the live hash (G-S14-2b).
 */

const URL = 'https://example.com/timeline';
const NORMALIZED = normalizeUrl(URL);

const ENV_KEYS = [
  'WIGOLO_CORPUS_MAX_VERSIONS_PER_URL',
  'WIGOLO_CORPUS_MAX_VERSION_BYTES',
  'WIGOLO_CORPUS_VERSION_MAX_AGE_DAYS',
];

const BODY_1 = '# One\n\nThe body as it stood at t1. é—trailing space \n';
const BODY_2 = '# Two\n\nA different body at t2.\n';
const BODY_3 = '# Three\n\nThe body it serves now, at t3.\n';

function hashOf(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function makeRaw(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body>hello</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
}

function makeExtraction(markdown: string): ExtractionResult {
  return {
    title: 'Timeline Page',
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
}

function write(markdown: string, url = URL): void {
  cacheContent(makeRaw(url), makeExtraction(markdown));
}

/** Zone-less UTC "YYYY-MM-DD HH:MM:SS", the shape `fetched_at` is stored in. */
function stamp(offsetMs: number): string {
  return new Date(Date.now() + offsetMs)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '');
}

function retime(markdown: string, at: string): void {
  getDatabase()
    .prepare('UPDATE url_versions SET fetched_at = ? WHERE content_hash = ?')
    .run(at, hashOf(markdown));
}

const HOUR = 60 * 60 * 1000;

interface Timeline {
  t1: string;
  t2: string;
  t3: string;
}

/**
 * Three versions of one URL at known, distinct, strictly increasing times.
 *
 * Written through the real `cacheContent` writer, then re-timed: `fetched_at`
 * has one-second resolution, so three writes in the same tick would collapse the
 * ordering this whole surface is about. Offsets are relative to now so the age
 * bound never binds on a run far in the future.
 */
function buildTimeline(): Timeline {
  const t1 = stamp(-3 * HOUR);
  const t2 = stamp(-2 * HOUR);
  const t3 = stamp(-1 * HOUR);
  write(BODY_1);
  write(BODY_2);
  write(BODY_3);
  retime(BODY_1, t1);
  retime(BODY_2, t2);
  retime(BODY_3, t3);
  return { t1, t2, t3 };
}

/** `base` shifted by whole seconds, in the stored zone-less UTC shape. */
function plusSeconds(base: string, seconds: number): string {
  const ms = new Date(`${base.replace(' ', 'T')}Z`).getTime() + seconds * 1000;
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

describe('toVersionTimestamp — the caller\'s `at` in the shape fetched_at is stored in', () => {
  it('passes a zone-less UTC timestamp through untouched', () => {
    // NOT round-tripped through Date: JavaScript parses "YYYY-MM-DD HH:MM:SS" as
    // LOCAL time, which would shift every comparison by the host's UTC offset and
    // silently return the wrong version on any machine that is not on UTC.
    expect(toVersionTimestamp('2026-08-18 12:00:01')).toBe('2026-08-18 12:00:01');
  });

  it('passes it through on a host that is NOT on UTC', () => {
    // The clause above cannot fail on a UTC runner: a Date round trip of a
    // zone-less value there produces the identical string, so the check agrees
    // with the mutation it exists to catch. Measured — removing the passthrough
    // reds 7 tests under TZ=Asia/Dhaka and 0 under TZ=UTC, and CI runs UTC.
    // Forcing the offset is what makes the protection visible anywhere.
    const previous = process.env.TZ;
    process.env.TZ = 'Asia/Dhaka';
    try {
      // The forcing must be shown to have worked, or this passes vacuously on a
      // runtime that ignores a mid-process TZ change.
      expect(new Date().getTimezoneOffset()).not.toBe(0);
      expect(toVersionTimestamp('2026-08-18 12:00:01')).toBe('2026-08-18 12:00:01');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('converts a Z-suffixed ISO timestamp to the stored shape', () => {
    expect(toVersionTimestamp('2026-08-18T12:00:01Z')).toBe('2026-08-18 12:00:01');
  });

  it('resolves an explicit UTC offset rather than dropping it', () => {
    expect(toVersionTimestamp('2026-08-18T18:00:01+06:00')).toBe('2026-08-18 12:00:01');
  });

  it('treats a date-only value as UTC midnight', () => {
    expect(toVersionTimestamp('2026-08-18')).toBe('2026-08-18 00:00:00');
  });

  it('truncates sub-second precision DOWN, so "at or before" stays true', () => {
    expect(toVersionTimestamp('2026-08-18T12:00:01.900Z')).toBe('2026-08-18 12:00:01');
  });

  it('returns null for a value it cannot parse', () => {
    // The alternative — falling back to "now" or to no bound — turns a typo into a
    // confident answer about the wrong moment.
    expect(toVersionTimestamp('last tuesday')).toBeNull();
    expect(toVersionTimestamp('')).toBeNull();
  });
});

describe('cache(url, at:) — point-in-time reconstruction (G-S14-2a)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });

  afterEach(() => {
    closeDatabase();
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfig();
  });

  it('returns the t2 body byte-for-byte one second after t2', async () => {
    const { t2 } = buildTimeline();

    const out = await handleCache({ url: URL, at: plusSeconds(t2, 1) });

    expect(out.version).toBeDefined();
    expect(out.version!.markdown).toBe(BODY_2);
    expect(out.version!.observed_at).toBe(t2);
    expect(out.version!.content_hash).toBe(hashOf(BODY_2));
  });

  it('never answers with the NEAREST LATER version', async () => {
    // The failure this gate exists for. A read implemented as "closest version"
    // rather than "at or before" reads plausibly and is wrong in the one
    // direction that matters: it reports a body the page had not served yet.
    const { t1, t2 } = buildTimeline();
    const justBeforeT2 = plusSeconds(t2, -1);

    const out = await handleCache({ url: URL, at: justBeforeT2 });

    expect(out.version!.markdown).toBe(BODY_1);
    expect(out.version!.observed_at).toBe(t1);
    expect(out.version!.markdown).not.toBe(BODY_2);
  });

  it('includes the boundary — `at` exactly equal to an observation returns that version', async () => {
    const { t2 } = buildTimeline();
    const out = await handleCache({ url: URL, at: t2 });
    expect(out.version!.markdown).toBe(BODY_2);
  });

  it('returns the newest retained version for a time after the last observation', async () => {
    const { t3 } = buildTimeline();
    const out = await handleCache({ url: URL, at: plusSeconds(t3, 3600) });
    expect(out.version!.markdown).toBe(BODY_3);
    expect(out.version!.observed_at).toBe(t3);
  });

  it('returns an explicit not-retained result before t1, and NO body of any version', async () => {
    // Both halves are the gate. "Not the current one" is satisfied by returning
    // BODY_1 or BODY_2, so a ceiling-style assertion on the current body alone
    // would be satisfied by its own violation. The response must carry no page
    // body at all.
    const { t1 } = buildTimeline();

    const out = await handleCache({ url: URL, at: plusSeconds(t1, -1) });

    expect(out.version).toBeUndefined();
    expect(out.version_not_retained).toBeDefined();
    expect(out.version_not_retained!.url).toBe(URL);

    const serialized = JSON.stringify(out);
    for (const body of [BODY_1, BODY_2, BODY_3]) {
      expect(serialized).not.toContain(JSON.stringify(body).slice(1, -1));
    }
  });

  it('returns not-retained for a URL whose live page is cached but whose history is not', async () => {
    // The sharpest fall-through shape: `url_cache` HAS a row, so any
    // implementation that reaches for the current page on a history miss looks
    // like it worked. The time axis is disabled for this write, so no version
    // exists at any time.
    process.env.WIGOLO_CORPUS_MAX_VERSIONS_PER_URL = '0';
    resetConfig();
    write(BODY_3);

    const live = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM url_cache WHERE normalized_url = ?')
      .get(NORMALIZED) as { n: number };
    expect(live.n).toBe(1);

    const out = await handleCache({ url: URL, at: stamp(0) });

    expect(out.version).toBeUndefined();
    expect(out.version_not_retained).toBeDefined();
    expect(JSON.stringify(out)).not.toContain('The body it serves now');
  });

  it('returns not-retained for a URL that was never fetched at all', async () => {
    const out = await handleCache({ url: 'https://example.com/never-seen', at: stamp(0) });
    expect(out.version_not_retained).toBeDefined();
    expect(out.version).toBeUndefined();
  });

  it('keeps per-URL timelines separate — another URL\'s version never answers', async () => {
    buildTimeline();
    write('# Neighbour body', 'https://example.com/other');

    const out = await handleCache({ url: 'https://example.com/other', at: stamp(0) });

    expect(out.version!.markdown).toBe('# Neighbour body');
  });

  it('rejects an unparseable `at` instead of quietly reading some other moment', async () => {
    buildTimeline();
    const out = await handleCache({ url: URL, at: 'last tuesday' });
    expect(out.error).toMatch(/at/i);
    expect(out.version).toBeUndefined();
    expect(out.version_not_retained).toBeUndefined();
  });

  it('requires a url alongside `at`', async () => {
    const out = await handleCache({ at: stamp(0) });
    expect(out.error).toMatch(/url/i);
    expect(out.version).toBeUndefined();
  });

  it('accepts a non-normalized form of the same URL', async () => {
    buildTimeline();
    const out = await handleCache({ url: `${URL}/`, at: stamp(0) });
    expect(out.version!.markdown).toBe(BODY_3);
  });
});

describe('cache(url, versions: true) — the version list', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });

  afterEach(() => {
    closeDatabase();
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfig();
  });

  it('lists retained versions newest first, each with the time it was observed', async () => {
    const { t1, t2, t3 } = buildTimeline();

    const out = await handleCache({ url: URL, versions: true });

    expect(out.version_list).toBeDefined();
    expect(out.version_list!.versions.map(v => v.observed_at)).toEqual([t3, t2, t1]);
  });

  it('carries no page bodies — the list is an index, not a bulk history read', async () => {
    buildTimeline();
    const out = await handleCache({ url: URL, versions: true });
    const serialized = JSON.stringify(out);
    for (const body of [BODY_1, BODY_2, BODY_3]) {
      expect(serialized).not.toContain(JSON.stringify(body).slice(1, -1));
    }
  });

  it('lists exactly the fingerprints `diff` can then resolve', async () => {
    // The list is only useful if its handles work. Every hash it hands out must
    // be one the diff surface accepts, or the two halves of this slice do not
    // actually connect.
    buildTimeline();
    const out = await handleCache({ url: URL, versions: true });

    for (const entry of out.version_list!.versions) {
      const diff = await handleDiff({
        old: { content_hash: entry.content_hash },
        new: { url: URL },
        output: 'summary',
      });
      expect(diff.ok, `hash ${entry.content_hash} listed but not resolvable`).toBe(true);
    }
  });

  it('states that the list is what is retained now, not the page\'s full history', async () => {
    // Constraint from D-S14-2/K31: the byte sweep is cross-URL and oldest-first,
    // so a quiet URL's only version can be evicted by a churning one. A list that
    // read as "here is everything this page ever served" would be false as
    // shipped.
    buildTimeline();
    const note = (await handleCache({ url: URL, versions: true })).version_list!.note;
    expect(note).toMatch(/evict/i);
    expect(note).toMatch(/gap/i);
  });

  it('warns that the list is not a count of changes', async () => {
    // A body that returns to an earlier form is re-timed onto the existing row
    // rather than added, so A->B->A is two entries. "The body at t2" is
    // answerable; "how many times did it flip" is not, and the surface must not
    // imply otherwise.
    write('# A');
    write('# B');
    write('# A');

    const out = await handleCache({ url: URL, versions: true });

    expect(out.version_list!.versions).toHaveLength(2);
    expect(out.version_list!.note).toMatch(/re-timed|not a change count/i);
  });

  it('returns an empty list rather than an error for a URL with no retained history', async () => {
    const out = await handleCache({ url: 'https://example.com/never-seen', versions: true });
    expect(out.version_list).toBeDefined();
    expect(out.version_list!.versions).toEqual([]);
    expect(out.error).toBeUndefined();
  });

  it('caps the number of entries returned', async () => {
    process.env.WIGOLO_CORPUS_MAX_VERSIONS_PER_URL = '50';
    resetConfig();
    for (let i = 0; i < 40; i++) write(`# Version ${i}`);

    const out = await handleCache({ url: URL, versions: true, limit: 5 });

    expect(out.version_list!.versions).toHaveLength(5);
  });

  it('requires a url', async () => {
    const out = await handleCache({ versions: true });
    expect(out.error).toMatch(/url/i);
    expect(out.version_list).toBeUndefined();
  });
});

describe('diff reaches a past version (G-S14-2b)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });

  afterEach(() => {
    closeDatabase();
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfig();
  });

  it('resolves old.content_hash for a body that is no longer the live one', async () => {
    // Before S14-2 this was unreachable by any path: `url_cache` is one row per
    // URL under INSERT OR REPLACE, so a hash resolved only while it was still the
    // CURRENT hash. The first assertion pins that premise — if the old hash were
    // still live, this test would prove nothing.
    write(BODY_1);
    write(BODY_3);
    const oldHash = hashOf(BODY_1);
    expect(getCachedContentByHash(oldHash)).toBeNull();

    const result = await handleDiff({
      old: { content_hash: oldHash },
      new: { url: URL },
      output: 'unified',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.changed).toBe(true);
    expect(result.data.unified_diff).toContain('The body as it stood at t1');
    expect(result.data.unified_diff).toContain('The body it serves now');
  });

  it('diffs one past version against another, both off the live row', async () => {
    write(BODY_1);
    write(BODY_2);
    write(BODY_3);

    const result = await handleDiff({
      old: { content_hash: hashOf(BODY_1) },
      new: { markdown: BODY_2 },
      output: 'summary',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.changed).toBe(true);
  });

  it('reports an explicit miss for a hash no longer retained, never the current body', async () => {
    // The §1.1.1 failure mode reintroducing itself. A hash whose version has been
    // evicted must miss loudly; falling through to the live row would answer a
    // question about the past with the present.
    write(BODY_1);
    write(BODY_3);
    getDatabase().prepare('DELETE FROM url_versions WHERE content_hash = ?').run(hashOf(BODY_1));

    const result = await handleDiff({
      old: { content_hash: hashOf(BODY_1) },
      new: { url: URL },
      output: 'unified',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('cache_miss');
    expect(JSON.stringify(result)).not.toContain('The body it serves now');
  });

  it('still resolves a hash that IS the live row, without consulting history', async () => {
    write(BODY_3);
    const result = await handleDiff({
      old: { content_hash: hashOf(BODY_3) },
      new: { markdown: BODY_1 },
      output: 'summary',
    });
    expect(result.ok).toBe(true);
  });
});
