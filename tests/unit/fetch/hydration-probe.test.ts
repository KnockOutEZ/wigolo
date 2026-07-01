import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { isHydrated, isAppShellOnly, HYDRATION_PROBE_SOURCE, APP_SHELL_ONLY_SOURCE } from '../../../src/fetch/hydration-probe.js';

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
