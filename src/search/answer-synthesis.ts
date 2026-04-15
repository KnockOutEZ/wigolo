import type { SearchResultItem, Citation } from '../types.js';
import type { SamplingCapableServer } from './sampling.js';
import {
  checkSamplingSupport,
  requestSampling,
  extractTextFromSamplingResponse,
} from './sampling.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

const MAX_CHARS_PER_SOURCE = 3000;
const MAX_RESPONSE_TOKENS = 1500;
const FALLBACK_MAX_BULLETS = 5;
const FALLBACK_KEYPOINT_MAX_CHARS = 240;

export interface SynthesisResult {
  answer?: string;
  citations?: Citation[];
  fallback: boolean;
  warning?: string;
}

export async function synthesizeAnswer(
  results: SearchResultItem[],
  query: string,
  server: SamplingCapableServer,
): Promise<SynthesisResult> {
  try {
    const sourcesText = buildSourcesText(results);
    if (!sourcesText) {
      log.info('no content available for synthesis');
      return {
        fallback: true,
        warning: 'No results with content available for answer synthesis',
      };
    }

    if (!checkSamplingSupport(server)) {
      log.info('sampling not supported by client, falling back to context format');
      return {
        fallback: true,
        warning: 'Client does not support MCP sampling; falling back to context format',
      };
    }

    const prompt = buildSynthesisPrompt(query, sourcesText);

    const response = await requestSampling(
      server,
      [{ role: 'user', content: { type: 'text', text: prompt } }],
      MAX_RESPONSE_TOKENS,
    );

    const answerText = extractTextFromSamplingResponse(response);

    if (!answerText) {
      log.warn('sampling returned empty response');
      return {
        fallback: true,
        warning: 'Sampling returned empty response; falling back to context format',
      };
    }

    const citations = extractCitations(answerText, results);

    log.info('answer synthesis complete', {
      answerLength: answerText.length,
      citationCount: citations.length,
    });

    return {
      answer: answerText,
      citations,
      fallback: false,
    };
  } catch (err) {
    log.error('answer synthesis failed', { error: String(err) });
    return {
      fallback: true,
      warning: `Answer synthesis failed: ${err instanceof Error ? err.message : String(err)}; falling back to context format`,
    };
  }
}

export function buildSourcesText(results: SearchResultItem[]): string {
  try {
    const blocks: string[] = [];
    let sourceIndex = 1;

    for (const result of results) {
      const content = result.markdown_content || result.snippet || '';
      if (!content.trim()) continue;

      const truncated = content.length > MAX_CHARS_PER_SOURCE
        ? content.slice(0, MAX_CHARS_PER_SOURCE)
        : content;

      blocks.push(`[${sourceIndex}] ${result.title} (${result.url})\n${truncated}`);
      sourceIndex++;
    }

    if (blocks.length === 0) return '';

    return blocks.join('\n\n---\n\n');
  } catch (err) {
    log.error('buildSourcesText failed', { error: String(err) });
    return '';
  }
}

export function buildSynthesisPrompt(query: string, sourcesText: string): string {
  return `Based on the following sources, provide a concise and direct answer to the question. Use numbered citations like [1], [2] to reference specific sources.

Question: ${query}

Sources:
${sourcesText}

Instructions:
- Be concise and direct. Answer in 2-4 paragraphs maximum.
- Cite sources using [1], [2], etc. matching the source numbers above.
- If sources contain conflicting information, note the discrepancy.
- If the sources don't adequately answer the question, say so.
- Do not include information not found in the provided sources.`;
}

export interface StructuredFallbackResult {
  answer: string;
  citations: Citation[];
  warning: string;
}

// Heuristic answer without LLM sampling: top-N sources as bulleted key points
// with numeric citations. Used when client lacks sampling capability.
export function buildStructuredFallback(
  results: SearchResultItem[],
  query: string,
): StructuredFallbackResult {
  const bullets: string[] = [];
  const citations: Citation[] = [];
  let n = 0;

  for (const r of results) {
    if (n >= FALLBACK_MAX_BULLETS) break;
    const body = (r.markdown_content && r.markdown_content.trim()) || (r.snippet && r.snippet.trim()) || '';
    if (!body) continue;

    const keypoint = extractKeypoint(body, FALLBACK_KEYPOINT_MAX_CHARS);
    if (!keypoint) continue;

    n += 1;
    bullets.push(`- **${r.title}** — ${keypoint} [${n}]`);
    citations.push({ index: n, url: r.url, title: r.title, snippet: r.snippet });
  }

  if (bullets.length === 0) {
    return { answer: '', citations: [], warning: 'No sampling server available; no content to summarize' };
  }

  const q = query && query.trim() ? query.trim() : 'this query';
  const answer = `Based on the top ${bullets.length} sources for "${q}":\n\n${bullets.join('\n')}\n\nSources:\n${citations.map(c => `[${c.index}] ${c.title} — ${c.url}`).join('\n')}`;

  return {
    answer,
    citations,
    warning: 'Client does not support MCP sampling; returning heuristic key-point summary instead of synthesized answer',
  };
}

function extractKeypoint(body: string, maxChars: number): string {
  const trimmed = body.trim();
  if (!trimmed) return '';

  // First paragraph before a blank line
  const firstPara = trimmed.split(/\n\s*\n/)[0].trim();
  if (!firstPara) return '';

  // Strip markdown headings at the start
  const stripped = firstPara.replace(/^#+\s*/, '').trim();
  if (!stripped) return '';

  if (stripped.length <= maxChars) return stripped;

  // Try to cut at sentence end within budget
  const window = stripped.slice(0, maxChars);
  const lastStop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (lastStop > maxChars * 0.6) {
    return window.slice(0, lastStop + 1);
  }
  return window + '…';
}

export function extractCitations(
  answer: string,
  results: SearchResultItem[],
): Citation[] {
  try {
    if (!answer || results.length === 0) return [];

    const citationRegex = /\[(\d+)\]/g;
    const seen = new Set<number>();
    const citations: Citation[] = [];

    let match: RegExpExecArray | null;
    while ((match = citationRegex.exec(answer)) !== null) {
      const index = parseInt(match[1], 10);
      if (isNaN(index) || index < 1 || index > results.length) continue;
      if (seen.has(index)) continue;
      seen.add(index);

      const result = results[index - 1];
      citations.push({
        index,
        url: result.url,
        title: result.title,
        snippet: result.snippet,
      });
    }

    return citations;
  } catch (err) {
    log.error('citation extraction failed', { error: String(err) });
    return [];
  }
}
