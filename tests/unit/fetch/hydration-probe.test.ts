import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { isHydrated, isAppShellOnly, classifyDom, HYDRATION_PROBE_SOURCE, APP_SHELL_ONLY_SOURCE, DOM_VERDICT_SOURCE } from '../../../src/fetch/hydration-probe.js';

// linkedom doesn't implement innerText, so we patch HTMLElement.prototype
// before running predicates that depend on text length.
function withInnerText<T>(html: string, fn: (doc: Document) => T): T {
  const { document, HTMLElement } = parseHTML(html);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      // Strip HTML tags and collapse whitespace — good enough for measure().
      return ((this.textContent ?? '') as string).replace(/\s+/g, ' ').trim();
    },
  });
  return fn(document as unknown as Document);
}

describe('isHydrated', () => {
  it('returns false for an empty nav-shell', () => {
    withInnerText(
      '<html><body><nav>nav</nav><div id="__next"></div></body></html>',
      (doc) => {
        expect(isHydrated(doc as never)).toBe(false);
      },
    );
  });

  it('returns true for a fully hydrated article with prose paragraphs', () => {
    const para = '<p>' + 'word '.repeat(40) + '</p>';
    withInnerText(
      `<html><body><article>${para}${para}${para}</article></body></html>`,
      (doc) => {
        expect(isHydrated(doc as never)).toBe(true);
      },
    );
  });

  it('returns true for a code-heavy docs page with only 1-2 paragraphs but many pre blocks (react.dev tutorial shape)', () => {
    const intro = '<p>' + 'words about React '.repeat(20) + '</p>';
    const code = '<pre><code>' + 'const x = 1;\n'.repeat(40) + '</code></pre>';
    const html = `<html><body><main>${intro}${code}${code}${code}</main></body></html>`;
    withInnerText(html, (doc) => {
      expect(isHydrated(doc as never)).toBe(true);
    });
  });

  it('returns true for a VitePress page using .vp-doc inner container', () => {
    const para = '<p>' + 'vp doc body '.repeat(20) + '</p>';
    const pre = '<pre><code>' + 'vue example\n'.repeat(10) + '</code></pre>';
    const html = `<html><body><div class="vp-doc">${para}${para}${pre}${pre}</div></body></html>`;
    withInnerText(html, (doc) => {
      expect(isHydrated(doc as never)).toBe(true);
    });
  });

  it('returns true for a Docusaurus page using .theme-doc-markdown', () => {
    const para = '<p>' + 'docusaurus prose '.repeat(20) + '</p>';
    const html = `<html><body><div class="theme-doc-markdown">${para}${para}${para}</div></body></html>`;
    withInnerText(html, (doc) => {
      expect(isHydrated(doc as never)).toBe(true);
    });
  });

  it('returns true for a GitHub README using .markdown-body', () => {
    const para = '<p>' + 'readme body '.repeat(40) + '</p>';
    const html = `<html><body><article class="markdown-body">${para}${para}${para}</article></body></html>`;
    withInnerText(html, (doc) => {
      expect(isHydrated(doc as never)).toBe(true);
    });
  });

  it('returns true for a Tailwind/Astro page using .prose', () => {
    const para = '<p>' + 'prose paragraph '.repeat(30) + '</p>';
    const html = `<html><body><div class="prose">${para}${para}${para}</div></body></html>`;
    withInnerText(html, (doc) => {
      expect(isHydrated(doc as never)).toBe(true);
    });
  });

  it('returns true on the paragraph-count fallback for blogs without semantic landmarks', () => {
    const para = '<p>' + 'blog paragraph words '.repeat(15) + '</p>';
    const html = `<html><body><div>${para.repeat(5)}</div></body></html>`;
    withInnerText(html, (doc) => {
      expect(isHydrated(doc as never)).toBe(true);
    });
  });

  it('returns false for a large nav-only SPA app-root (react.dev sidebar shell, body not yet mounted)', () => {
    // Regression guard. react.dev wraps everything in <div id="__next">.
    // Before the article mounts, that root already holds a header + a sidebar
    // nav whose link descriptions live in <p> tags: > 1200 chars of chrome text
    // AND >= 3 <p> blocks. The old app-root branch measured the WHOLE root and
    // counted chrome <p>s, so it falsely declared hydrated — the escalation
    // re-poll never fired and page.content() captured nav-only HTML. With the
    // fix the app-root branch counts only content OUTSIDE nav/header/aside, so
    // a nav-only shell is correctly NOT hydrated.
    const navLink = '<p>Section navigation entry describing yet another docs page link target</p>';
    const sidebar = '<nav>' + navLink.repeat(30) + '</nav>';
    const header = '<header>' + 'site header brand search docs blog community '.repeat(20) + '</header>';
    const html = `<html><body><div id="__next">${header}${sidebar}</div></body></html>`;
    withInnerText(html, (doc) => {
      expect(isHydrated(doc as never)).toBe(false);
    });
  });

  it('returns true once the article body mounts inside the app-root alongside the nav shell', () => {
    // The same large nav shell, but now the <main> article has mounted with
    // genuine prose. Content OUTSIDE the chrome clears the threshold → hydrated.
    const navLink = '<p>Section navigation entry describing yet another docs page link target</p>';
    const sidebar = '<nav>' + navLink.repeat(30) + '</nav>';
    const header = '<header>' + 'site header brand search docs blog community '.repeat(20) + '</header>';
    const articlePara = '<p>' + 'Genuine article prose that only appears after hydration completes. '.repeat(15) + '</p>';
    const article = `<main>${articlePara}${articlePara}${articlePara}</main>`;
    const html = `<html><body><div id="__next">${header}${sidebar}${article}</div></body></html>`;
    withInnerText(html, (doc) => {
      expect(isHydrated(doc as never)).toBe(true);
    });
  });

  it('returns false when only the nav-shell rendered (sidebar text, no article)', () => {
    // Header + sidebar + footer prose only, no <main>/<article>/SPA root.
    const navText = '<nav>' + 'nav link '.repeat(30) + '</nav>';
    const sidebar = '<aside>' + 'sidebar item '.repeat(40) + '</aside>';
    const html = `<html><body>${navText}${sidebar}</body></html>`;
    withInnerText(html, (doc) => {
      expect(isHydrated(doc as never)).toBe(false);
    });
  });
});

