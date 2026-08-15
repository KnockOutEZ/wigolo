// Content-type passthrough classifier.
//
// WHY this exists: the extraction pipeline is an HTML-to-markdown converter.
// Feeding it a body that is already markdown (or is JSON) is a category error —
// the converter escapes every markdown-significant character and collapses
// block whitespace, so `# Title` comes back as `\# Title` and a JSON document
// comes back as unparseable prose. The classifier decides, from the *response*
// content-type plus a corroborating look at the body, whether the body should
// bypass conversion entirely.
//
// The negative cases matter more than the positive ones: a classifier that
// accidentally captured `text/html` would silently disable extraction for the
// whole web.

import { describe, it, expect } from 'vitest';
import { parseMimeType, classifyPassthrough } from '../../../src/extraction/passthrough.js';

const JSON_BODY = '{\n  "a": 1,\n  "b": ["x", "y"]\n}';
const MD_BODY = '# Title\n\nSome _text_ with a [link](https://example.com).\n';

describe('parseMimeType', () => {
  it('strips the charset parameter so routing sees the bare type', () => {
    // Real servers send `text/plain; charset=utf-8`. Routing on the raw header
    // string misses every one of them.
    expect(parseMimeType('text/plain; charset=utf-8')).toBe('text/plain');
  });

  it('lowercases and trims so header casing cannot change routing', () => {
    expect(parseMimeType('  Application/JSON ; Charset=UTF-8')).toBe('application/json');
  });

  it('returns an empty string for an absent content-type', () => {
    expect(parseMimeType(undefined)).toBe('');
  });
});

describe('classifyPassthrough — JSON', () => {
  it('classifies application/json whose body really parses as JSON', () => {
    expect(classifyPassthrough('application/json; charset=utf-8', JSON_BODY)).toBe('json');
  });

  it('classifies a +json structured suffix (application/vnd.github+json)', () => {
    // RFC 6839 suffix. GitHub, JSON:API and ActivityPub all use it, and their
    // bodies are as much JSON as `application/json` bodies are.
    expect(classifyPassthrough('application/vnd.github+json', JSON_BODY)).toBe('json');
  });

  it('refuses a declared-JSON body that is actually an HTML challenge page', () => {
    // Adversarial: a server (or an interstitial) declares JSON and returns
    // HTML. Passing that through verbatim would emit raw HTML as "markdown"
    // AND skip the anti-bot detection that lives in the routed extractor.
    const html = '<!DOCTYPE html><html><head><title>Just a moment</title></head><body>checking</body></html>';
    expect(classifyPassthrough('application/json', html)).toBeNull();
  });

  it('refuses a declared-JSON body that does not parse', () => {
    // Truncated, JSONP-wrapped or NDJSON bodies are not JSON documents. Falling
    // through to the extractor keeps today's behaviour for them rather than
    // guessing.
    expect(classifyPassthrough('application/json', '{"a": 1')).toBeNull();
  });
});

describe('classifyPassthrough — text', () => {
  it('classifies text/markdown', () => {
    expect(classifyPassthrough('text/markdown; charset=utf-8', MD_BODY)).toBe('text');
  });

  it('classifies text/x-markdown', () => {
    expect(classifyPassthrough('text/x-markdown', MD_BODY)).toBe('text');
  });

  it('classifies text/plain — the type raw.githubusercontent.com actually sends for .md', () => {
    // Verified against the live host: raw.githubusercontent.com serves every
    // file, including .md, as `text/plain; charset=utf-8`. Handling only
    // text/markdown would leave the reported defect completely unfixed.
    expect(classifyPassthrough('text/plain; charset=utf-8', MD_BODY)).toBe('text');
  });

  it('classifies a line-oriented text body such as robots.txt', () => {
    // Whitespace collapse destroys line-oriented formats outright: every
    // directive ends up on one line.
    expect(classifyPassthrough('text/plain', 'User-agent: *\nDisallow: /private/\n')).toBe('text');
  });

  it('refuses an HTML document mislabelled as text/plain', () => {
    const html = '<!doctype html>\n<html><body><h1>Hi</h1></body></html>';
    expect(classifyPassthrough('text/plain', html)).toBeNull();
  });

  it('refuses an HTML document mislabelled as text/markdown', () => {
    const html = '<html><head></head><body><article>real content</article></body></html>';
    expect(classifyPassthrough('text/markdown', html)).toBeNull();
  });

  it('still classifies markdown that merely embeds inline HTML tags', () => {
    // README files routinely open with a centred badge block. The HTML guard
    // must key on the body being an HTML *document*, not on containing a tag —
    // otherwise it rejects a large fraction of real markdown.
    const readme = '<div align="center">\n  <img src="logo.png">\n</div>\n\n# Project\n\nText.\n';
    expect(classifyPassthrough('text/plain', readme)).toBe('text');
  });
});

describe('classifyPassthrough — must not fire', () => {
  it('never classifies text/html (the whole web would stop being extracted)', () => {
    expect(classifyPassthrough('text/html; charset=utf-8', '<html><body><p>hi</p></body></html>')).toBeNull();
  });

  it('never classifies text/html even when the body is not a full document', () => {
    // Defence in depth: the decision must come from the declared type, not
    // from the body shape alone.
    expect(classifyPassthrough('text/html', '# not really markdown')).toBeNull();
  });

  it('never classifies application/pdf', () => {
    expect(classifyPassthrough('application/pdf', '')).toBeNull();
  });

  it('never classifies an absent content-type', () => {
    // An unlabelled body is exactly the ambiguous case; today it is extracted,
    // and this change must not alter that.
    expect(classifyPassthrough(undefined, MD_BODY)).toBeNull();
  });

  it('never classifies XML (sitemaps and feeds stay on the extractor)', () => {
    // Out of scope by design: XML is a markup document and converting it to
    // readable text is a defensible thing to do. Left unchanged.
    expect(classifyPassthrough('application/xml', '<urlset><url><loc>/a</loc></url></urlset>')).toBeNull();
  });
});
