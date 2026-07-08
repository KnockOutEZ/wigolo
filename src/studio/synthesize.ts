/**
 * P6 F3 — cross-tab synthesis adapter. Shapes a session's captured artifacts into the `ResearchSource[]`
 * the brief-shaping stage (`buildResearchBrief`) consumes, and keeps an index-aligned provenance array so a
 * brief's `key_finding_sources` indices resolve back to the originating capture (the `fetchedToFull`
 * one-shared-source-array pattern — see memory feedback_research_finding_source_alignment). This file only
 * SHAPES rows: NO network, NO decomposition→search→fetch. Broker-side (real-Node) — the research + embed
 * code lives there; nothing native is pulled into the Electron main.
 */
import type { ResearchSource, ResearchBrief } from '../types.js';
import type { ArtifactFullRow } from './capture/artifacts.js';

/** Where source[i] came from — resolved from a brief's 0-based source index back to the capturing artifact. */
export interface ProvenanceEntry {
  artifactId: number;
  url: string | null;
  title: string | null;
  ts: string;
}

export interface SourcesWithProvenance {
  sources: ResearchSource[];
  provenance: ProvenanceEntry[];
}

/**
 * The synthesis result the broker returns + the renderer renders. Either an HONEST empty state (a
 * zero-capture session → no fabricated brief) or a real brief plus the index-aligned provenance so each
 * `key_finding_sources[i]` resolves to `provenance[i]` (the capturing artifact).
 */
export type ResearchBriefDto =
  | { empty: true }
  | { brief: ResearchBrief; provenance: ProvenanceEntry[] };

/**
 * Map captured artifacts → research sources, index-aligned with a parallel provenance array (sources[i] ↔
 * provenance[i]). `trusted` is the artifact's content_trusted (page bodies stay untrusted-as-instructions;
 * a human note captured trusted rides through as trusted). A url-less capture (a qa/extraction with no page
 * url) gets a stable studio:// pseudo-url so the brief renderer never sees an empty citation.
 */
export function artifactsToSources(rows: ArtifactFullRow[]): SourcesWithProvenance {
  const sources: ResearchSource[] = [];
  const provenance: ProvenanceEntry[] = [];
  for (const r of rows) {
    sources.push({
      url: r.url ?? `studio://artifact/${r.id}`,
      title: r.title ?? '(untitled capture)',
      markdown_content: r.markdown,
      relevance_score: 1,
      fetched: true,
      trusted: r.contentTrusted === 1,
    });
    provenance.push({ artifactId: r.id, url: r.url, title: r.title, ts: r.createdAt });
  }
  return { sources, provenance };
}
