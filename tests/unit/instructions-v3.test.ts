import { describe, it, expect } from 'vitest';
import {
  WIGOLO_INSTRUCTIONS,
  WIGOLO_INSTRUCTIONS_FULL,
  TOOL_DESCRIPTIONS,
} from '../../src/instructions.js';
import type { ToolName } from '../../src/instructions.js';
import { TOOL_SCHEMAS } from '../../src/server/tool-schemas.js';
import { SIGNAL_NAMES } from '../../src/search/hybrid/signals.js';
import {
  RANKING_NOTICE_FIELD,
  RANKING_NOTICE_REASONS,
  buildRankingNotice,
} from '../../src/search/core/rerank-fold.js';
import {
  detectBrandCollision,
  detectEntityCollision,
  detectLexicalCollision,
  isBrandCollisionProne,
} from '../../src/search/core/brand-collision.js';
import { describeDomainFilterCause } from '../../src/search/core/domain-filter-cause.js';
import { mergeCompleteness } from '../../src/extraction/completeness.js';
import { readFileSync } from 'node:fs';

describe('WIGOLO_INSTRUCTIONS v3 routing patterns (per-session)', () => {
  it('mentions all v3 tools by name', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('find_similar');
    expect(WIGOLO_INSTRUCTIONS).toContain('research');
    expect(WIGOLO_INSTRUCTIONS).toContain('agent');
  });

  it('contains documentation lookup routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('include_domains');
  });

  it('contains category param hint', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('cache');
  });

  it('contains library research routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('sitemap');
  });

  it('contains related content routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('find_similar');
  });

  it('contains direct answer routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('answer');
  });

  it('contains comprehensive research routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('research');
    expect(WIGOLO_INSTRUCTIONS).toContain('depth');
  });

  it('contains data gathering routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('agent');
    expect(WIGOLO_INSTRUCTIONS).toContain('schema');
  });

  it('contains cache-first guidance', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('cache');
    expect(WIGOLO_INSTRUCTIONS).toMatch(/before.*(search|fetch|going to the network)/i);
  });

  it('mentions answer format for search', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('answer');
  });

  it('mentions the opt-in local language model knob with capability language', () => {
    // WHY: the local-model tier is a keyless quality lever; the host LLM should
    // learn it exists. The knob name is asserted so the surface tracks the config
    // contract (memory: config-param change → instructions body + this test).
    expect(WIGOLO_INSTRUCTIONS).toContain('WIGOLO_LOCAL_LLM');
    expect(WIGOLO_INSTRUCTIONS).toMatch(/local language model/i);
  });

  it('uses capability language for the local model — never a vendor name', () => {
    // WHY: user-facing text must say "local language model", not the component
    // name. Vendor names are allowed only in warmup/doctor troubleshooting.
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(/ollama/i);
  });

  it('teaches honest research/agent degradation — host LLM synthesizes when no key is set', () => {
    // WHY: research/agent are LLM-optional. Without a synthesis LLM they return a
    // brief / evidence / step log, and the host model must write the final answer
    // ITSELF rather than dump the raw structure as a weak result. If this guidance
    // is dropped, hosts hand users the raw brief and research/agent read as broken.
    expect(WIGOLO_INSTRUCTIONS).toMatch(/LLM-optional/i);
    expect(WIGOLO_INSTRUCTIONS).toMatch(/YOU write the final answer/i);
    expect(WIGOLO_INSTRUCTIONS).toMatch(/raw structure/i);
  });

  it('recommends the free Gemini key as the research/agent quality unlock (honest, keyless-core-preserving)', () => {
    // WHY: the honest UX is "core stays keyless; research/agent synthesis unlocks
    // with a (free) key." The instruction names the exact env config a user sets
    // (provider name Gemini is allowed — it is user config, not an internal dep)
    // and reaffirms that the core tools stay keyless so we never undercut that.
    expect(WIGOLO_INSTRUCTIONS).toMatch(/free Gemini API key/i);
    expect(WIGOLO_INSTRUCTIONS).toContain('WIGOLO_LLM_PROVIDER=gemini');
    expect(WIGOLO_INSTRUCTIONS).toContain('GEMINI_API_KEY');
    expect(WIGOLO_INSTRUCTIONS).toMatch(/core .*(search|fetch).*keyless/i);
  });

  it('never routes users to a competing browser-automation MCP (off-brand + inaccurate)', () => {
    // WHY: wigolo drives interactive page actions itself (fetch `actions` +
    // `use_auth`), so "when NOT to use wigolo → use a dedicated browser-automation
    // MCP" is both off-brand and factually wrong. This negative guard fails if that
    // competitor-routing marketing is ever reintroduced into any user-facing surface.
    const surfaces = [WIGOLO_INSTRUCTIONS, WIGOLO_INSTRUCTIONS_FULL, ...Object.values(TOOL_DESCRIPTIONS)].join('\n');
    expect(surfaces).not.toMatch(/browser[- ]automation MCP/i);
    expect(surfaces).not.toMatch(/dedicated .{0,40}\bMCP\b/i);
    expect(surfaces).not.toMatch(/defer to a browser/i);
    expect(WIGOLO_INSTRUCTIONS).not.toMatch(/when NOT to use wigolo/i);
  });

  it('is a non-empty string of reasonable length', () => {
    expect(typeof WIGOLO_INSTRUCTIONS).toBe('string');
    expect(WIGOLO_INSTRUCTIONS.length).toBeGreaterThan(500);
    expect(WIGOLO_INSTRUCTIONS.length).toBeLessThan(10000);
  });

  it('does not contain implementation details or code samples', () => {
    expect(WIGOLO_INSTRUCTIONS).not.toContain('import ');
    expect(WIGOLO_INSTRUCTIONS).not.toContain('function ');
    expect(WIGOLO_INSTRUCTIONS).not.toContain('const ');
    expect(WIGOLO_INSTRUCTIONS).not.toContain('npm ');
  });

  it('uses backtick-quoted tool names consistently', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain('`search`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`fetch`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`crawl`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`cache`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`extract`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`find_similar`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`research`');
    expect(WIGOLO_INSTRUCTIONS).toContain('`agent`');
  });
});

