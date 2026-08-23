import { parseHTML } from 'linkedom';
import { stripHiddenDom, type VisibilityDocument } from '../../src/extraction/visibility.js';
import type { StructuredData } from '../../src/types.js';
import type { Assertion, AssertionContext, AssertionResult, Category, FixtureResult, HealTier, MarkdownFeature, ScrapeReport, CategorySummary } from './types.js';

/** Count a markdown feature. Deliberately simple and line-based: the point is to
 *  detect a feature DISAPPEARING (a table flattened to prose, code fences dropped),
 *  not to parse markdown perfectly. */
export function countFeature(markdown: string, feature: MarkdownFeature): number {
  switch (feature) {
    case 'heading':
      return (markdown.match(/^#{1,6}\s+\S/gm) ?? []).length;
    case 'table_row':
      // A pipe row with at least two cell separators, minus the |---|---| alignment
      // rule — a flattened table leaves the rule behind, so counting it would let a
      // collapsed table still score as preserved.
      return (markdown.match(/^\|(?:[^|\n]*\|){2,}\s*$/gm) ?? []).filter((line) => {
        const cells = line.trim().split('|').slice(1, -1);
        const isRule = cells.length > 0 && cells.every((c) => /^[\s:-]*$/.test(c) && c.includes('-'));
        return !isRule;
      }).length;
    case 'link':
      return (markdown.match(/\[[^\]]*\]\([^)]+\)/g) ?? []).length;
    case 'code_block':
      return Math.floor((markdown.match(/^```/gm) ?? []).length / 2);
    case 'list_item':
      return (markdown.match(/^\s*(?:[-*+]|\d+\.)\s+\S/gm) ?? []).length;
    case 'char':
      return markdown.length;
  }
}

function structuredCount(data: StructuredData, field: string): number {
  const v = (data as unknown as Record<string, unknown>)[field];
  return Array.isArray(v) ? v.length : 0;
}

function tableCells(data: StructuredData): string[] {
  const out: string[] = [];
  for (const t of data.tables ?? []) {
    for (const h of t.headers ?? []) out.push(String(h));
    for (const row of t.rows ?? []) for (const cell of Object.values(row)) out.push(String(cell));
  }
  return out;
}

/** Normalise for substring checks: extraction legitimately reflows whitespace and
 *  may escape markdown punctuation, so neither should read as a regression. */
function norm(s: string): string {
  // Unescape ANY backslash-escaped ASCII punctuation, not a hand-listed set —
  // Turndown's escape set is version-dependent, and a missing character would make
  // the gate fire on a dependency bump rather than on a real quality change.
  return s.replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/\s+/g, ' ').toLowerCase();
}

/** Heal tiers are ordered; `heal_at_least` is a floor, not an equality. */
const HEAL_RANK: Record<HealTier, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** Strip tags and decode the handful of entities that would hide a literal match. */
function htmlText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

/** Non-overlapping occurrence count, on the same normalised form the substring
 *  checks use — so "twice in the source" and "twice in the markdown" are counted
 *  by one rule and cannot disagree over whitespace or markdown escaping. */
function occurrences(haystack: string, needle: string): number {
  const h = norm(haystack);
  const n = norm(needle);
  if (n.length === 0) return 0;
  let count = 0;
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) count += 1;
  return count;
}

/** Attributes an HTML→markdown serialiser carries through into the output. A link's
 *  `title` becomes `[text](href "title")` and an image's `alt` becomes `![alt](src)`,
 *  so both are text the markdown may legitimately hold a copy of. Leaving them out
 *  would make the referee count a faithful serialisation as a leak. */
const MARKDOWN_BEARING_ATTRS: ReadonlyArray<string> = ['title', 'alt'];

interface TextScopeElement {
  getAttribute(name: string): string | null;
  parentNode: { removeChild(child: TextScopeElement): void } | null;
}
interface TextScope {
  querySelectorAll(selector: string): ArrayLike<TextScopeElement>;
  textContent: string | null;
}

/** Read through the DOM rather than off a re-serialised string: linkedom re-emits
 *  `&nbsp;` as `&#160;`, so a regex tag-stripper would leave an undecoded entity
 *  sitting between two words and report a present value as absent. */
function scopeText(scope: TextScope): string {
  const parts = [scope.textContent ?? ''];
  for (const attr of MARKDOWN_BEARING_ATTRS) {
    const nodes = scope.querySelectorAll(`[${attr}]`);
    for (let i = 0; i < nodes.length; i++) parts.push(nodes[i]!.getAttribute(attr) ?? '');
  }
  return parts.join(' ');
}

/**
 * The text a value could reach the markdown FROM, with and without the hidden subtrees.
 *
 * The hidden side is dropped by the extractor's OWN `stripHiddenDom`, so the referee and
 * the thing it referees agree on what "hidden" means by construction rather than by two
 * hand-maintained rules drifting apart. Scoped to `<body>`: head metadata is never
 * rendered, and counting it would let a `<meta>` copy of a string excuse a real leak.
 *
 * One parse, read twice — `stripHiddenDom` mutates in place, so `all` is taken before it
 * runs and `visible` after. The fixtures are whole Wikipedia articles and a second parse
 * of each measurably lengthened the referee lane for nothing.
 */
function reachableText(html: string): { all: string; visible: string } {
  const { document } = parseHTML(html);
  // `<script>` / `<style>` bodies are not rendered text and must never count as visible.
  // `wikipedia-covid19` is the fixture that makes this matter: its second occurrence of the
  // hidden string lives in a JSON-LD `<script>`. Counted as visible, it would silently pay
  // for one leaked copy of the hidden div — the row would pass for a reason unrelated to
  // visibility, and would flip the day anything promoted script text to content.
  const dropped = (document as unknown as TextScope).querySelectorAll('script, style');
  for (let i = 0; i < dropped.length; i++) dropped[i]!.parentNode?.removeChild(dropped[i]!);
  const scope = ((document as unknown as { body?: TextScope }).body ?? (document as unknown as TextScope));
  const all = scopeText(scope);
  stripHiddenDom(document as unknown as VisibilityDocument);
  return { all, visible: scopeText(scope) };
}

export function evaluateAssertion(
  a: Assertion,
  markdown: string,
  structured: StructuredData,
  ctx: AssertionContext = {},
): AssertionResult {
  switch (a.kind) {
    case 'contains': {
      const passed = norm(markdown).includes(norm(a.value));
      return { category: a.category, passed, describe: `contains "${a.value}"`, detail: passed ? undefined : 'missing from extracted markdown' };
    }
    case 'absent': {
      const describe = `omits "${a.value}"`;
      // NON-VACUITY, checked before the property itself — the same obligation `visible_only`
      // below already carries, applied to the kind that needs it just as badly.
      //
      // K24: an `absent` claim is satisfied FOR FREE by any document that no longer contains
      // the value in its SOURCE, and the degenerate case of that is total content loss. The
      // measurement: a `strip_body` inversion probe reached 71 of 101 compared assertions, and
      // every one of the 30 survivors was an `absent` satisfied by an emptied document. A
      // corpus drifting toward `absent` assertions therefore gets QUIETER about content loss,
      // not louder. Requiring the value to be present in the source makes the claim scorable
      // only where it means something, and fails it loudly where it does not.
      //
      // The same rule also catches the fixture-typo case — an `absent` value that was never on
      // the page scores a free point for the life of the corpus. One such assertion was found
      // in the shipped C0 manifest when this precondition was added.
      if (ctx.sourceHtml === undefined) {
        return { category: a.category, passed: false, describe, detail: 'not evaluated: absent needs sourceHtml' };
      }
      if (!norm(htmlText(ctx.sourceHtml)).includes(norm(a.value))) {
        return { category: a.category, passed: false, describe, detail: 'VACUOUS: value is not in the source HTML, so this assertion suppresses nothing' };
      }
      const passed = !norm(markdown).includes(norm(a.value));
      return { category: a.category, passed, describe, detail: passed ? undefined : 'boilerplate leaked into extracted markdown' };
    }
    case 'count': {
      const n = countFeature(markdown, a.feature);
      const passed = n >= a.min && n <= a.max;
      return { category: a.category, passed, describe: `${a.feature} count in [${a.min}, ${a.max}]`, detail: `actual ${n}` };
    }
    case 'structured': {
      const n = structuredCount(structured, a.field);
      const passed = n >= a.min;
      return { category: a.category, passed, describe: `structured.${a.field} >= ${a.min}`, detail: `actual ${n}` };
    }
    case 'table_cell': {
      const cells = tableCells(structured).map(norm);
      const want = norm(a.value);
      const passed = cells.some((c) => c.includes(want));
      return { category: a.category, passed, describe: `some table cell contains "${a.value}"`, detail: passed ? undefined : `${cells.length} cells scanned` };
    }
    case 'visible_only': {
      const describe = `invisible "${a.value}" does not survive extraction`;
      // K25: this arm scores OCCURRENCES, not presence.
      //
      // Presence was the wrong proposition. `!markdown.includes(value)` is unsatisfiable the
      // moment the hidden string also appears as VISIBLE content on the same page, because
      // clearing it would mean deleting text a human reads. Measured on the frozen corpus,
      // `wikipedia-python` is exactly that shape: its hidden `div.shortdescription` reads
      // "General-purpose programming language" and so does the visible `<a>` in the lead
      // sentence, word for word, anchor text and title attribute. The hidden div is dropped
      // by every tier — the leak the row claimed does not reproduce — yet the row could never
      // go green. Its three siblings passed not because they suppress better but because
      // their hidden string has no visible twin. That is a property of the ASSERTION, not of
      // the extractor, and scoring counts removes it.
      //
      // The property: the markdown may hold as many copies as the VISIBLE source can account
      // for, and not one more. An extra copy has only one possible supplier — a hidden node.
      if (ctx.sourceHtml === undefined) {
        return { category: a.category, passed: false, describe, detail: 'not evaluated: visible_only needs sourceHtml' };
      }
      const reachable = reachableText(ctx.sourceHtml);
      const inAll = occurrences(reachable.all, a.value);
      const inVisible = occurrences(reachable.visible, a.value);
      // NON-VACUITY, checked before the property itself, and STRICTER than presence-in-source
      // was. The claim is "this text is HIDDEN in the source and must not come out". A value
      // that occurs only as visible text suppresses nothing — the assertion could not fail
      // for the reason it exists — so it fails loudly, exactly as a typo'd value does.
      if (inAll <= inVisible) {
        const why = inAll === 0
          ? 'value is not in the source HTML'
          : `all ${inAll} source occurrence(s) are visible`;
        return { category: a.category, passed: false, describe, detail: `VACUOUS: ${why}, so this assertion suppresses nothing` };
      }
      const inMarkdown = occurrences(markdown, a.value);
      const passed = inMarkdown <= inVisible;
      return {
        category: a.category,
        passed,
        describe,
        detail: passed
          ? undefined
          : `invisible content leaked into extracted markdown: ${inMarkdown} occurrence(s) in markdown vs ${inVisible} visible in source (${inAll} total)`,
      };
    }
    case 'row_columns': {
      const describe = `replay columns == [${a.expect.join(', ')}]`;
      if (!ctx.replay) return { category: a.category, passed: false, describe, detail: 'not evaluated: no replay outcome' };
      // Set equality, not sequence equality. The spec (§3.3, §8-B) says "column SET"; it
      // never states whether column ORDER is part of the recorded identity, so this scores
      // the claim the spec actually makes rather than a stricter one it does not.
      // Flagged in the S12-0 report as an unstated parameter for S12-4 to settle.
      const got = new Set(ctx.replay.columns.map(norm));
      const want = new Set(a.expect.map(norm));
      const passed = got.size === want.size && [...want].every((c) => got.has(c));
      return { category: a.category, passed, describe, detail: passed ? undefined : `actual [${ctx.replay.columns.join(', ')}]` };
    }
    case 'row_count': {
      const describe = `replay row count in [${a.min}, ${a.max}]`;
      if (!ctx.replay) return { category: a.category, passed: false, describe, detail: 'not evaluated: no replay outcome' };
      const n = ctx.replay.rowCount;
      return { category: a.category, passed: n >= a.min && n <= a.max, describe, detail: `actual ${n}` };
    }
    case 'heal_at_least': {
      const describe = `heal verdict >= ${a.tier}`;
      if (!ctx.replay) return { category: a.category, passed: false, describe, detail: 'not evaluated: no replay outcome' };
      const got = ctx.replay.healTier;
      return { category: a.category, passed: HEAL_RANK[got] >= HEAL_RANK[a.tier], describe, detail: `actual ${got}` };
    }
  }
}

export function scoreFixture(assertions: AssertionResult[]): Partial<Record<Category, number>> {
  const acc: Partial<Record<Category, { p: number; t: number }>> = {};
  for (const r of assertions) {
    const slot = acc[r.category] ?? { p: 0, t: 0 };
    slot.t += 1;
    if (r.passed) slot.p += 1;
    acc[r.category] = slot;
  }
  const out: Partial<Record<Category, number>> = {};
  for (const [k, v] of Object.entries(acc)) out[k as Category] = v.t === 0 ? 1 : v.p / v.t;
  return out;
}

const CATEGORIES: Category[] = ['markdown_fidelity', 'table_preservation', 'boilerplate_noise', 'structured_extract'];

export function summarise(fixtures: FixtureResult[], durationMs: number, runDate: string): ScrapeReport {
  const byCategory = Object.fromEntries(
    CATEGORIES.map((c) => [c, { passed: 0, total: 0, score: 0 }]),
  ) as Record<Category, CategorySummary>;
  const byPageClass: Record<string, CategorySummary> = {};

  let passed = 0;
  let total = 0;
  for (const f of fixtures) {
    const cls = byPageClass[f.pageClass] ?? { passed: 0, total: 0, score: 0 };
    for (const a of f.assertions) {
      total += 1;
      byCategory[a.category].total += 1;
      cls.total += 1;
      if (a.passed) {
        passed += 1;
        byCategory[a.category].passed += 1;
        cls.passed += 1;
      }
    }
    cls.score = cls.total === 0 ? 1 : cls.passed / cls.total;
    byPageClass[f.pageClass] = cls;
  }
  for (const c of CATEGORIES) {
    const s = byCategory[c];
    s.score = s.total === 0 ? 1 : s.passed / s.total;
  }

  return {
    runDate,
    durationMs,
    overall: { passed, total, score: total === 0 ? 1 : passed / total },
    byCategory,
    byPageClass,
    fixtures,
  };
}

/** Stable key for one assertion's verdict in the baseline. */
export function assertionKey(fixtureId: string, index: number, describe: string): string {
  return `${fixtureId}#${index}:${describe}`;
}

export interface GateVerdict {
  ok: boolean;
  regressions: string[];
  improvements: string[];
  newAssertions: string[];
  missingAssertions: string[];
}

/**
 * Compare a run against the committed baseline. A REGRESSION is an assertion that
 * passed at baseline and fails now — that is the only thing that fails the gate.
 * Improvements and newly-added assertions are reported, never punished, so that
 * tightening the corpus does not require a baseline dance in the same PR.
 */
export function compareToBaseline(
  report: ScrapeReport,
  baselineAssertions: Record<string, boolean>,
): GateVerdict {
  const now: Record<string, boolean> = {};
  for (const f of report.fixtures) {
    f.assertions.forEach((a, i) => { now[assertionKey(f.id, i, a.describe)] = a.passed; });
  }
  const regressions: string[] = [];
  const improvements: string[] = [];
  const newAssertions: string[] = [];
  const missingAssertions: string[] = [];

  for (const [k, wasPassing] of Object.entries(baselineAssertions)) {
    if (!(k in now)) { missingAssertions.push(k); continue; }
    if (wasPassing && !now[k]) regressions.push(k);
    if (!wasPassing && now[k]) improvements.push(k);
  }
  for (const k of Object.keys(now)) if (!(k in baselineAssertions)) newAssertions.push(k);

  return { ok: regressions.length === 0, regressions, improvements, newAssertions, missingAssertions };
}

export function renderMarkdown(report: ScrapeReport, verdict?: GateVerdict): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push('# Scrape-quality benchmark (C0 referee)', '');
  lines.push(`Run: ${report.runDate} · ${report.durationMs} ms · ${report.fixtures.length} fixtures`, '');
  lines.push(`**Overall: ${report.overall.passed}/${report.overall.total} assertions (${pct(report.overall.score)})**`, '');
  lines.push('| Category | Passed | Total | Score |', '|---|---:|---:|---:|');
  for (const [c, s] of Object.entries(report.byCategory)) {
    lines.push(`| ${c} | ${s.passed} | ${s.total} | ${pct(s.score)} |`);
  }
  lines.push('', '| Page class | Passed | Total | Score |', '|---|---:|---:|---:|');
  for (const [c, s] of Object.entries(report.byPageClass)) {
    lines.push(`| ${c} | ${s.passed} | ${s.total} | ${pct(s.score)} |`);
  }
  lines.push('', '## Failing assertions', '');
  const failing = report.fixtures.flatMap((f) => f.assertions.filter((a) => !a.passed).map((a) => `- \`${f.id}\` [${a.category}] ${a.describe}${a.detail ? ` — ${a.detail}` : ''}`));
  lines.push(failing.length ? failing.join('\n') : '_none_');
  if (verdict) {
    lines.push('', '## Gate', '');
    lines.push(verdict.ok ? '✅ no regressions vs baseline' : `❌ ${verdict.regressions.length} regression(s) vs baseline`);
    for (const r of verdict.regressions) lines.push(`- REGRESSED: ${r}`);
    for (const r of verdict.improvements) lines.push(`- improved: ${r}`);
    for (const r of verdict.newAssertions) lines.push(`- new (not in baseline): ${r}`);
    for (const r of verdict.missingAssertions) lines.push(`- dropped since baseline: ${r}`);
  }
  return `${lines.join('\n')}\n`;
}
