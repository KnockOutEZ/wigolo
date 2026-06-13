import type { ResearchBrief, ResearchSource, CrossReference } from '../types.js';

const MAX_SUMMARY_BULLETS = 4;
const MAX_VERDICT_TRADEOFFS = 5;
const MAX_KEY_FINDINGS = 8;
const MAX_OPEN_QUESTIONS = 8;

// Neutralize source-derived text before it is interpolated into our markdown.
// A malicious source could otherwise inject a fake `### Verdict` heading or a
// forged `[9]` citation that misleads the consuming agent about provenance.
// We strip leading markdown control chars (so quoted text can't open a heading
// / blockquote / list) and defuse citation-shaped `[n]` tokens inside the
// quote (so the only surviving `[n]` markers are the ones WE append, which
// actually index into `sources`). This is provenance hygiene, not content
// rewriting — the prose itself is preserved.
function sanitizeSourceText(text: string): string {
  return text
    // Per-line: drop leading markdown structural markers (#, >, -, *, +, =,
    // and numbered-list `1.`) plus surrounding whitespace, so a quoted line
    // can't masquerade as one of our headings or a list item.
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}\s*|>+\s*|[-*+=]\s+|\d+\.\s+)/, '').trimStart())
    .join(' ')
    // Defuse citation-shaped tokens so a forged `[9]` can't pose as one of our
    // real source citations. Replaced with parens, preserving readability.
    .replace(/\[(\d+)\]/g, '($1)')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Weave the already-computed structured brief into a readable, organized
// markdown report for KEYLESS template mode — no LLM required. This is the
// parity lever vs an LLM essay: instead of the flat per-source dump
// (buildFallbackReport), the reader gets a titled brief with a source-quoted
// verdict, key findings, corroborated claims, an optional comparison, open
// questions, and a sources list. Citations `[n]` are 1-based indices into the
// `sources` array, matching how the brief's source_indices reference sources.
export function renderBriefReport(
  question: string,
  brief: ResearchBrief,
  sources: ResearchSource[],
): string {
  const parts: string[] = [];
  parts.push(`## ${question.trim()} — Research Brief`);

  parts.push(renderVerdictOrSummary(brief));

  const keyFindings = renderKeyFindings(brief);
  if (keyFindings) parts.push(keyFindings);

  const agreement = renderAgreement(brief.sections.overview.cross_references, sources.length);
  if (agreement) parts.push(agreement);

  // The Comparison section is only meaningful for comparison queries — showing
  // it elsewhere would be noise.
  if (brief.query_type === 'comparison') {
    const comparison = renderComparison(brief, sources.length);
    if (comparison) parts.push(comparison);
  }

  const openQuestions = renderOpenQuestions(brief.sections.gaps);
  if (openQuestions) parts.push(openQuestions);

  const sourcesSection = renderSources(sources);
  if (sourcesSection) parts.push(sourcesSection);

  return parts.join('\n\n');
}

// A source-quoted verdict is the honest parity lever: each tradeoff is a real
// sentence from a source, cited `[n]`. With no quotable tradeoff we must NOT
// invent directionality — fall back to a clearly-labeled heuristic Summary
// drawn from top key_findings.
function renderVerdictOrSummary(brief: ResearchBrief): string {
  const tradeoffs = brief.sections.comparison?.tradeoffs ?? [];
  if (tradeoffs.length > 0) {
    const lines = tradeoffs.slice(0, MAX_VERDICT_TRADEOFFS).map((t) => {
      const citation = ` [${t.source_index + 1}]`;
      return `- ${sanitizeSourceText(t.text)}${citation}`;
    });
    return `**Verdict (from sources):** the tradeoffs reported across sources:\n${lines.join('\n')}`;
  }

  const bullets = brief.key_findings.slice(0, MAX_SUMMARY_BULLETS).map((f) => `- ${sanitizeSourceText(f)}`);
  if (bullets.length === 0) {
    return '**Summary (heuristic):** no substantive findings could be extracted from the sources.';
  }
  return `**Summary (heuristic):** synthesized from the top findings below.\n${bullets.join('\n')}`;
}

function renderKeyFindings(brief: ResearchBrief): string | null {
  if (brief.key_findings.length === 0) return null;
  const lines = brief.key_findings.slice(0, MAX_KEY_FINDINGS).map((f) => `- ${sanitizeSourceText(f)}`);
  return `### Key Findings\n${lines.join('\n')}`;
}

function renderAgreement(crossRefs: CrossReference[], sourceCount: number): string | null {
  if (crossRefs.length === 0) return null;
  const lines = crossRefs.map((ref) => {
    const cites = ref.source_indices
      .filter((i) => i >= 0 && i < sourceCount)
      .map((i) => `[${i + 1}]`)
      .join(' ');
    return `- ${sanitizeSourceText(ref.finding)}${cites ? ` ${cites}` : ''} _(${ref.confidence} confidence)_`;
  });
  return `### Where Sources Agree\n${lines.join('\n')}`;
}

function renderComparison(brief: ResearchBrief, sourceCount: number): string | null {
  const comparison = brief.sections.comparison;
  if (!comparison) return null;

  const lines: string[] = [];
  if (comparison.entities.length > 0) {
    lines.push(`**Comparing:** ${comparison.entities.map(sanitizeSourceText).join(' vs ')}`);
  }
  for (const t of comparison.tradeoffs) {
    const cite = t.source_index >= 0 && t.source_index < sourceCount ? ` [${t.source_index + 1}]` : '';
    lines.push(`- ${sanitizeSourceText(t.text)}${cite}`);
  }
  if (lines.length === 0) return null;
  return `### Comparison\n${lines.join('\n')}`;
}

function renderOpenQuestions(
  gaps: Array<string | { entity: string; reason: string }>,
): string | null {
  if (gaps.length === 0) return null;
  const lines = gaps.slice(0, MAX_OPEN_QUESTIONS).map((g) => {
    if (typeof g === 'string') return `- ${g}`;
    return `- ${g.entity} — ${g.reason}`;
  });
  return `### Open Questions\n${lines.join('\n')}`;
}

function renderSources(sources: ResearchSource[]): string | null {
  if (sources.length === 0) return null;
  const lines = sources.map((s, i) => `${i + 1}. ${sanitizeSourceText(s.title)} — ${s.url}`);
  return `### Sources\n${lines.join('\n')}`;
}