describe('isAppShellOnly', () => {
  it('returns true for an SPA app-root that has not mounted its body', () => {
    // react.dev pattern: #root exists, only the nav-shell rendered, no article.
    const nav = '<nav>' + 'nav link '.repeat(30) + '</nav>';
    withInnerText(
      `<html><body>${nav}<div id="root"><header>shell</header></div></body></html>`,
      (doc) => {
        expect(isAppShellOnly(doc as never)).toBe(true);
      },
    );
  });

  it('returns false once the app-root has mounted a hydrated article (escalation should stop)', () => {
    const para = '<p>' + 'word '.repeat(40) + '</p>';
    withInnerText(
      `<html><body><div id="root"><main>${para}${para}${para}</main></div></body></html>`,
      (doc) => {
        expect(isAppShellOnly(doc as never)).toBe(false);
      },
    );
  });

  it('returns false for a plain non-SPA doc with no app-root (no escalation)', () => {
    // No #root/#__next/[data-reactroot]/[data-v-app] — a static page that
    // simply has no semantic body should NOT trigger a longer re-poll.
    withInnerText(
      '<html><body><nav>nav</nav><div class="sidebar">links only</div></body></html>',
      (doc) => {
        expect(isAppShellOnly(doc as never)).toBe(false);
      },
    );
  });
});