describe('hybrid fallback signal documentation stays in sync with the code', () => {
  // WHY: the shipped signal list is written out by hand in the MCP instructions
  // (what an agent actually reads) and in the installed CLAUDE.md block. Adding
  // a signal to SIGNALS wires it correctly at runtime with a green typecheck
  // while those prose lists silently under-report it — a seam miss no other
  // test could catch, because the instruction tests never enumerated signals.
  // Derived from SIGNAL_NAMES so it cannot drift again.
  it('names every registered fallback signal in WIGOLO_INSTRUCTIONS_FULL', () => {
    for (const name of SIGNAL_NAMES) {
      expect(WIGOLO_INSTRUCTIONS_FULL).toContain(name);
    }
  });

  it('names every registered fallback signal in the installed CLAUDE.md block', () => {
    const block = readFileSync(
      new URL('../../assets/blocks/claude-code/CLAUDE.md.block', import.meta.url),
      'utf8',
    );
    for (const name of SIGNAL_NAMES) {
      expect(block).toContain(name);
    }
  });
});

describe('ranking-notice documentation stays in sync with the code', () => {
  // WHY: same seam that under-reported the hybrid fallback signals. A search
  // response field can be wired end-to-end with a green typecheck and a green
  // test suite while the instructions an agent actually reads never mention it
  // — which makes the signal invisible to its only audience. Derived from
  // RANKING_NOTICE_FIELD (the constant the provider assigns through), so a
  // rename breaks this test instead of silently desyncing the prose.
  it('names the ranking notice field in the per-session instructions', () => {
    expect(WIGOLO_INSTRUCTIONS).toContain(RANKING_NOTICE_FIELD);
  });

  it('names the ranking notice field in the search tool description', () => {
    expect(TOOL_DESCRIPTIONS.search).toContain(RANKING_NOTICE_FIELD);
  });

  it('names the ranking notice field in the full usage guide', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain(RANKING_NOTICE_FIELD);
  });

  it('names the ranking notice field in the installed CLAUDE.md block', () => {
    // The block is copied into real users' projects, so a signal missing here
    // is missing from the surface with the widest reach of the four.
    const block = readFileSync(
      new URL('../../assets/blocks/claude-code/CLAUDE.md.block', import.meta.url),
      'utf8',
    );
    expect(block).toContain(RANKING_NOTICE_FIELD);
  });

  it('documents it as conditional, not always-emitted', () => {
    // It must not be promised on every response — it fires only when reranking
    // gave no ordering signal, and an agent told otherwise would treat its
    // absence as a bug.
    expect(TOOL_DESCRIPTIONS.search).toMatch(/`?ranking_notice`? is emitted only when/i);
  });

  it('every reason that renders a notice is reachable and non-empty', () => {
    // Guards the reverse drift: a reason added to the enum but left without
    // text would emit nothing and reintroduce the silent no-op.
    expect(RANKING_NOTICE_REASONS.length).toBeGreaterThan(0);
    for (const reason of RANKING_NOTICE_REASONS) {
      expect(buildRankingNotice({ reason, window: 3 })).toBeTruthy();
    }
  });
});

