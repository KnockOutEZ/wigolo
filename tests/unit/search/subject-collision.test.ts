import { describe, it, expect } from 'vitest';
import {
  normalizeSubjectTerm,
  anchorsSubject,
  computeSubjectAnchorAttrition,
} from '../../../src/search/core/subject-anchor.js';
import { detectSubjectCollision } from '../../../src/search/core/brand-collision.js';

// The brand-collision signal used to be driven by how DISTINCTIVE the query
// NAME looked (a capitalisation heuristic crossed with two hardcoded word
// lists), so it was silent on the queries that actually poison a result set
// ("scrape" -> dictionaries, "best" -> a retailer) and loud on the queries
// least in need of a warning ("DuckDB", "ArchiveBox" -> their own project
// sites). The signal must instead answer the only question that matters to a
// caller: DO THE TOP RESULTS BELONG TO A DIFFERENT SUBJECT THAN THE QUERY
// INTENDS? That is decided PER RESULT against the result set, never from the
// spelling of the query.
//
// These fixtures are the real top-3 observed in the field for each reported
// query. They are the specification.
const REPORTED = {
  scrape: [
    'https://dictionary.cambridge.org/dictionary/english/scrape',
    'https://www.merriam-webster.com/dictionary/scrape',
    'https://www.collinsdictionary.com/dictionary/english/scrape',
  ],
  late: [
    'https://www.bestbuy.com/site/searchpage.jsp?st=late',
    'https://dictionary.cambridge.org/dictionary/english/late',
    'https://www.merriam-webster.com/dictionary/late',
  ],
  best: [
    'https://www.bestbuy.com/',
    'https://www.bestbuy.com/site/deals',
    'https://www.merriam-webster.com/dictionary/best',
  ],
  Marginalia: [
    'https://www.themarginalian.org/',
    'https://www.merriam-webster.com/dictionary/marginalia',
    'https://apps.apple.com/us/app/marginalia-epub-reader/id1234567890',
  ],
  DuckDB: [
    'https://duckdb.org/',
    'https://duckdb.org/docs/stable/',
    'https://github.com/duckdb/duckdb',
  ],
  ArchiveBox: [
    'https://archivebox.io/',
    'https://github.com/ArchiveBox/ArchiveBox',
    'https://docs.archivebox.io/en/latest/',
  ],
} as const;

describe('normalizeSubjectTerm — which query SHAPES can be checked against a result set', () => {
  it('accepts a single compact term, normalised to lowercase alphanumerics', () => {
    expect(normalizeSubjectTerm('ArchiveBox')).toBe('archivebox');
  });

  it('rejects a multi-token query — a descriptive phrase has no single subject a site could be named after', () => {
    // Anchoring a phrase against host names would report a collision on every
    // ordinary informational query, which is exactly the over-fire being fixed.
    expect(normalizeSubjectTerm('react server components streaming')).toBeNull();
  });

  it('rejects a term too short to identify a subject', () => {
    expect(normalizeSubjectTerm('ab')).toBeNull();
  });

  it('strips punctuation so a dotted product name normalises to one term', () => {
    expect(normalizeSubjectTerm('Next.js')).toBe('nextjs');
  });
});

describe('anchorsSubject — the PER-RESULT predicate: is this result about the query subject?', () => {
  it('anchors when the registrable host label is the term', () => {
    expect(anchorsSubject('https://duckdb.org/docs/stable/', 'duckdb')).toBe(true);
  });

  it('anchors when a SUBDOMAIN label is the term', () => {
    expect(anchorsSubject('https://docs.archivebox.io/en/latest/', 'archivebox')).toBe(true);
  });

  it('anchors through a generic site-naming affix ("typescriptlang.org" is TypeScript)', () => {
    // Projects routinely pad their domain with a site word (lang/js/hq/app).
    // Failing to see through it would warn on the healthiest queries there are.
    expect(anchorsSubject('https://www.typescriptlang.org/docs/', 'typescript')).toBe(true);
  });

  it('does NOT anchor when the label merely CONTAINS the term ("themarginalian" is not "marginalia")', () => {
    // The Marginalian is a different publication that lexically swallows the
    // query. Substring containment would silence the very case being reported.
    expect(anchorsSubject('https://www.themarginalian.org/', 'marginalia')).toBe(false);
  });

  it('does NOT anchor a retailer whose name merely starts with the term ("bestbuy" is not "best")', () => {
    expect(anchorsSubject('https://www.bestbuy.com/', 'best')).toBe(false);
  });

  it('anchors an owner/repo pair on a code forge', () => {
    expect(anchorsSubject('https://github.com/duckdb/duckdb', 'duckdb')).toBe(true);
  });

  it('does NOT anchor a ROOT path segment on an ordinary site ("thefreedictionary.com/best")', () => {
    // Measured live: this URL took a top slot on a "best" search. A path
    // segment is where a dictionary puts the WORD, so treating it as a
    // namespace silences the exact collision the signal exists to report.
    expect(anchorsSubject('https://www.thefreedictionary.com/best', 'best')).toBe(false);
  });

  it('anchors a repository named after the term on a code forge', () => {
    expect(anchorsSubject('https://github.com/microsoft/TypeScript', 'typescript')).toBe(true);
  });

  it('does NOT anchor when the term is only a DEEP path segment (a dictionary entry FOR the word)', () => {
    // "/dictionary/english/scrape" contains the term but the page is about the
    // word, not the subject. Matching any path segment would make the detector
    // blind to the single most common collision there is.
    expect(anchorsSubject('https://www.merriam-webster.com/dictionary/scrape', 'scrape')).toBe(false);
  });
});

