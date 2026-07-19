// Synthetic SPA corpus. Each fixture encodes ONE failure class from the spec.
// ARTICLE_MARKER must appear in the captured page content iff the article mounted.

export const ARTICLE_MARKER = 'CORPUS-ARTICLE-BODY-9317';
export const NAV_MARKER = 'CORPUS-NAV-LINK-4402';

const ARTICLE_HTML = `<article><h1>Corpus Article</h1>${
  Array.from({ length: 6 }, (_, i) => `<p>${ARTICLE_MARKER} paragraph ${i} ${'lorem ipsum dolor sit amet '.repeat(8)}</p>`).join('')
}</article>`;

const NAV_HTML = `<nav>${
  Array.from({ length: 40 }, (_, i) => `<a href="/p${i}">${NAV_MARKER} section ${i} description text</a>`).join('')
}</nav>`;

// 1. Delayed-mount SPA: shell renders instantly, article mounts after `delayMs`.
// The article HTML must NOT appear in the page source — otherwise page.content()
// would echo the <script> string literal and the marker assertion would pass
// even when the timer never fired. So we reassemble ARTICLE_HTML at runtime from
// halves that are individually meaningless: the full ARTICLE_MARKER exists only
// once the timer mounts the DOM. This is what makes "marker present iff mounted"
// actually hold, which is the entire point of the delayed-mount fixture.
export function delayedMountSpa(delayMs: number): string {
  const mid = Math.ceil(ARTICLE_MARKER.length / 2);
  const head = ARTICLE_MARKER.slice(0, mid);
  const tail = ARTICLE_MARKER.slice(mid);
  // ARTICLE_HTML rebuilt with the marker split across a runtime concatenation.
  const template = ARTICLE_HTML.split(ARTICLE_MARKER).map((s) => JSON.stringify(s)).join(' + MARKER + ');
  return `<!doctype html><html><head><title>Delayed</title></head><body>
<div id="root">${NAV_HTML}</div>
<script>
  var MARKER = ${JSON.stringify(head)} + ${JSON.stringify(tail)};
  setTimeout(function () {
    var el = document.createElement('div');
    el.innerHTML = ${template};
    document.getElementById('root').appendChild(el);
  }, ${delayMs});
</script></body></html>`;
}

// 2. Nav-shell-forever: SPA root + rich nav; article NEVER mounts.
export function navShellForever(): string {
  return `<!doctype html><html><head><title>Shell</title></head><body>
<div id="root">${NAV_HTML}</div>
<script>/* app bundle that never mounts the article */</script></body></html>`;
}

// 3. Never-networkidle: article present immediately, but a beacon loop keeps
//    the network busy so 'networkidle' never fires.
export function neverNetworkidle(): string {
  return `<!doctype html><html><head><title>Beacons</title></head><body>
<main>${ARTICLE_HTML}</main>
<script>
  setInterval(() => { fetch('/beacon?t=' + Date.now()).catch(() => {}); }, 250);
</script></body></html>`;
}

// 4. Instant static page: no JS at all. Latency regression guard.
export function instantStatic(): string {
  return `<!doctype html><html><head><title>Static</title></head><body>
<main>${ARTICLE_HTML}</main></body></html>`;
}

// 5. Generic challenge-shell replica (vendor-neutral markup that the existing
//    challenge classifier recognizes: thin body + verification phrasing).
export function challengeShell(): string {
  return `<!doctype html><html><head><title>Just a moment...</title></head><body>
<div class="cf-browser-verification"><p>Checking your browser before accessing.</p></div>
</body></html>`;
}

// 6. Code-heavy docs page: few <p>, content mostly <pre><code>.
export function codeHeavyDocs(): string {
  const code = `<pre><code>${ARTICLE_MARKER} const x = ${'"code sample line";\n'.repeat(30)}</code></pre>`;
  return `<!doctype html><html><head><title>Docs</title></head><body>
<main><h1>API Reference</h1><p>One intro paragraph.</p>${code}${code}</main></body></html>`;
}

// 7. Ticker: full article + a small region mutating forever. Stability must
//    settle despite ongoing tiny mutations (epsilon absorbs them).
export function tickerPage(): string {
  return `<!doctype html><html><head><title>Ticker</title></head><body>
<main>${ARTICLE_HTML}<div id="ticker">t0</div></main>
<script>
  let n = 0;
  setInterval(() => { document.getElementById('ticker').textContent = 't' + (++n); }, 300);
</script></body></html>`;
}

// 8. Thin frameless page: real rendered text (~150 chars, above the near-empty
//    floor) but NO nav/main/aside/header/footer chrome and NO SPA root — the
//    example.com / Hacker News shape. It is thin/unstructured, not an
//    un-rendered shell, so completeness must be partial/thin_content, NOT shell.
export function thinFrameless(): string {
  return `<!doctype html><html><head><title>Example Domain</title></head><body>
<h1>Example Domain</h1>
<p>This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.</p>
</body></html>`;
}
