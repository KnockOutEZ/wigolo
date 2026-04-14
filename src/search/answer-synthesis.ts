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
