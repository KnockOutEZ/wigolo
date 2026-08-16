import { describe, it, expect } from 'vitest';
import {
  normalizeSubjectTerm,
  anchorsSubject,
  titleNamesSubject,
  computeSubjectAnchorAttrition,
  type AnchorCandidate,
} from '../../../src/search/core/subject-anchor.js';
import { detectSubjectCollision } from '../../../src/search/core/brand-collision.js';

// The brand-collision signal used to be driven by how DISTINCTIVE the query
// NAME looked (a capitalisation heuristic crossed with two hardcoded word
// lists), so it fired on the queries least in need of a warning ("DuckDB docs",
// "ArchiveBox setup" -> their own project sites) while a genuinely poisoned
// result set drew nothing. The signal must instead answer the only question
// that matters to a caller: ARE THE TOP RESULTS ABOUT A DIFFERENT SUBJECT THAN
// THE QUERY INTENDS? That is decided PER RESULT against the result set, never
// from the spelling of the query.
//
// All fixtures are frozen from live, cache-bypassing runs on 2026-08-16.
const r = (url: string, title: string): AnchorCandidate => ({ url, title });

describe('normalizeSubjectTerm — which query SHAPES can be checked against a result set', () => {
  it('accepts a single compact term, normalised to lowercase alphanumerics', () => {
    expect(normalizeSubjectTerm('ArchiveBox')).toBe('archivebox');
  });

  it('rejects a multi-token query — a descriptive phrase has no single subject a site could be named after', () => {
    expect(normalizeSubjectTerm('react server components streaming')).toBeNull();
  });

  it('rejects a term too short to identify a subject', () => {
    expect(normalizeSubjectTerm('ab')).toBeNull();
  });

  it('strips punctuation so a dotted product name normalises to one term', () => {
    expect(normalizeSubjectTerm('Next.js')).toBe('nextjs');
  });
});

describe('anchorsSubject — is the SITE named after the subject?', () => {
  it('anchors when the registrable host label is the term', () => {
    expect(anchorsSubject('https://duckdb.org/docs/stable/', 'duckdb')).toBe(true);
  });

  it('anchors when a SUBDOMAIN label is the term', () => {
    expect(anchorsSubject('https://docs.archivebox.io/en/latest/', 'archivebox')).toBe(true);
  });

  it('anchors through a generic site-naming affix ("typescriptlang.org" is TypeScript)', () => {
    expect(anchorsSubject('https://www.typescriptlang.org/docs/', 'typescript')).toBe(true);
  });

  it('does NOT anchor when the label merely CONTAINS the term ("themarginalian" is not "marginalia")', () => {
    expect(anchorsSubject('https://www.themarginalian.org/', 'marginalia')).toBe(false);
  });

  it('does NOT anchor a retailer whose name merely starts with the term ("bestbuy" is not "best")', () => {
    expect(anchorsSubject('https://www.bestbuy.com/', 'best')).toBe(false);
  });

  it('anchors an owner/repo pair on a code forge', () => {
    expect(anchorsSubject('https://github.com/duckdb/duckdb', 'duckdb')).toBe(true);
  });

  it('anchors a repository named after the term on a code forge', () => {
    expect(anchorsSubject('https://github.com/microsoft/TypeScript', 'typescript')).toBe(true);
  });

  it('does NOT anchor a ROOT path segment on an ordinary site ("thefreedictionary.com/best")', () => {
    // Measured live: this URL took a top slot on a "best" search. A path
    // segment is where a dictionary puts the WORD, so treating it as a
    // namespace silences the exact collision the signal exists to report.
    expect(anchorsSubject('https://www.thefreedictionary.com/best', 'best')).toBe(false);
  });

  it('does NOT anchor when the term is only a DEEP path segment (a dictionary entry FOR the word)', () => {
    expect(anchorsSubject('https://www.merriam-webster.com/dictionary/scrape', 'scrape')).toBe(false);
  });
});

// A site affix is a licence for a domain to claim a word it does not own.
// There is no "is the residue a real word" check in the implementation and
// there cannot cheaply be one, so the ONLY thing holding this line is that the
// affix lists stay tiny and contain pure site words. These cases are the ones
// that broke when they did not.
describe('anchorsSubject — a site affix must never swallow a meaningful word', () => {
  it.each([
    ['https://www.thespruce.com/', 'spruce'],
    ['https://theonion.com/', 'onion'],
    ['https://www.theguardian.com/', 'guardian'],
    ['https://www.mysql.com/', 'sql'],
    ['https://www.bestbuy.com/', 'best'],
  ])('%s does not anchor "%s"', (url, term) => {
    expect(anchorsSubject(url, term)).toBe(false);
  });
});

