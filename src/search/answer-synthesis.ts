import type { SearchResultItem, Citation, StageResult } from '../types.js';
import type { SamplingCapableServer } from './sampling.js';
import {
  checkSamplingSupport,
  requestSampling,
  extractTextFromSamplingResponse,
} from './sampling.js';
import { isLlmConfigured, runLlmText } from '../integrations/cloud/llm/run.js';
import { selectProvider } from '../integrations/cloud/llm/select.js';
import { resolveModel } from '../integrations/cloud/llm/model-select.js';
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

export interface SynthesisInput {
  query: string;
  results: SearchResultItem[];
  samplingServer?: SamplingCapableServer;
  /** Reserved for future per-source truncation; T6 currently relies on MAX_CHARS_PER_SOURCE. */
  maxTotalChars: number;
}

export type SynthesisStatus = 'quota_exceeded';

export interface SynthesizedAnswer {
  answer: string;
  citations: Citation[];
  warning?: string;
  fallback_level: 1 | 2 | 3;
  synthesis_status?: SynthesisStatus;
  synthesis_provider?: string;
  synthesis_model?: string;
  synthesis_advice?: string;
}

const QUOTA_PATTERN = /quota.*exceed|exceed.*quota|RESOURCE_EXHAUSTED|free_tier|free.?tier.*(quota|limit|requests)/i;

function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as { status?: unknown }).status;
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 429 && /quota|RESOURCE_EXHAUSTED|free.?tier/i.test(msg)) return true;
  return QUOTA_PATTERN.test(msg);
}

function buildQuotaDetails(
  reason: string,
): { provider: string; model: string; advice: string } | null {
  const provider = selectProvider(process.env);
  if (!provider) return null;
  const model = resolveModel(provider);
  const isProGemini = provider === 'gemini' && /pro/i.test(model);
  const advice = isProGemini
    ? `Switch WIGOLO_LLM_MODEL_GEMINI to gemini-2.5-flash or gemini-2.5-flash-lite; gemini-2.5-pro has a 0/day free-tier quota.`
    : `Reduce request volume or switch provider (WIGOLO_LLM_PROVIDER=anthropic/openai/groq).`;
  log.warn('synthesis quota exceeded', { provider, model, reason, advice });
  return { provider, model, advice };
}

export async function runSynthesis(
  input: SynthesisInput,
): Promise<StageResult<SynthesizedAnswer>> {
  const { query, results, samplingServer } = input;

  if (!results || results.length === 0) {
    return {
      ok: false,
      error: 'no_content',
      error_reason: 'No sources returned content for this query',
      stage: 'synthesize',
      hint: 'Broaden the query, increase max_results, or remove restrictive filters',
    };
  }

  // Level 1a: configured WIGOLO_LLM_PROVIDER (Gemini/OpenAI/Anthropic/...).
  // Checked BEFORE MCP sampling so search/format=answer matches the explicit
  // contract that research + agent already use (they call runLlmText directly).
  // When the operator wires WIGOLO_LLM_PROVIDER, that's the synthesis backend
  // for every tool — host-provided sampling is a fallback, not an override.
  const llmConfigured = isLlmConfigured();
  let llmFailureReason: string | undefined;
  let quotaDetails: { provider: string; model: string; advice: string } | undefined;
  if (llmConfigured) {
    try {
      const sourcesText = buildSourcesText(results);
      if (sourcesText) {
        const prompt = buildSynthesisPrompt(query, sourcesText);
        const r = await runLlmText({ prompt, maxTokens: MAX_RESPONSE_TOKENS });
        const text = (r.text ?? '').trim();
        if (text) {
          const citations = extractCitations(text, results);
          return {
            ok: true,
            data: {
              answer: text,
              citations,
              fallback_level: 1,
            },
          };
        }
        llmFailureReason = 'LLM returned empty text';
      } else {
        llmFailureReason = 'no source content for synthesis prompt';
      }
    } catch (err) {
      llmFailureReason = err instanceof Error ? err.message : String(err);
      log.warn('synthesis level-1a LLM provider failed, falling through to sampling', { error: llmFailureReason });
      if (isQuotaError(err)) {
        const d = buildQuotaDetails(llmFailureReason);
        if (d) quotaDetails = d;
      }
    }
  }

  // Level 1b: MCP sampling (host-provided). Reached only if WIGOLO_LLM_PROVIDER
  // is unset or its call failed — otherwise the operator's explicit choice wins.
  if (samplingServer) {
    try {
      const r = await synthesizeAnswer(results, query, samplingServer);
      if (r.answer && !r.fallback) {
        return {
          ok: true,
          data: {
            answer: r.answer,
            citations: r.citations ?? [],
            warning: r.warning,
            fallback_level: 1,
          },
        };
      }
    } catch (err) {
      log.warn('synthesis level-1b sampling failed, falling through to heuristic', { error: String(err) });
    }
  }

  const fb = buildStructuredFallback(results, query);
  if (fb.answer && fb.answer.length > 0) {
    const quotaNote = quotaDetails
      ? ` | quota exceeded for ${quotaDetails.provider}:${quotaDetails.model} — ${quotaDetails.advice}`
      : '';
    const diag = llmConfigured
      ? `WIGOLO_LLM_PROVIDER configured but call failed (${llmFailureReason ?? 'unknown'})`
      : 'WIGOLO_LLM_PROVIDER not set and no provider API key detected (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / GROQ_API_KEY)';
    return {
      ok: true,
      data: {
        answer: fb.answer,
        citations: fb.citations,
        warning: `${fb.warning} | ${diag}${quotaNote}`,
        fallback_level: 2,
        ...(quotaDetails
          ? {
              synthesis_status: 'quota_exceeded' as const,
              synthesis_provider: quotaDetails.provider,
              synthesis_model: quotaDetails.model,
              synthesis_advice: quotaDetails.advice,
            }
          : {}),
      },
    };
  }

  const top = results.slice(0, 5);
  const citations: Citation[] = top.map((r, i) => ({
    index: i + 1, url: r.url, title: r.title, snippet: r.snippet,
  }));
  if (citations.length > 0) {
    const lines = citations.map(c => `[${c.index}] ${c.title} — ${c.url}\n${c.snippet ?? ''}`);
    return {
      ok: true,
      data: {
        answer: `Evidence for "${query}" (no synthesis available — content too sparse to summarize):\n\n${lines.join('\n\n')}`,
        citations,
        warning: 'sparse_content: returned raw evidence dump instead of synthesized answer',
        fallback_level: 3,
      },
    };
  }

  return {
    ok: false,
    error: 'no_content',
    error_reason: 'Sources returned but contained no usable text',
    stage: 'synthesize',
  };
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