describe('computeSubjectAnchorAttrition — a hit/miss tally, not a query-wide boolean', () => {
  it('counts anchored and unanchored results individually', () => {
    const a = computeSubjectAnchorAttrition(REPORTED.DuckDB, 'duckdb');
    expect(a.candidates).toBe(3);
    expect(a.anchored).toBe(3);
    expect(a.unanchored).toBe(0);
  });

  it('counts distinct registrable domains so a single site repeating is not read as agreement between sites', () => {
    // "best" -> bestbuy.com twice + merriam-webster.com = 2 distinct sites.
    const a = computeSubjectAnchorAttrition(REPORTED.best, 'best');
    expect(a.anchored).toBe(0);
    expect(a.distinct_domains).toBe(2);
  });

  it('examines at most the top 3 results', () => {
    const a = computeSubjectAnchorAttrition(
      ['https://a.com/', 'https://b.com/', 'https://c.com/', 'https://d.com/'],
      'zzz',
    );
    expect(a.candidates).toBe(3);
  });
});

// N and threshold stated together: the detector examines N = min(3, results).
// It fires only when the anchored count is EXACTLY 0 across those N and at
// least 2 distinct sites are represented. Both gates are integer counts at the
// corpus's own resolution — a single anchored result always silences the
// warning, so there is no sub-resolution fraction that secretly means "never".
describe('detectSubjectCollision — the reported queries that DO poison results must warn', () => {
  it.each([
    ['scrape', REPORTED.scrape],
    ['late', REPORTED.late],
    ['best', REPORTED.best],
    ['Marginalia', REPORTED.Marginalia],
  ])('warns on %s — the top 3 belong to unrelated subjects', (query, urls) => {
    const w = detectSubjectCollision(query, [...urls]);
    expect(w).not.toBeNull();
    expect(w!.detected).toBe(true);
  });
});

describe('detectSubjectCollision — NEGATIVE: a distinctive name whose own site answers must stay silent', () => {
  it.each([
    ['DuckDB', REPORTED.DuckDB],
    ['ArchiveBox', REPORTED.ArchiveBox],
  ])('stays silent on %s — every top result is the project itself', (query, urls) => {
    expect(detectSubjectCollision(query, [...urls])).toBeNull();
  });
});

describe('detectSubjectCollision — NEGATIVE: ordinary healthy single-term queries must not over-fire', () => {
  it.each([
    [
      'typescript',
      [
        'https://www.typescriptlang.org/',
        'https://github.com/microsoft/TypeScript',
        'https://en.wikipedia.org/wiki/TypeScript',
      ],
    ],
    [
      'kubernetes',
      [
        'https://kubernetes.io/',
        'https://github.com/kubernetes/kubernetes',
        'https://en.wikipedia.org/wiki/Kubernetes',
      ],
    ],
    [
      'vitest',
      [
        'https://vitest.dev/',
        'https://github.com/vitest-dev/vitest',
        'https://www.npmjs.com/package/vitest',
      ],
    ],
    [
      'react',
      [
        'https://react.dev/',
        'https://github.com/facebook/react',
        'https://en.wikipedia.org/wiki/React_(software)',
      ],
    ],
    [
      'postgres',
      [
        'https://www.postgresql.org/',
        'https://github.com/postgres/postgres',
        'https://en.wikipedia.org/wiki/PostgreSQL',
      ],
    ],
  ])('stays silent on %s', (query, urls) => {
    expect(detectSubjectCollision(query, urls)).toBeNull();
  });
});

