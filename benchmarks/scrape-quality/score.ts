import type { StructuredData } from '../../src/types.js';
import type { Assertion, AssertionResult, Category, FixtureResult, MarkdownFeature, ScrapeReport, CategorySummary } from './types.js';

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

export function evaluateAssertion(
  a: Assertion,
  markdown: string,
  structured: StructuredData,
): AssertionResult {
  switch (a.kind) {
    case 'contains': {
      const passed = norm(markdown).includes(norm(a.value));
      return { category: a.category, passed, describe: `contains "${a.value}"`, detail: passed ? undefined : 'missing from extracted markdown' };
    }
    case 'absent': {
      const passed = !norm(markdown).includes(norm(a.value));
      return { category: a.category, passed, describe: `omits "${a.value}"`, detail: passed ? undefined : 'boilerplate leaked into extracted markdown' };
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