/**
 * The full guide's bullet for one response field. Assertions about a field must
 * bind to ITS line: several of the words that matter here ("empty", "query
 * shape") occur elsewhere in the guide, so a whole-document match can pass while
 * the field itself goes undescribed.
 */
function fullGuideBullet(field: string): string {
  const line = WIGOLO_INSTRUCTIONS_FULL.split('\n').find((l) => l.startsWith(`- \`${field}\``));
  expect(line, `no \`${field}\` bullet found in the full usage guide`).toBeDefined();
  return line as string;
}

describe('response fields the agent can only learn about from a description', () => {
  // WHY this whole block exists: a response field can be wired end-to-end with a
  // green typecheck while the only surfaces an agent reads never mention it —
  // making it invisible to its audience — or, worse, describe a firing rule the
  // code stopped implementing. Each test below pairs the prose claim with an
  // OUTSIDE signal taken from the code that produces the field, so the assertion
  // cannot be satisfied by agreeing with itself.

  it('search names `domain_filter` and routes the caller to widening, not retrying', () => {
    // An empty response has two causes with opposite fixes: a dead engine pool
    // (retry) and an over-narrow scope (widen). Without the field named here an
    // agent reads "no results" and retries the engines forever.
    const desc = TOOL_DESCRIPTIONS.search;
    expect(desc).toContain('domain_filter');
    expect(desc).toContain('include_domains');
    expect(desc).toMatch(/widen/i);
  });

  it('describes `domain_filter` as conditional — the code withholds it whenever the scope is innocent', () => {
    // Outside signal: the runtime cause predicate returns undefined the moment
    // one result survived the scope, and on a genuine engine failure. A
    // description promising the field unconditionally teaches agents to read its
    // absence as a bug.
    expect(
      describeDomainFilterCause({ include_domains: ['react.dev'], candidates: 5, matched: 1, dropped: 4 }),
    ).toBeUndefined();
    expect(
      describeDomainFilterCause({ include_domains: ['react.dev'], candidates: 0, matched: 0, dropped: 0 }),
    ).toBeUndefined();
    expect(
      describeDomainFilterCause({ include_domains: ['react.dev'], candidates: 5, matched: 0, dropped: 5 }),
    ).toBeDefined();
    expect(TOOL_DESCRIPTIONS.search).toMatch(/`domain_filter`[^.]*only when/i);
  });

  it('never describes `brand_collision_warning` as brand-domain-only — its other paths need no brand domain', () => {
    // Outside signal: an entity-collision query fires the warning while the
    // brand-domain detector stays silent on the very same results. "A brand
    // domain dominates the top-3" therefore under-reports the field on every
    // surface that still says it.
    expect(detectEntityCollision('Phoenix framework')).not.toBeNull();
    expect(detectBrandCollision('Phoenix framework', ['https://example.com/a'])).toBeNull();
    for (const surface of [TOOL_DESCRIPTIONS.search, WIGOLO_INSTRUCTIONS_FULL]) {
      expect(surface).not.toMatch(/brand[- ]domain (dominates|top-3 collision)/i);
      expect(surface).toMatch(/different subject/i);
    }
  });

  it('covers the query-shape paths, which never look at the results at all', () => {
    // Outside signal: `detectEntityCollision` takes NO results argument — it
    // fires on a capitalized head plus a generic tail noun and reports an EMPTY
    // host list. `GENERIC_TAIL_NOUNS` is ~70 everyday words (docs, api, pricing,
    // guide, setup, status …), so this is plausibly the highest-volume path in
    // production. A description framed only as "the top results look like …"
    // tells an agent the warning is evidence ABOUT the result set, which for
    // this path it is not.
    for (const q of ['Prisma pricing', 'Vercel deployment', 'Stripe api reference']) {
      const w = detectEntityCollision(q);
      expect(w, `entity collision should fire on "${q}"`).not.toBeNull();
      expect(w!.brand_domains_in_top_3).toEqual([]);
    }
    expect(TOOL_DESCRIPTIONS.search).toMatch(/query shape|query or the result/i);
    // Bound to the field's own bullet: "query shape" already appears elsewhere
    // in the guide (the is_brand_collision_prone sentence), so a whole-document
    // match would pass without this path ever being described.
    expect(fullGuideBullet('brand_collision_warning')).toMatch(/generic tail|without looking|query shape/i);
  });

  it('makes no exclusive claim about when the collision warning fires', () => {
    // An enumeration that misses a path is a gap; an enumeration that misses a
    // path while saying "only when" is a false statement. Four detectors run at
    // core-provider.ts:916-919 and any of them can speak.
    expect(TOOL_DESCRIPTIONS.search).not.toMatch(/`brand_collision_warning` fires only when/);
  });

  it('does not promise a populated host list — two paths always return empty', () => {
    // Outside signal: both query-shape detectors hardcode an empty array, so
    // "carries whichever hosts the firing path found" would have an agent read
    // `[]` as "no hosts were involved" rather than "this path never looks".
    expect(detectLexicalCollision('usestate')!.brand_domains_in_top_3).toEqual([]);
    expect(detectEntityCollision('Prisma pricing')!.brand_domains_in_top_3).toEqual([]);
    // "empty" occurs several times in the guide, so match the field's own bullet.
    expect(fullGuideBullet('brand_collision_warning')).toMatch(/empty/i);
  });

  it('names the image response fields, which no input schema can document', () => {
    // Outside signal: TOOL_SCHEMAS holds INPUT schemas only and there is no
    // outputSchema anywhere in the server, so these names are genuinely absent
    // from every machine-readable surface. Cutting them from this description
    // to buy token headroom makes them unlearnable, not "recoverable from the
    // schema" — trim where the information actually survives the cut.
    const schemaText = JSON.stringify(TOOL_SCHEMAS);
    for (const field of ['image_alt', 'thumbnail_url']) {
      expect(schemaText, `${field} is in an input schema — re-check this guard`).not.toContain(field);
      expect(TOOL_DESCRIPTIONS.search, `${field} is unlearnable if not named here`).toContain(field);
    }
  });

  it('documents `is_brand_collision_prone` as a query-shape signal, not a predictor of the warning', () => {
    // Outside signal: the predicate is query-only and reads FALSE for a query
    // the warning does fire on, so "will the warning fire?" is the one thing it
    // cannot answer. An agent told otherwise skips a real collision report.
    expect(isBrandCollisionProne('usestate')).toBe(false);
    expect(detectLexicalCollision('usestate')).not.toBeNull();
    expect(WIGOLO_INSTRUCTIONS_FULL).toMatch(/query shape alone|does not predict/i);
  });

});

