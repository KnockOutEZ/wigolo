import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { detectListTables, detectListTablesFromDoc } from '../../../src/extraction/list.js';

const doc = (html: string) => parseHTML(html).document;

describe('detectListTables — generic repeated-sibling list', () => {
  it('emits one row per <li> when siblings share a consistent inner shape', () => {
    // A ranked listing (structure like a story/leaderboard list): each <li>
    // carries a link title and a numeric metric. Keys on STRUCTURE, not any
    // site-specific class token.
    const html = `<html><body><main><ol class="feed">
      <li><a href="/posts/ring-buffer">Designing a lock-free ring buffer</a>
          <span class="score">184 points</span><span class="comments">57 comments</span></li>
      <li><a href="/posts/columnar">Column-oriented storage internals</a>
          <span class="score">92 points</span><span class="comments">31 comments</span></li>
      <li><a href="/posts/wasm">Compiling to WebAssembly by hand</a>
          <span class="score">211 points</span><span class="comments">88 comments</span></li>
      <li><a href="/posts/gc">A tour of tracing garbage collectors</a>
          <span class="score">45 points</span><span class="comments">12 comments</span></li>
    </ol></main></body></html>`;

    const tables = detectListTables(html);
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.rows).toHaveLength(4);
  });

  it('captures the anchor href of each list item', () => {
    const html = `<html><body><ul class="results">
      <li><a href="https://example.com/a">Alpha article</a> <span>10 votes</span></li>
      <li><a href="https://example.com/b">Beta article</a> <span>20 votes</span></li>
      <li><a href="https://example.com/c">Gamma article</a> <span>30 votes</span></li>
    </ul></body></html>`;

    const tables = detectListTables(html);
    expect(tables).toHaveLength(1);
    const hrefs = tables[0].rows.map((r) => r.href);
    expect(hrefs).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
    const titles = tables[0].rows.map((r) => r.title);
    expect(titles).toEqual(['Alpha article', 'Beta article', 'Gamma article']);
  });

  it('parses typed numeric fields (counts/points) present in items', () => {
    const html = `<html><body><ol>
      <li><a href="/1">First</a> <span>184 points</span> <span>57 comments</span></li>
      <li><a href="/2">Second</a> <span>92 points</span> <span>31 comments</span></li>
      <li><a href="/3">Third</a> <span>211 points</span> <span>88 comments</span></li>
    </ol></body></html>`;

    const tables = detectListTables(html);
    expect(tables).toHaveLength(1);
    const r0 = tables[0].rows[0];
    // A numeric column is surfaced so an agent/schema reads the metric.
    const numericValues = Object.values(r0).filter((v) => /^\d+$/.test(v));
    expect(numericValues).toContain('184');
    expect(numericValues).toContain('57');
  });

  it('does NOT fire on a short list below the sibling gate', () => {
    const html = `<html><body><ul>
      <li><a href="/only">Only item</a></li>
    </ul></body></html>`;
    expect(detectListTables(html)).toHaveLength(0);
  });

  it('does NOT fire on a bare prose/nav list with no per-item structure', () => {
    // A plain bullet list of one-word nav labels carries no repeated inner
    // shape (no anchors + metric pattern) and must stay prose, never a table.
    const html = `<html><body><nav><ul>
      <li>Home</li><li>About</li><li>Docs</li><li>Contact</li>
    </ul></nav></body></html>`;
    expect(detectListTables(html)).toHaveLength(0);
  });

  it('does NOT fire on a LINKED nav menu inside a <nav> landmark (chrome guard)', () => {
    // A sidebar/nav menu is a list of linked items and would otherwise pass the
    // anchor signal, but it is page chrome, not a data listing. The nav/footer/
    // header landmark guard rejects it — the same guard the card detector uses.
    const html = `<html><body><nav aria-label="docs"><ul>
      <li><a href="/a">Getting started</a></li>
      <li><a href="/b">Configuration</a></li>
      <li><a href="/c">API reference</a></li>
      <li><a href="/d">Guides</a></li>
    </ul></nav></body></html>`;
    expect(detectListTables(html)).toHaveLength(0);
  });

  it('detectListTablesFromDoc shares the doc-based entry point', () => {
    const html = `<html><body><ol>
      <li><a href="/1">One</a> <span>5 votes</span></li>
      <li><a href="/2">Two</a> <span>6 votes</span></li>
      <li><a href="/3">Three</a> <span>7 votes</span></li>
    </ol></body></html>`;
    const fromDoc = detectListTablesFromDoc(doc(html));
    expect(fromDoc).toHaveLength(1);
    expect(fromDoc[0].rows).toHaveLength(3);
  });
});