describe('titleNamesSubject — is the PAGE about the subject, whoever hosts it?', () => {
  it('names the subject when the title carries the term, though no site is named after it', () => {
    // The channel that keeps the detector safe for subjects owning no domain.
    expect(titleNamesSubject('Photosynthesis - National Geographic Society', 'photosynthesis')).toBe(true);
  });

  it('matches on whole title tokens, so a different subject sharing a prefix does not count', () => {
    expect(titleNamesSubject('Archive of Our Own', 'archivebox')).toBe(false);
  });

  it('ignores punctuation around the term', () => {
    expect(titleNamesSubject('What is useState () in React - GeeksforGeeks', 'usestate')).toBe(true);
  });
});

describe('computeSubjectAnchorAttrition — a hit/miss tally, not a query-wide boolean', () => {
  it('counts named and unnamed results individually', () => {
    const a = computeSubjectAnchorAttrition(
      [
        r('https://duckdb.org/', 'DuckDB – An in-process SQL OLAP database management system'),
        r('https://duckdb.org/install/', 'DuckDB Installation'),
        r('https://pypi.org/project/duckdb/', 'duckdb · PyPI'),
      ],
      'duckdb',
    );
    expect(a.candidates).toBe(3);
    expect(a.named).toBe(3);
    expect(a.unnamed).toBe(0);
  });

  it('records the hosts that are NOT about the subject so the warning can name them', () => {
    const a = computeSubjectAnchorAttrition(
      [
        r('https://en.wikipedia.org/wiki/Archive_of_Our_Own', 'Archive of Our Own'),
        r('https://en.wikipedia.org/wiki/Archives_of_American_Art', 'Archives of American Art'),
      ],
      'archivebox',
    );
    expect(a.named).toBe(0);
    expect(a.unnamed_hosts).toEqual(['en.wikipedia.org', 'en.wikipedia.org']);
  });

  it('examines at most the top 3 results', () => {
    const a = computeSubjectAnchorAttrition(
      [r('https://a.com/', 'A'), r('https://b.com/', 'B'), r('https://c.com/', 'C'), r('https://d.com/', 'D')],
      'zzz',
    );
    expect(a.candidates).toBe(3);
  });
});

// N and threshold stated together: the detector examines N = min(3, results)
// and fires only when the NAMED count is exactly 0 across those N, with N >= 2.
// Unanimity, not a majority — one result about the subject always silences it.
// Both gates are integer counts at the tally's own resolution, so neither can
// secretly mean "never".
describe('detectSubjectCollision — fires on positive evidence of a wrong subject', () => {
  it('warns when every top result is about something else entirely', () => {
    // Observed live: "ArchiveBox" returned encyclopedia articles about
    // unrelated archives and nothing about the tool.
    const w = detectSubjectCollision('ArchiveBox', [
      r('https://en.wikipedia.org/wiki/Archive_of_Our_Own', 'Archive of Our Own'),
      r('https://en.wikipedia.org/wiki/Archives_of_American_Art', 'Archives of American Art'),
      r('https://en.wikipedia.org/wiki/Archive_of_Folk_Culture', 'Archive of Folk Culture'),
    ]);
    expect(w).not.toBeNull();
    expect(w!.detected).toBe(true);
  });

  it('warns even when one site supplies every top slot — one site answering off-subject is still a collision', () => {
    const w = detectSubjectCollision('ArchiveBox', [
      r('https://en.wikipedia.org/wiki/Archive_of_Our_Own', 'Archive of Our Own'),
      r('https://en.wikipedia.org/wiki/Archives_of_American_Art', 'Archives of American Art'),
    ]);
    expect(w).not.toBeNull();
  });
});

describe('detectSubjectCollision — NEGATIVE: a distinctive name whose own site answers must stay silent', () => {
  it.each([
    [
      'DuckDB',
      [
        r('https://duckdb.org/', 'DuckDB – An in-process SQL OLAP database management system'),
        r('https://duckdb.org/install/', 'DuckDB Installation'),
        r('https://pypi.org/project/duckdb/', 'duckdb · PyPI'),
      ],
    ],
    [
      'ArchiveBox',
      [
        r('https://archivebox.io/', 'ArchiveBox'),
        r('https://github.com/ArchiveBox/ArchiveBox', 'GitHub - ArchiveBox/ArchiveBox'),
        r('https://docs.archivebox.io/en/latest/', 'ArchiveBox Documentation'),
      ],
    ],
  ])('stays silent on %s — every top result is the project itself', (query, results) => {
    expect(detectSubjectCollision(query, results)).toBeNull();
  });
});