describe('detectSubjectCollision — structural silences', () => {
  it('never fires on a multi-token query — there is no single subject to anchor', () => {
    expect(
      detectSubjectCollision('how to scrape a website', [
        'https://dictionary.cambridge.org/dictionary/english/scrape',
        'https://www.merriam-webster.com/dictionary/scrape',
        'https://www.collinsdictionary.com/dictionary/english/scrape',
      ]),
    ).toBeNull();
  });

  it('never fires on a single result — one unanchored page is not evidence of a competing subject', () => {
    expect(detectSubjectCollision('scrape', ['https://example.com/a'])).toBeNull();
  });

  it('DOES fire when one site supplies every top slot and none is about the subject', () => {
    // Observed live: "ArchiveBox" returned five encyclopedia articles about
    // unrelated archives ("Archive of Our Own", "Archives of American Art")
    // and nothing about the tool. One site answering off-subject is the
    // clearest collision there is — requiring two competing sites would have
    // suppressed exactly this case.
    const w = detectSubjectCollision('ArchiveBox', [
      'https://en.wikipedia.org/wiki/Archive_of_Our_Own',
      'https://en.wikipedia.org/wiki/Archives_of_American_Art',
      'https://en.wikipedia.org/wiki/Archive_of_Folk_Culture',
    ]);
    expect(w).not.toBeNull();
    expect(w!.detected).toBe(true);
  });

  it('never fires on an error-token query — error intent owns those', () => {
    expect(
      detectSubjectCollision('TypeError', [
        'https://a.example/1',
        'https://b.example/2',
        'https://c.example/3',
      ]),
    ).toBeNull();
  });
});

// Frozen from a live, cache-bypassing run of each reported query. The field
// report's fixtures above say what the detector must do in principle; these say
// what it does against what the engines return today.
describe('detectSubjectCollision — live result sets', () => {
  it('warns on "best" — three dictionaries and nothing named "best"', () => {
    expect(
      detectSubjectCollision('best', [
        'https://dictionary.cambridge.org/dictionary/english/best',
        'https://www.thefreedictionary.com/best',
        'https://www.dictionary.com/browse/best',
      ]),
    ).not.toBeNull();
  });

  it('warns on "Marginalia" — the top slots are three different Marginalias, none the search engine', () => {
    expect(
      detectSubjectCollision('Marginalia', [
        'https://en.wikipedia.org/wiki/Marginalia_(search_engine)',
        'https://en.wikipedia.org/wiki/Marginalia',
        'https://en.wikipedia.org/wiki/Marginalia_(EP)',
      ]),
    ).not.toBeNull();
  });

  it('stays silent on "DuckDB" — the project site holds the top slots', () => {
    expect(
      detectSubjectCollision('DuckDB', [
        'https://duckdb.org/',
        'https://duckdb.org/install/',
        'https://pypi.org/project/duckdb/',
      ]),
    ).toBeNull();
  });

  it('stays silent on "scrape" when a scraping toolkit holds top-1, despite two dictionaries below it', () => {
    // The unanimity rule at work: scrape.do genuinely is about scraping, so the
    // caller did get their subject and a warning would be noise. This is the
    // accepted cost of refusing to fire while ANY result belongs to the query —
    // the direction that keeps the signal trustworthy.
    expect(
      detectSubjectCollision('scrape', [
        'https://scrape.do/',
        'https://dictionary.cambridge.org/dictionary/english/scrape',
        'https://en.m.wikipedia.org/wiki/Scrape',
      ]),
    ).toBeNull();
  });
});

describe('detectSubjectCollision — the warning is actionable', () => {
  it('names the sites that took the top slots so the caller can see WHO won', () => {
    const w = detectSubjectCollision('Marginalia', [...REPORTED.Marginalia]);
    expect(w!.brand_domains_in_top_3).toContain('www.themarginalian.org');
    expect(w!.brand_domains_in_top_3).toContain('apps.apple.com');
  });

  it('suggests rewrites that anchor the intended subject', () => {
    const w = detectSubjectCollision('Marginalia', [...REPORTED.Marginalia]);
    expect(w!.suggested_rewrites.length).toBeGreaterThan(0);
    expect(w!.suggested_rewrites.some((r) => r.includes('Marginalia'))).toBe(true);
  });
});
