import { createHash } from 'node:crypto';
import type { EvidenceItem, SourceSpan } from '../types.js';

export function stableCitationId(url: string, start: number): string {
  return createHash('sha1').update(`${url}#${start}`).digest('hex').slice(0, 12);
}

export function buildEvidenceItem(input: {
  title: string;
  url: string;
  sectionHeading: string | null;
  excerpt: string;
  score: number;
  sourceSpan: SourceSpan;
}): EvidenceItem {
  return {
    title: input.title,
    url: input.url,
    section_heading: input.sectionHeading,
    excerpt: input.excerpt,
    score: input.score,
    citation_id: stableCitationId(input.url, input.sourceSpan.start),
    source_span: input.sourceSpan,
  };
}