describe('APP_SHELL_ONLY_SOURCE', () => {
  it('is a self-contained expression with no module references', () => {
    expect(APP_SHELL_ONLY_SOURCE.startsWith('(() => {')).toBe(true);
    expect(APP_SHELL_ONLY_SOURCE.endsWith('})()')).toBe(true);
    expect(APP_SHELL_ONLY_SOURCE).not.toMatch(/import\s/);
    expect(APP_SHELL_ONLY_SOURCE).not.toMatch(/require\(/);
  });

  it('references the SPA app-root selectors it gates escalation on', () => {
    for (const sel of ['#__next', '#root', '[data-reactroot]', '[data-v-app]']) {
      expect(APP_SHELL_ONLY_SOURCE).toContain(sel);
    }
  });
});

describe('HYDRATION_PROBE_SOURCE', () => {
  it('is a self-contained expression with no module references', () => {
    expect(HYDRATION_PROBE_SOURCE.startsWith('(() => {')).toBe(true);
    expect(HYDRATION_PROBE_SOURCE.endsWith('})()')).toBe(true);
    expect(HYDRATION_PROBE_SOURCE).not.toMatch(/import\s/);
    expect(HYDRATION_PROBE_SOURCE).not.toMatch(/require\(/);
  });

  it('includes all known framework selectors so the browser predicate sees them', () => {
    // role="main" gets JSON-escaped inside the source string.
    const checks = ['#__next', '#root', '[data-reactroot]', '[data-v-app]', '.vp-doc', '.VPDoc', '.theme-doc-markdown', '.markdown-body', '.prose'];
    for (const sel of checks) {
      expect(HYDRATION_PROBE_SOURCE).toContain(sel);
    }
    // role="main" appears either with escaped or unescaped quotes — accept both.
    expect(HYDRATION_PROBE_SOURCE).toMatch(/\[role=(?:\\?")main(?:\\?")\]/);
  });
});

describe('classifyDom — completeness verdict primitives', () => {
  it('full hydrated article → hasContent true, nearEmpty false', () => {
    const para = '<p>' + 'word '.repeat(40) + '</p>';
    withInnerText(`<html><body><article>${para}${para}${para}</article></body></html>`, (doc) => {
      const v = classifyDom(doc as never);
      expect(v.hasContent).toBe(true);
      expect(v.nearEmpty).toBe(false);
    });
  });

  it('nav-only shell with NO SPA root → hasContent false, hasSpaRoot false, hasNavChrome true', () => {
    const nav = '<nav>' + '<a>section link description text</a>'.repeat(30) + '</nav>';
    withInnerText(`<html><body>${nav}</body></html>`, (doc) => {
      const v = classifyDom(doc as never);
      expect(v.hasContent).toBe(false);
      expect(v.hasSpaRoot).toBe(false);
      // <nav> IS shell evidence — this stays a nav_shell (safety property).
      expect(v.hasNavChrome).toBe(true);
    });
  });

  it('thin FRAMELESS page (rendered text, no nav/main/aside/header, no SPA root) → no shell evidence', () => {
    // example.com / Hacker News shape: real content but no frame. Must report
    // hasNavChrome false + hasSpaRoot false so toCompleteness labels it
    // partial/thin_content, NOT a shell.
    withInnerText(
      `<html><body><h1>Example Domain</h1><p>${'This domain is for illustrative use. '.repeat(4)}</p></body></html>`,
      (doc) => {
        const v = classifyDom(doc as never);
        expect(v.hasNavChrome).toBe(false);
        expect(v.hasSpaRoot).toBe(false);
      },
    );
  });

  it('<aside> sidebar counts as nav chrome (hasNavChrome true)', () => {
    withInnerText(
      `<html><body><aside class="sidebar">${'<a>link</a>'.repeat(20)}</aside></body></html>`,
      (doc) => {
        expect(classifyDom(doc as never).hasNavChrome).toBe(true);
      },
    );
  });

  it('nav-only shell WITH #root → hasSpaRoot true, hasContent false', () => {
    const nav = '<nav>' + '<a>section link description text</a>'.repeat(30) + '</nav>';
    withInnerText(`<html><body><div id="root">${nav}</div></body></html>`, (doc) => {
      const v = classifyDom(doc as never);
      expect(v.hasSpaRoot).toBe(true);
      expect(v.hasContent).toBe(false);
    });
  });

  it('near-empty body (< 80 chars) → nearEmpty true', () => {
    withInnerText('<html><body><div id="root"></div></body></html>', (doc) => {
      const v = classifyDom(doc as never);
      expect(v.nearEmpty).toBe(true);
    });
  });

  it('substantial body → nearEmpty false', () => {
    withInnerText(`<html><body><p>${'x'.repeat(200)}</p></body></html>`, (doc) => {
      expect(classifyDom(doc as never).nearEmpty).toBe(false);
    });
  });

  // NEGATIVE / MUST-NOT-FIRE: real content pages must classify hasContent=true.
  // These are the shapes most likely to be mis-flagged as shells.
  it('code-heavy docs (few <p>, many <pre>/<code>) → hasContent true (NOT a shell)', () => {
    const intro = '<p>' + 'words about the API '.repeat(20) + '</p>';
    const code = '<pre><code>' + 'const x = 1;\n'.repeat(40) + '</code></pre>';
    withInnerText(`<html><body><main>${intro}${code}${code}${code}</main></body></html>`, (doc) => {
      expect(classifyDom(doc as never).hasContent).toBe(true);
    });
  });

  it('long single-<p> blog → hasContent true (NOT a shell)', () => {
    const longP = '<p>' + 'sentence of prose content here. '.repeat(60) + '</p>';
    withInnerText(`<html><body>${longP}</body></html>`, (doc) => {
      expect(classifyDom(doc as never).hasContent).toBe(true);
    });
  });

  it('<td>-table-dominant page → hasContent true (NOT a shell)', () => {
    const rows = Array.from({ length: 20 }, () =>
      '<tr><td>' + 'cell value data '.repeat(6) + '</td><td>' + 'more cell data '.repeat(6) + '</td></tr>').join('');
    const p = '<p>' + 'intro paragraph text for the table. '.repeat(10) + '</p>';
    withInnerText(`<html><body><main>${p}<table>${rows}</table></main></body></html>`, (doc) => {
      expect(classifyDom(doc as never).hasContent).toBe(true);
    });
  });

  it('.prose container page → hasContent true (NOT a shell)', () => {
    const para = '<p>' + 'meaningful article prose word '.repeat(20) + '</p>';
    withInnerText(`<html><body><div class="prose">${para}${para}${para}</div></body></html>`, (doc) => {
      expect(classifyDom(doc as never).hasContent).toBe(true);
    });
  });

  // MUST-NOT-FIRE: table rows only count toward hydration when co-present PROSE
  // exists. A table with rows but NO <p> is a nav-as-table or a still-mounting
  // skeleton — it must NEVER read as hydrated, or the render gate would leak a
  // shell as content. These pin the over-fire fix (dropped the standalone
  // row-count disjunct; rows require p>=1).
  it('MUST-NOT-FIRE: <main><table> of link rows (nav-as-table, no prose) → NOT hydrated', () => {
    const rows = Array.from({ length: 10 }, (_v, i) =>
      `<tr><td><a href="/p${i}">navigation link label number ${i} with some descriptive text</a></td></tr>`).join('');
    withInnerText(`<html><body><main><table>${rows}</table></main></body></html>`, (doc) => {
      expect(isHydrated(doc as never)).toBe(false);
    });
  });

  it('MUST-NOT-FIRE: <main><table> of "Loading…" skeleton rows (no prose) → NOT hydrated', () => {
    const rows = Array.from({ length: 8 }, () =>
      '<tr><td>Loading placeholder row content that occupies space while mounting</td></tr>').join('');
    withInnerText(`<html><body><main><table>${rows}</table></main></body></html>`, (doc) => {
      expect(isHydrated(doc as never)).toBe(false);
    });
  });

  it('MUST-NOT-FIRE: table-nav inside <div id="root"><main> (no prose) → NOT hydrated', () => {
    const rows = Array.from({ length: 10 }, (_v, i) =>
      `<tr><td><a href="/s${i}">section navigation entry ${i} with descriptive link text here</a></td></tr>`).join('');
    withInnerText(
      `<html><body><div id="root"><main><table>${rows}</table></main></div></body></html>`,
      (doc) => {
        expect(isHydrated(doc as never)).toBe(false);
      },
    );
  });

  it('BOUNDARY: a bare data-table with ZERO prose → NOT hydrated (conservative)', () => {
    // No prose co-signal, so the row credit does not apply. A pure table with
    // no surrounding paragraphs settles via stability and, if unrecognized,
    // labels shell — this test documents that intended boundary.
    const rows = Array.from({ length: 20 }, () =>
      '<tr><td>' + 'cell value data '.repeat(6) + '</td><td>' + 'more cell data '.repeat(6) + '</td></tr>').join('');
    withInnerText(`<html><body><main><table>${rows}</table></main></body></html>`, (doc) => {
      expect(isHydrated(doc as never)).toBe(false);
    });
  });

  // App-root branch parity: a data-table article that mounts DIRECTLY into the
  // SPA root (no <main>/<article> wrapper — common for direct-into-#root SPAs)
  // must classify the same as one inside <main>. The prose-gated row credit +
  // chrome exclusion now live in the app-root branch too.
  it('data-table + intro <p> mounted DIRECTLY in <div id="root"> (no <main>) → hydrated', () => {
    const rows = Array.from({ length: 30 }, () =>
      '<tr><td>' + 'cell value data '.repeat(6) + '</td><td>' + 'more cell data '.repeat(6) + '</td></tr>').join('');
    const p = '<p>' + 'intro paragraph text for the table. '.repeat(10) + '</p>';
    withInnerText(`<html><body><div id="root">${p}<table>${rows}</table></div></body></html>`, (doc) => {
      expect(isHydrated(doc as never)).toBe(true);
    });
  });

  it('MUST-NOT-FIRE: nav-table (rows of <a>, no prose) DIRECTLY in <div id="root"> → NOT hydrated', () => {
    const rows = Array.from({ length: 12 }, (_v, i) =>
      `<tr><td><a href="/p${i}">navigation entry ${i} with descriptive link text here for length</a></td></tr>`).join('');
    withInnerText(`<html><body><div id="root"><table>${rows}</table></div></body></html>`, (doc) => {
      expect(isHydrated(doc as never)).toBe(false);
    });
  });
});

describe('DOM_VERDICT_SOURCE', () => {
  it('is a self-contained expression with no module references', () => {
    expect(DOM_VERDICT_SOURCE.startsWith('(() => {')).toBe(true);
    expect(DOM_VERDICT_SOURCE.endsWith('})()')).toBe(true);
    expect(DOM_VERDICT_SOURCE).not.toMatch(/import\s/);
    expect(DOM_VERDICT_SOURCE).not.toMatch(/require\(/);
  });

  it('returns all four verdict keys', () => {
    for (const key of ['hasContent', 'hasSpaRoot', 'hasNavChrome', 'nearEmpty']) {
      expect(DOM_VERDICT_SOURCE).toContain(key);
    }
  });
});

// classifyDom (TS) ⇄ DOM_VERDICT_SOURCE (inlined string) parity: the verdict
// primitives feed toCompleteness, so a drift between the two implementations
// would silently mislabel completeness in the browser vs. the linkedom tests.
describe('classifyDom ⇄ DOM_VERDICT_SOURCE lockstep', () => {
  const runVerdict = (doc: Document): Record<string, boolean> =>
    new Function('document', `return ${DOM_VERDICT_SOURCE}`)(doc) as Record<string, boolean>;

  const para = '<p>' + 'genuine article prose word '.repeat(30) + '</p>';
  const verdictFixtures: Array<[string, string]> = [
    ['full article', `<html><body><article>${para}${para}${para}</article></body></html>`],
    ['nav shell (no root)', `<html><body><nav>${'<a>link text here for length</a>'.repeat(30)}</nav></body></html>`],
    ['app shell (#root, no content)', `<html><body><div id="root"><nav>${'<a>link</a>'.repeat(20)}</nav></div></body></html>`],
    ['thin frameless', `<html><body><h1>Tiny</h1><p>${'a short rendered sentence. '.repeat(4)}</p></body></html>`],
    ['near-empty', `<html><body><div id="root"></div></body></html>`],
  ];

  for (const [name, html] of verdictFixtures) {
    it(`string verdict matches classifyDom: ${name}`, () => {
      withInnerText(html, (doc) => {
        const ts = classifyDom(doc as never);
        const str = runVerdict(doc as unknown as Document);
        expect(str.hasContent).toBe(ts.hasContent);
        expect(str.hasSpaRoot).toBe(ts.hasSpaRoot);
        expect(str.hasNavChrome).toBe(ts.hasNavChrome);
        expect(str.nearEmpty).toBe(ts.nearEmpty);
      });
    });
  }
});

// LOCKSTEP DRIFT GUARD: isHydrated (TS) and its inlined-string twin
// HYDRATION_PROBE_SOURCE must stay logically identical, but the string is only
// exercised indirectly (mocked page.evaluate), so nothing FAILS if they drift.
// This predicate has now been edited several times (tr add, prose gate,
// app-root parity). Run the REAL string predicate against a linkedom DOM (the
// injected `document` param shadows the global inside the IIFE) and assert it
// matches isHydrated for fixtures that exercise every touched branch.
describe('isHydrated ⇄ HYDRATION_PROBE_SOURCE lockstep (string/TS parity)', () => {
  const runStringPredicate = (doc: Document): boolean =>
    // HYDRATION_PROBE_SOURCE is a `(()=>{...})()` IIFE; `return <source>` runs it.
    new Function('document', `return ${HYDRATION_PROBE_SOURCE}`)(doc) as boolean;

  const para = '<p>' + 'genuine article prose word '.repeat(30) + '</p>';
  const tableRows = Array.from({ length: 30 }, () =>
    '<tr><td>' + 'cell value data '.repeat(6) + '</td><td>' + 'more cell data '.repeat(6) + '</td></tr>').join('');
  const navRows = Array.from({ length: 12 }, (_v, i) =>
    `<tr><td><a href="/p${i}">navigation entry ${i} descriptive link text for length here</a></td></tr>`).join('');
  const codeBlock = '<pre><code>' + 'const x = 1;\n'.repeat(40) + '</code></pre>';

  const fixtures: Array<[string, string]> = [
    ['data-table + prose in <main>', `<html><body><main><p>${'intro text here. '.repeat(20)}</p><table>${tableRows}</table></main></body></html>`],
    ['data-table + prose direct in #root', `<html><body><div id="root"><p>${'intro text here. '.repeat(20)}</p><table>${tableRows}</table></div></body></html>`],
    ['nav-table shell, no prose', `<html><body><main><table>${navRows}</table></main></body></html>`],
    ['plain 3-paragraph article', `<html><body><article>${para}${para}${para}</article></body></html>`],
    ['code-heavy docs page', `<html><body><main><p>intro paragraph about the API here for context.</p>${codeBlock}${codeBlock}</main></body></html>`],
  ];

  for (const [name, html] of fixtures) {
    it(`string predicate matches isHydrated: ${name}`, () => {
      withInnerText(html, (doc) => {
        expect(runStringPredicate(doc)).toBe(isHydrated(doc as never));
      });
    });
  }
});