// In-<main> chrome that a nav/footer/header landmark guard does NOT catch. These
// are ordinary page furniture rendered inside the content area, so the detector
// must reject them on record-quality signals (fragment anchors, non-distinct or
// non-substantive titles, pagination numbers), not on landmark alone. A live
// probe found the detector emitting spurious rows for all six.
describe('list detector MUST-NOT-FIRE on in-<main> chrome', () => {
  it('table-of-contents (fragment-anchor links)', () => {
    const html = `<html><body><main><div class="toc"><ol>
      <li><a href="#intro">Introduction</a></li>
      <li><a href="#setup">Setup</a></li>
      <li><a href="#usage">Usage</a></li>
      <li><a href="#faq">FAQ</a></li></ol></div></main></body></html>`;
    expect(detectListTables(html)).toHaveLength(0);
  });

  it('related-articles list with non-distinct repeated titles', () => {
    const html = `<html><body><main><div class="related"><ul>
      <li><a href="/a">Read more</a></li>
      <li><a href="/b">Read more</a></li>
      <li><a href="/c">Read more</a></li></ul></div></main></body></html>`;
    expect(detectListTables(html)).toHaveLength(0);
  });

  it('breadcrumb trail (short single-word crumbs)', () => {
    const html = `<html><body><main><ol class="breadcrumb">
      <li><a href="/">Home</a></li>
      <li><a href="/docs">Docs</a></li>
      <li><a href="/docs/api">API</a></li></ol></main></body></html>`;
    expect(detectListTables(html)).toHaveLength(0);
  });

  it('pagination (bare number / Next-Prev titles)', () => {
    const html = `<html><body><main><ul class="pagination">
      <li><a href="?page=1">1</a></li>
      <li><a href="?page=2">2</a></li>
      <li><a href="?page=3">3</a></li>
      <li><a href="?page=next">Next</a></li></ul></main></body></html>`;
    expect(detectListTables(html)).toHaveLength(0);
  });

  it('tag cloud (single-word tag labels)', () => {
    const html = `<html><body><main><ul class="tags">
      <li><a href="/tag/js">js</a></li>
      <li><a href="/tag/go">go</a></li>
      <li><a href="/tag/rust">rust</a></li>
      <li><a href="/tag/py">py</a></li></ul></main></body></html>`;
    expect(detectListTables(html)).toHaveLength(0);
  });

  it('comment thread (title would bind to author name)', () => {
    const html = `<html><body><main><ul class="comments">
      <li><a href="/u/jane" class="author">jane</a> <span class="ts">2 hours ago</span><p>Great post!</p></li>
      <li><a href="/u/bob" class="author">bob</a> <span class="ts">3 hours ago</span><p>Agreed.</p></li>
      <li><a href="/u/amy" class="author">amy</a> <span class="ts">5 hours ago</span><p>Thanks.</p></li></ul></main></body></html>`;
    expect(detectListTables(html)).toHaveLength(0);
  });
});

describe('list detector recall: legit listings in non-nav containers', () => {
  it('FIRES on a leaderboard inside <aside> (aside is not always chrome)', () => {
    // The blanket <aside> exclusion dropped a real listing. An <aside> can hold
    // a genuine leaderboard/feed widget; it must fire when the records are
    // real (distinct multi-word titles + numeric metrics).
    const html = `<html><body><aside><ol class="leaderboard">
      <li><a href="/team/alpha">Alpha Squad</a> <span>340 points</span></li>
      <li><a href="/team/bravo">Bravo Unit</a> <span>295 points</span></li>
      <li><a href="/team/charlie">Charlie Group</a> <span>250 points</span></li></ol></aside></body></html>`;
    const tables = detectListTables(html);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(3);
    expect(tables[0].rows[0].href).toBe('/team/alpha');
    const nums = Object.values(tables[0].rows[0]).filter((v) => /^\d+$/.test(v));
    expect(nums).toContain('340');
  });

  it('still FIRES on a real content feed in <main> (distinct titles + metrics)', () => {
    const html = `<html><body><main><ul class="feed">
      <li><a href="/2026/07/story-one">A deep dive into columnar storage engines</a> <span>184 points</span></li>
      <li><a href="/2026/07/story-two">Understanding lock-free ring buffers</a> <span>92 points</span></li>
      <li><a href="/2026/07/story-three">Compiling to WebAssembly by hand</a> <span>211 points</span></li></ul></main></body></html>`;
    const tables = detectListTables(html);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(3);
  });
});
