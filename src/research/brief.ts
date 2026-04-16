import type { ResearchBrief, ResearchSource, SearchResultItem } from '../types.js';
import { extractHighlights } from '../search/highlights.js';

const MAX_HIGHLIGHTS = 12;
const MAX_KEY_FINDING_LEN = 280;
const MAX_TOPICS = 8;

// Build a host-LLM-friendly structured brief when internal sampling is
// unavailable. The host model (Claude Code / Cursor / etc.) consumes this
// shape to produce the final report without needing to re-read raw sources.
export async function buildResearchBrief(
  question: string,
  sources: ResearchSource[],
  subQueries: string[],
  perSourceCharCap: number,
  totalSourcesCharCap: number,
): Promise<ResearchBrief> {
  const fetched = sources.filter((s) => s.fetched && s.markdown_content.length > 0);

  // Highlights reuse the FlashRank-or-paragraph scorer so briefs align with
  // whatever format='highlights' produces for single-query searches.
  const searchItems: SearchResultItem[] = fetched.map((s) => ({
    title: s.title,
    url: s.url,
    snippet: s.markdown_content.slice(0, 200),
    markdown_content: s.markdown_content,
    relevance_score: s.relevance_score,
  }));

  const { highlights } = await extractHighlights(question, searchItems, MAX_HIGHLIGHTS);

  const topics = buildTopics(subQueries, fetched);
  const keyFindings = buildKeyFindings(fetched);

  return {
    topics,
    highlights,
    key_findings: keyFindings,
    per_source_char_cap: perSourceCharCap,
    total_sources_char_cap: totalSourcesCharCap,
  };
}

// Prefer sub-queries (planner's view of the topic space) when available;
// otherwise derive compact topic labels from source titles.
function buildTopics(subQueries: string[], sources: ResearchSource[]): string[] {
  if (subQueries.length > 0) {
    return dedupe(subQueries).slice(0, MAX_TOPICS);
  }
  const labels = sources
    .map((s) => s.title.split(/[–|:·-]/)[0].trim())
    .filter((t) => t.length >= 5 && t.length <= 100);
  return dedupe(labels).slice(0, MAX_TOPICS);
}

// First substantive paragraph per source, trimmed to a finding-sized blurb.
// Ordered by source relevance so the most-weighted finding is first.
function buildKeyFindings(sources: ResearchSource[]): string[] {
  const out: string[] = [];
  for (const s of [...sources].sort((a, b) => b.relevance_score - a.relevance_score)) {
    const first = firstSubstantiveParagraph(s.markdown_content);
    if (!first) continue;
    const trimmed = first.length > MAX_KEY_FINDING_LEN
      ? first.slice(0, MAX_KEY_FINDING_LEN - 1).trimEnd() + '…'
      : first;
    out.push(trimmed);
  }
  return dedupe(out);
}

function firstSubstantiveParagraph(markdown: string): string | null {
  const paragraphs = markdown.split(/\n\n+/).map((p) => p.trim());
  for (const p of paragraphs) {
    if (p.length < 80) continue;
    if (p.startsWith('#') || p.startsWith('|') || p.startsWith('```')) continue;
    return p.replace(/\s+/g, ' ');
  }
  return null;
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