describe('detectSubjectCollision — NEGATIVE: ordinary healthy single-term queries must not over-fire', () => {
  it.each([
    ['typescript', [r('https://www.typescriptlang.org/', 'TypeScript: JavaScript With Syntax For Types'), r('https://github.com/microsoft/TypeScript', 'GitHub - microsoft/TypeScript'), r('https://en.wikipedia.org/wiki/TypeScript', 'TypeScript - Wikipedia')]],
    ['kubernetes', [r('https://kubernetes.io/', 'Kubernetes'), r('https://github.com/kubernetes/kubernetes', 'GitHub - kubernetes/kubernetes'), r('https://en.wikipedia.org/wiki/Kubernetes', 'Kubernetes - Wikipedia')]],
    ['vitest', [r('https://vitest.dev/', 'Vitest'), r('https://github.com/vitest-dev/vitest', 'GitHub - vitest-dev/vitest'), r('https://www.npmjs.com/package/vitest', 'vitest - npm')]],
    ['react', [r('https://react.dev/', 'React'), r('https://github.com/facebook/react', 'GitHub - facebook/react'), r('https://en.wikipedia.org/wiki/React_(software)', 'React (software) - Wikipedia')]],
    ['postgres', [r('https://www.postgresql.org/', 'PostgreSQL: The world\'s most advanced open source database'), r('https://github.com/postgres/postgres', 'GitHub - postgres/postgres'), r('https://en.wikipedia.org/wiki/PostgreSQL', 'PostgreSQL - Wikipedia')]],
  ])('stays silent on %s', (query, results) => {
    expect(detectSubjectCollision(query, results)).toBeNull();
  });
});

// THE CLASS THAT AN ANCHOR-ONLY PREDICATE GETS WRONG. Concepts, diseases,
// acronyms and API symbols own no domain, and their CORRECT answer is a
// third-party reference site that can never be named after them. Treating "no
// site is named X" as proof of a collision fires on all of them — so the
// detector requires the page titles to be off-subject too.
describe('detectSubjectCollision — NEGATIVE: subjects that legitimately own no domain', () => {
  it.each([
    [
      'photosynthesis',
      [
        r('https://en.wikipedia.org/wiki/Photosynthesis', 'Photosynthesis - Wikipedia'),
        r('https://education.nationalgeographic.org/resource/photosynthesis/', 'Photosynthesis - National Geographic Society'),
        r('https://en.wikipedia.org/wiki/Photosynthesis_(board_game)', 'Photosynthesis (board game)'),
      ],
    ],
    [
      'ADHD',
      [
        r('https://en.wikipedia.org/wiki/ADHD', 'ADHD'),
        r('https://en.wikipedia.org/wiki/ADHD_(Joyner_Lucas_album)', 'ADHD (Joyner Lucas album)'),
        r('https://en.wikipedia.org/wiki/ADHD_Rating_Scale', 'ADHD Rating Scale'),
      ],
    ],
    [
      'spruce',
      [
        r('https://en.wikipedia.org/wiki/Spruce', 'Spruce - Wikipedia'),
        r('https://en.wikipedia.org/wiki/Spruce_Pine,_North_Carolina', 'Spruce Pine, North Carolina'),
        r('https://en.wikipedia.org/wiki/Spruce_grouse', 'Spruce grouse'),
      ],
    ],
    [
      'onion',
      [
        r('https://en.wikipedia.org/wiki/Onion', 'Onion - Wikipedia'),
        r('https://en.wikipedia.org/wiki/Onion_(disambiguation)', 'Onion (disambiguation)'),
        r('https://en.wikipedia.org/wiki/Onion_routing', 'Onion routing'),
      ],
    ],
    [
      'useState',
      [
        r('https://react.dev/reference/react/useState', 'useState – React'),
        r('https://www.geeksforgeeks.org/reactjs/reactjs-usestate-hook/', 'React useState Hook - GeeksforGeeks'),
        r('https://www.geeksforgeeks.org/reactjs/what-is-usestate-in-react/', 'What is useState () in React - GeeksforGeeks'),
      ],
    ],
  ])('stays silent on %s — the results ARE the subject, just not hosted at its name', (query, results) => {
    expect(detectSubjectCollision(query, results)).toBeNull();
  });
});