describe('fetch completeness verdict is described by meaning, not by enum', () => {
  it('fetch explains what `partial` MEANS — extraction loss, not just an enum value', () => {
    // Outside signal: an extraction-tier `partial` verdict beats a browser tier
    // that already declared the render complete, so `partial` is reachable on a
    // page that otherwise looks fine. Listing "full/partial/shell" without that
    // meaning gives an agent nothing it can act on.
    expect(
      mergeCompleteness(
        { level: 'full', reason: 'content_verified', settled_by: 'stability' },
        { level: 'partial', reason: 'list_titles_dropped', settled_by: 'extraction' },
      )?.reason,
    ).toBe('list_titles_dropped');
    const desc = TOOL_DESCRIPTIONS.fetch;
    expect(desc).toContain('content_completeness');
    expect(desc).toMatch(/dropped|lost/i);
    expect(desc).toMatch(/title/i);
  });

  it('fetch does not let an absent completeness verdict read as "the page is fine"', () => {
    // Outside signal: with neither producer entitled to a verdict the merge
    // yields undefined — the field is simply missing, which is not a `full`
    // claim and must not be described as one.
    expect(mergeCompleteness(undefined, undefined)).toBeUndefined();
    expect(TOOL_DESCRIPTIONS.fetch).toMatch(/absent/i);
  });
});

