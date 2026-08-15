import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractContent } from '../../../src/extraction/pipeline.js';

const fixture = readFileSync(
  join(import.meta.dirname, '../../fixtures/extraction/weblog-table-listing.html'),
  'utf8',
);
const URL = 'https://example.invalid/log/';

// Post URLs that exist ONLY inside a <td>. If the table path flattens a cell to
// its text, the body still reads fine and every one of these vanishes from
// `links` — which is exactly what a weblog index consumer needs most.
const POST_URLS = [
  'https://example.invalid/log/a_139_hdd/',
  'https://example.invalid/log/a_138_systemdocker/',
  'https://example.invalid/log/a_137_linkedin_fanfiction/',
  'https://example.invalid/log/a_135_learn/',
  'https://example.invalid/log/a_134_nsfw/',
  'https://example.invalid/log/a_133_boring/',
  'https://example.invalid/log/a_132_compression/',
  'https://example.invalid/log/a_131_trust/',
  'https://example.invalid/log/a_130_early/',
  'https://example.invalid/log/a_129_filtering/',
  'https://example.invalid/log/a_128_language/',
];

describe('table-cell links — weblog listing fixture', () => {
  it('collects every post link that lives inside a table cell', async () => {
    const r = await extractContent(fixture, URL);
    for (const url of POST_URLS) {
      expect(r.links, `missing table-cell link ${url}`).toContain(url);
    }
  });

  it('renders the cell anchors as markdown links in the body', async () => {
    const r = await extractContent(fixture, URL);
    expect(r.markdown).toContain(
      '[Your harddrive is probably full](https://example.invalid/log/a_139_hdd/)',
    );
    // Still one markdown table row per post, not a link per line.
    expect(r.markdown).toMatch(/^\|.*Unranked, systemd, crawls.*\|$/m);
  });

  it('keeps navigation, sidebar and footer links out of links', async () => {
    const r = await extractContent(fixture, URL);
    for (const url of [
      'https://example.invalid/sponsor/',
      'https://example.invalid/newsletter/',
      'https://example.invalid/supporting/',
    ]) {
      expect(r.links, `boilerplate link leaked: ${url}`).not.toContain(url);
    }
  });

  it('keeps table-cell links when a layout wrapper class contains "sidebar"', async () => {
    // The boilerplate selector `[class*="sidebar"]` matches framework layout
    // wrappers that ENCLOSE <main>; the main-landmark guard is what stops the
    // whole article being deleted. Widening the table path must not depend on
    // that guard being absent.
    const wrapped = `<!doctype html><html><head><title>Docs index</title></head><body>
      <div class="grid-cols-sidebar-content">
        <main>
          <h1>Docs index</h1>
          <table>
            <thead><tr><th>Page</th><th>Summary</th></tr></thead>
            <tr><td><a href="https://example.invalid/docs/routing/">Routing</a></td><td>How requests map to handlers, with a worked example of nested layouts and dynamic segments.</td></tr>
            <tr><td><a href="https://example.invalid/docs/caching/">Caching</a></td><td>Cache layers, revalidation windows and the tradeoffs between them in a long running server.</td></tr>
          </table>
        </main>
      </div>
    </body></html>`;
    const r = await extractContent(wrapped, 'https://example.invalid/docs/');
    expect(r.links).toContain('https://example.invalid/docs/routing/');
    expect(r.links).toContain('https://example.invalid/docs/caching/');
  });
});