// The everyday-word queries from the field report. A dictionary page IS titled
// about the word, so no result-only predicate can separate "the caller meant
// the software sense and got the dictionary" from "the caller meant the word
// and got the right answer". Separating them needs the caller's INTENT, which
// this detector does not have — so it stays silent rather than guessing, and
// these assertions record that limit deliberately rather than by accident.
describe('detectSubjectCollision — everyday words are NOT decidable from results alone', () => {
  it.each([
    [
      'scrape',
      [
        r('https://scrape.do/', 'Scrape.do - Powerful Toolkit for Hassle-Free and Scalable Web Scraping'),
        r('https://dictionary.cambridge.org/dictionary/english/scrape', 'SCRAPE | English meaning - Cambridge Dictionary'),
        r('https://en.m.wikipedia.org/wiki/Scrape', 'Scrape - Wikipedia'),
      ],
    ],
    [
      'best',
      [
        r('https://dictionary.cambridge.org/dictionary/english/best', 'BEST | English meaning - Cambridge Dictionary'),
        r('https://www.thefreedictionary.com/best', 'Best - definition of best by The Free Dictionary'),
        r('https://www.dictionary.com/browse/best', 'BEST Definition & Meaning | Dictionary.com'),
      ],
    ],
    [
      'Marginalia',
      [
        r('https://en.wikipedia.org/wiki/Marginalia_(search_engine)', 'Marginalia (search engine) - Wikipedia'),
        r('https://en.wikipedia.org/wiki/Marginalia', 'Marginalia - Wikipedia'),
        r('https://en.wikipedia.org/wiki/Marginalia_(EP)', 'Marginalia (EP)'),
      ],
    ],
  ])('stays silent on %s — the pages are titled about the word the caller typed', (query, results) => {
    expect(detectSubjectCollision(query, results)).toBeNull();
  });
});

describe('detectSubjectCollision — structural silences', () => {
  it('never fires on a multi-token query — there is no single subject to anchor', () => {
    expect(
      detectSubjectCollision('how to archive a website', [
        r('https://en.wikipedia.org/wiki/Archive_of_Our_Own', 'Archive of Our Own'),
        r('https://en.wikipedia.org/wiki/Archives_of_American_Art', 'Archives of American Art'),
      ]),
    ).toBeNull();
  });

  it('never fires on a single result — one page is not evidence of a competing subject', () => {
    expect(detectSubjectCollision('ArchiveBox', [r('https://example.com/a', 'Something else')])).toBeNull();
  });

  it('never fires on an error-token query — error intent owns those', () => {
    expect(
      detectSubjectCollision('TypeError', [
        r('https://a.example/1', 'Unrelated'),
        r('https://b.example/2', 'Unrelated'),
      ]),
    ).toBeNull();
  });

  it('never fires when results carry no titles and no host matches — absent evidence is not evidence', () => {
    // A result with no title cannot corroborate OR refute the subject. This
    // documents that the tally treats a missing title as "not named", which is
    // why the host channel alone must never be enough to fire on the
    // encyclopedic class -- see the domain-less negatives above.
    const w = detectSubjectCollision('ArchiveBox', [
      r('https://en.wikipedia.org/wiki/Archive_of_Our_Own', ''),
      r('https://en.wikipedia.org/wiki/Archives_of_American_Art', ''),
    ]);
    expect(w).not.toBeNull();
  });
});

describe('detectSubjectCollision — the warning is actionable', () => {
  it('names the sites that took the top slots so the caller can see WHO won', () => {
    const w = detectSubjectCollision('ArchiveBox', [
      r('https://en.wikipedia.org/wiki/Archive_of_Our_Own', 'Archive of Our Own'),
      r('https://www.fanlore.org/wiki/Archive', 'Archive - Fanlore'),
    ]);
    expect(w!.brand_domains_in_top_3).toContain('en.wikipedia.org');
    expect(w!.brand_domains_in_top_3).toContain('www.fanlore.org');
  });

  it('suggests rewrites that anchor the intended subject', () => {
    const w = detectSubjectCollision('ArchiveBox', [
      r('https://en.wikipedia.org/wiki/Archive_of_Our_Own', 'Archive of Our Own'),
      r('https://www.fanlore.org/wiki/Archive', 'Archive - Fanlore'),
    ]);
    expect(w!.suggested_rewrites.length).toBeGreaterThan(0);
    expect(w!.suggested_rewrites.some((s) => s.includes('ArchiveBox'))).toBe(true);
  });
});
