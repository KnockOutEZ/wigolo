/**
 * L-DET seed list — the REAL pages the S11a gate is measured on.
 *
 * WHY A LIST OF URLS AND NOT A VENDORED CORPUS. `synth.ts:4-8` refuses to acquire a page corpus
 * because vendoring third-party pages is a licensing question. That refusal is about CONTENT. What
 * the gate actually needs is GEOMETRY: a list of boxes and a character count per box. No markup, no
 * text, no images and no styles are stored, so nothing copyrightable is vendored and the licensing
 * question the synthetic corpus was avoiding does not arise. `capture.ts` writes exactly that and
 * nothing else, and the frozen file is auditable — it is numbers.
 *
 * COMPOSITION IS PART OF THE GATE, not an accident of what was easy to fetch. `score.ts:122-131`
 * showed the DPR clause's power is a property of which archetypes are present; a corpus assembled by
 * taste inherits that failure silently. So the list is grouped by the layout property each group is
 * here to supply, and `corpus.ts` MEASURES the composition of what actually captured rather than
 * trusting this comment. A group that fails to capture is visible as an adequacy number, not as a
 * quietly weaker gate.
 *
 * Pages are chosen for being stable, public, and cheap to render. A URL that stops resolving is a
 * corpus that shrinks, which `capture.ts` reports and `gate.ts` refuses to score below 30.
 */

export interface SeedGroup {
  /** The layout property this group exists to put in the corpus. */
  property: string;
  why: string;
  urls: string[];
}

export const L_DET_SEEDS: SeedGroup[] = [
  {
    property: 'floor-binding',
    why:
      'Content SHORTER AND NARROWER than the viewport, so the extent normalisation is decided by the ' +
      'viewport floor rather than by the content. `score.ts:122-131`: without these pages the DPR ' +
      'clause is unjudgeable, because the extent divides the ratio out on its own everywhere else.',
    urls: [
      'https://example.com/',
      'https://example.org/',
      'https://example.net/',
      'http://info.cern.ch/',
      'https://www.rfc-editor.org/rfc/rfc2606.html',
      'https://www.iana.org/help/example-domains',
      'https://neverssl.com/',
    ],
  },
  {
    property: 'long-article',
    why: 'One text column far taller than the viewport: the Y extent is decided by content, the X extent by the viewport.',
    urls: [
      'https://en.wikipedia.org/wiki/Hypertext',
      'https://en.wikipedia.org/wiki/Web_browser',
      'https://en.wikipedia.org/wiki/Portable_Network_Graphics',
      'https://developer.mozilla.org/en-US/docs/Web/CSS/flex',
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control',
      'https://nodejs.org/api/fs.html',
      'https://www.sqlite.org/lang_select.html',
      'https://www.postgresql.org/docs/current/sql-select.html',
    ],
  },
  {
    property: 'rail-and-content',
    why: 'A navigation rail beside the content: the group whose layout genuinely RE-FLOWS at a narrow width rather than merely re-wrapping.',
    urls: [
      'https://react.dev/learn',
      'https://vite.dev/guide/',
      'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html',
      'https://go.dev/doc/effective_go',
      'https://doc.rust-lang.org/book/ch03-01-variables-and-mutability.html',
      'https://docs.python.org/3/library/json.html',
      'https://vitest.dev/guide/',
      'https://playwright.dev/docs/intro',
    ],
  },
  {
    property: 'dense-grid',
    why: 'Many similar cards or rows at one grid pitch — the shape most likely to make two DIFFERENT pages sign alike, which is what clause 1 has to survive.',
    urls: [
      'https://news.ycombinator.com/',
      'https://lobste.rs/',
      'https://github.com/nodejs/node',
      'https://github.com/microsoft/TypeScript',
      'https://pypi.org/project/requests/',
      'https://crates.io/crates/serde',
      'https://www.npmjs.com/package/vitest',
      'https://en.wikipedia.org/wiki/List_of_HTTP_status_codes',
    ],
  },
  {
    property: 'landing',
    why: 'Full-bleed hero sections and wide bands: the archetype where the content extent equals the viewport on X and the floor never binds.',
    urls: [
      'https://nodejs.org/en',
      'https://go.dev/',
      'https://www.rust-lang.org/',
      'https://sqlite.org/index.html',
      'https://www.python.org/',
      'https://curl.se/',
      'https://httpd.apache.org/',
      'https://www.kernel.org/',
      'https://www.gnu.org/',
      'https://www.iana.org/',
      'https://www.w3.org/',
      'https://whatwg.org/',
    ],
  },
];

export function allSeedUrls(): string[] {
  return L_DET_SEEDS.flatMap((g) => g.urls);
}

/** Which group a captured URL came from, so `corpus.ts` can report composition rather than assume it. */
export function groupOf(url: string): string {
  for (const g of L_DET_SEEDS) if (g.urls.includes(url)) return g.property;
  return 'unknown';
}