describe('WIGOLO_INSTRUCTIONS_FULL v3 routing patterns (resource)', () => {
  it('contains the error debugging routing pattern', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toMatch(/error/i);
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('category');
  });

  it('contains multi-query guidance', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toMatch(/multi.*query|array.*query|semantically.*varied/i);
  });

  it('preserves existing v2 routing guidance moved to the full doc', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('localhost');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('use_auth');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('full-text search syntax');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('sitemap');
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('include_patterns');
  });

  it('documents the opt-in local language model tier with capability language', () => {
    expect(WIGOLO_INSTRUCTIONS_FULL).toContain('WIGOLO_LOCAL_LLM');
    expect(WIGOLO_INSTRUCTIONS_FULL).toMatch(/local language model/i);
    expect(WIGOLO_INSTRUCTIONS_FULL).not.toMatch(/ollama/i);
  });
});

describe('TOOL_DESCRIPTIONS v3 entries', () => {
  it('has all 20 tool descriptions (10 core + the 10 studio tools)', () => {
    const keys = Object.keys(TOOL_DESCRIPTIONS);
    expect(keys).toContain('fetch');
    expect(keys).toContain('search');
    expect(keys).toContain('crawl');
    expect(keys).toContain('cache');
    expect(keys).toContain('extract');
    expect(keys).toContain('find_similar');
    expect(keys).toContain('research');
    expect(keys).toContain('agent');
    expect(keys).toContain('diff');
    expect(keys).toContain('watch');
    // P1 (§5): the public entry verb — open/focus the workspace and start a drivable session.
    expect(keys).toContain('studio_open');
    // Phase 2H: the first studio_* tool — the agent's read-only perception of the session.
    expect(keys).toContain('studio_observe');
    // Phase 2I: the agent's acting verb in the session (navigate; click/type/scroll later).
    expect(keys).toContain('studio_act');
    // Phase 3c: the agent reads the human's marks.
    expect(keys).toContain('studio_marks');
    // Phase 4c: the agent persists a capture (clip) to the cache as a session artifact.
    expect(keys).toContain('studio_capture');
    // P4 co-drive: the agent posts to the human chat rail.
    expect(keys).toContain('studio_say');
    // S6 (the bounded inversion): the agent's own background-session lifecycle verbs.
    expect(keys).toContain('studio_spawn');
    expect(keys).toContain('studio_close');
    expect(keys).toContain('studio_list');
    expect(keys).toContain('studio_extract_set');
    expect(keys.length).toBe(20);
  });

  it('studio_act description covers navigation, the control token, and the private/metadata block', () => {
    const desc = TOOL_DESCRIPTIONS.studio_act;
    expect(desc).toMatch(/navigat/i);
    expect(desc).toMatch(/control|hold|turn|took over/i); // token-gated
    expect(desc).toMatch(/private|local|internal|blocked/i); // SSRF posture, capability language
    expect(desc).not.toContain('CDP'); // no implementation names (user-facing)
  });

  it('studio_observe description marks the snapshot content as untrusted page data, not instructions (Phase 6a trust boundary)', () => {
    const desc = TOOL_DESCRIPTIONS.studio_observe;
    expect(desc).toMatch(/untrusted|not instructions|page-derived/i); // the agent must treat page content as data
    expect(desc).toMatch(/instruction/i); // explicitly: page content is not instructions
    expect(desc).not.toContain('CDP'); // no implementation names (user-facing)
  });

  /**
   * PIN 8 (#57). The reshaping is only half-done if the capability ships and the description does
   * not name it: an agent discovers `find` and `post_actions` from the description or not at all,
   * and the pin's own words are "grep-over-page rides `studio_observe` as a `find` param AND ITS
   * DESCRIPTION NAMES IT".
   */
  it('studio_observe description names the find param and its found result (pin 8)', () => {
    const desc = TOOL_DESCRIPTIONS.studio_observe;
    expect(desc).toContain('find');
    expect(desc).toContain('find_regex');
    expect(desc).toContain('found');
    expect(desc).toMatch(/grep|search|match/i);
  });

  it('studio_act description names the post-actions it now attaches, and how to turn them off (pin 8)', () => {
    const desc = TOOL_DESCRIPTIONS.studio_act;
    expect(desc).toContain('post_actions');
    expect(desc).toMatch(/console/i);
    expect(desc).toMatch(/settle|what the page became/i);
  });

  it('the reshaped descriptions cross-reference the cheaper sibling for the job (pin 8)', () => {
    // A tool description is the only place an agent learns that a cheaper tool exists for what it
    // is about to do. Driving a session to read a page, or clicking around to find an element, are
    // the two expensive habits these two tools invite; each now names the cheaper route.
    expect(TOOL_DESCRIPTIONS.studio_observe).toMatch(/`fetch` reads it/i);
    expect(TOOL_DESCRIPTIONS.studio_act).toMatch(/`find`/);
  });

  it('the reshaped descriptions keep capability language — no engine or library names', () => {
    const both = TOOL_DESCRIPTIONS.studio_observe + TOOL_DESCRIPTIONS.studio_act;
    expect(both).toMatch(/browser engine/i); // the capability name, not the implementation
    for (const banned of ['CDP', 'Playwright', 'Chromium', 'Chrome DevTools', 'Puppeteer', 'Electron']) {
      expect(both, `capability language: '${banned}' is an implementation name`).not.toContain(banned);
    }
  });

  it('studio_capture description covers both the clip and the qa (save-session-as-research) capture types', () => {
    const desc = TOOL_DESCRIPTIONS.studio_capture;
    expect(desc).toContain('clip');
    expect(desc).toMatch(/\bqa\b/); // qa is a first-class capture type (C5)
    expect(desc).toMatch(/question/i);
    expect(desc).toMatch(/answer/i);
    expect(desc).not.toContain('CDP'); // capability language only (user-facing)
  });

  it('find_similar description mentions url and concept inputs', () => {
    const desc = TOOL_DESCRIPTIONS.find_similar;
    expect(desc).toContain('url');
    expect(desc).toContain('concept');
  });

  it('find_similar description mentions similarity/related', () => {
    const desc = TOOL_DESCRIPTIONS.find_similar;
    expect(desc).toMatch(/similar|related/i);
  });

  it('research description mentions depth levels', () => {
    const desc = TOOL_DESCRIPTIONS.research;
    expect(desc).toContain('quick');
    expect(desc).toContain('standard');
    expect(desc).toContain('comprehensive');
  });

  it('research description mentions synthesis/report', () => {
    const desc = TOOL_DESCRIPTIONS.research;
    expect(desc).toMatch(/synthe|report/i);
  });

  it('research description mentions sub-queries', () => {
    const desc = TOOL_DESCRIPTIONS.research;
    expect(desc).toMatch(/sub.?quer|decompos/i);
  });

  it('research description degrades honestly — host writes the answer + free-key recommendation', () => {
    // WHY: with no synthesis LLM, research returns a structured brief, not prose.
    // The description must tell the caller to synthesize from the brief (not hand
    // over the raw structure) and recommend a free key for best quality — without
    // this, the tool reads as a poor result whenever no LLM is configured.
    const desc = TOOL_DESCRIPTIONS.research;
    expect(desc).toMatch(/LLM-optional/i);
    expect(desc).toMatch(/without one/i);
    expect(desc).toMatch(/key_findings|brief/);
    expect(desc).toMatch(/free Gemini API key/i);
  });

  it('agent description mentions prompt-driven workflow', () => {
    const desc = TOOL_DESCRIPTIONS.agent;
    expect(desc).toContain('prompt');
  });

  it('agent description mentions schema extraction', () => {
    const desc = TOOL_DESCRIPTIONS.agent;
    expect(desc).toContain('schema');
  });

  it('agent description mentions steps/transparency', () => {
    const desc = TOOL_DESCRIPTIONS.agent;
    expect(desc).toMatch(/step|transparen/i);
  });

  it('agent description mentions max_pages and max_time_ms', () => {
    const desc = TOOL_DESCRIPTIONS.agent;
    expect(desc).toContain('max_pages');
    expect(desc).toContain('max_time_ms');
  });

  it('agent description degrades honestly — host writes the summary + free-key recommendation', () => {
    // WHY: with no synthesis LLM, agent returns gathered evidence + a step log,
    // not a written summary. The description must tell the caller to write the
    // summary from the evidence itself and recommend a free LLM key — otherwise
    // the raw step log gets surfaced as a weak result.
    const desc = TOOL_DESCRIPTIONS.agent;
    expect(desc).toMatch(/LLM-optional/i);
    expect(desc).toMatch(/without one/i);
    expect(desc).toMatch(/evidence/i);
    expect(desc).toMatch(/free LLM key|Gemini/i);
  });

  it('search description mentions format: answer', () => {
    const desc = TOOL_DESCRIPTIONS.search;
    expect(desc).toContain('answer');
  });

  it('search description mentions multi-query array', () => {
    const desc = TOOL_DESCRIPTIONS.search;
    expect(desc).toMatch(/array|multi.*query/i);
  });

  it('each description is a non-empty string under 2000 chars', () => {
    for (const [key, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(50);
      expect(desc.length).toBeLessThan(2000);
    }
  });

  it('no description contains code or imports', () => {
    for (const [key, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(desc).not.toContain('import ');
      expect(desc).not.toContain('require(');
    }
  });

  it('all existing v2 descriptions are preserved', () => {
    expect(TOOL_DESCRIPTIONS.fetch).toContain('section');
    expect(TOOL_DESCRIPTIONS.fetch).toContain('render_js');
    expect(TOOL_DESCRIPTIONS.crawl).toContain('sitemap');
    expect(TOOL_DESCRIPTIONS.cache).toContain('AND, OR, NOT');
    expect(TOOL_DESCRIPTIONS.extract).toContain('schema');
  });

  it('fetch description advertises its OWN interactive capability (actions + use_auth), not a competitor', () => {
    // WHY: fetch handles click/scroll/login pages itself via the `actions` input
    // (click/type/scroll/wait, verified in the fetch schema) and `use_auth`. The
    // old text deferred these flows to a browser-automation MCP — off-brand and
    // wrong. This asserts the positive capability replaced it and the deferral is gone.
    const desc = TOOL_DESCRIPTIONS.fetch;
    expect(desc).toContain('actions');
    expect(desc).toContain('use_auth');
    expect(desc).toMatch(/click/i);
    expect(desc).not.toMatch(/browser[- ]automation MCP/i);
    expect(desc).not.toMatch(/defer to a browser/i);
  });
});

describe('ToolName type', () => {
  /**
   * This used to be a hand-written 14-name literal asserting `length === 14` against a 20-name
   * union — it passed vacuously for two phases while six tools were missing from it, which is
   * exactly the drift a literal list cannot catch. The invariant it MEANT to hold is that ToolName
   * and the schema map describe the same set, so assert that in both directions and derive the
   * runtime half from the source rather than retyping it.
   */
  it('is exactly the key set of the schema map — a name in one and not the other cannot compile', () => {
    type SchemaKey = keyof typeof TOOL_SCHEMAS;
    const everyToolNameHasASchema: ToolName extends SchemaKey ? true : never = true;
    const everySchemaIsAToolName: SchemaKey extends ToolName ? true : never = true;
    expect(everyToolNameHasASchema && everySchemaIsAToolName).toBe(true);

    const names = Object.keys(TOOL_DESCRIPTIONS) as ToolName[];
    for (const name of names) {
      expect(TOOL_SCHEMAS[name], `${name} has no input schema`).toBeDefined();
    }
    expect(names.length).toBe(Object.keys(TOOL_SCHEMAS).length);
  });
});
