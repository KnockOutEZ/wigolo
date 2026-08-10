import { createLogger } from '../logger.js';
import {
  type SamplingCapableServer,
  requestSampling,
  checkSamplingSupport,
} from '../search/sampling.js';
import type { ResearchSource, Citation } from '../types.js';
// Only the PROMPT path wraps here now; the response path emits plain text and is fenced at the
// response seam (B1). No overhead reservation is needed for a wrap this file no longer performs.
import { wrapUntrusted } from '../security/untrusted.js';
import { stripResearchChrome } from './brief.js';

const log = createLogger('research');

const DEPTH_TOKEN_LIMITS: Record<string, { reportChars: number; perSourceChars: number; totalSourceChars: number }> = {
  quick: { reportChars: 2000, perSourceChars: 3000, totalSourceChars: 20000 },
  standard: { reportChars: 4000, perSourceChars: 3000, totalSourceChars: 30000 },
  comprehensive: { reportChars: 6000, perSourceChars: 3000, totalSourceChars: 40000 },
};

export interface SynthesisResult {
  report: string;
  citations: Citation[];
  samplingUsed: boolean;
}

export async function synthesizeReport(
  question: string,
  sources: ResearchSource[],
  depth: 'quick' | 'standard' | 'comprehensive',
  server?: SamplingCapableServer,
): Promise<SynthesisResult> {
  const limits = DEPTH_TOKEN_LIMITS[depth] ?? DEPTH_TOKEN_LIMITS.standard;
  const fetchedSources = sources.filter((s) => s.fetched && s.markdown_content.length > 0);

  if (fetchedSources.length === 0) {
    return {
      report: `## Research: ${question}\n\nNo sources could be fetched for this query.`,
      citations: [],
      samplingUsed: false,
    };
  }

  const citations: Citation[] = fetchedSources.map((s, i) => ({
    index: i + 1,
    url: s.url,
    title: s.title,
    // RAW page-derived preview. Containment for research citations lives at the ONE response-shaping
    // seam (fenceResearchData, in the server dispatch layer), not here. Naming that module in full
    // would trip PIN-A4, the architectural pin that keeps this file free of the dispatch fence.
    //
    // F1: it used to be fenced here, and the seam skipped research snippets on the strength of that.
    // But this is only ONE of two producers — the local-LLM path rebuilds finalCitations from
    // scratch (research/pipeline.ts) with an unfenced snippet, so the seam's skip made that path
    // fail OPEN: a raw hostile snippet shipped next to a fenced sibling `title` on the same object.
    // Fencing at the seam makes it one invariant at one choke point that every producer passes,
    // instead of an assumption each new producer has to remember to honour.
    snippet: stripResearchChrome(s.markdown_content).slice(0, 200),
    trusted: s.trusted, // mirror the source's trust (C4)
  }));

  if (server) {
    try {
      const result = await synthesizeWithSampling(question, fetchedSources, citations, limits, server);
      if (result) {
        return { report: result, citations, samplingUsed: true };
      }
    } catch (err) {
      log.warn('sampling synthesis failed, using fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const report = buildFallbackReport(question, fetchedSources, limits.reportChars);
  return { report, citations, samplingUsed: false };
}

async function synthesizeWithSampling(
  question: string,
  sources: ResearchSource[],
  _citations: Citation[],
  limits: { reportChars: number; perSourceChars: number; totalSourceChars: number },
  server: SamplingCapableServer,
): Promise<string | null> {
  try {
    if (!checkSamplingSupport(server)) {
      log.debug('client does not support sampling for synthesis');
      return null;
    }

    let totalChars = 0;
    const sourceBlocks: string[] = [];

    for (let i = 0; i < sources.length; i++) {
      if (totalChars >= limits.totalSourceChars) break;

      const source = sources[i];
      const content = source.markdown_content.slice(0, limits.perSourceChars);
      // P6-a: the page body is embedded INSIDE the untrusted-data fence so an injected
      // directive in the source cannot be read by the synthesis model as an instruction.
      const block = `[${i + 1}] ${source.title} (${source.url})\n${wrapUntrusted(content, { origin: source.url })}`;

      totalChars += block.length;
      sourceBlocks.push(block);
    }

    const prompt = `You are a research assistant. Synthesize a comprehensive report answering the following question based on the provided sources. Use [N] citation markers to reference sources.

Question: ${question}

Sources:
${sourceBlocks.join('\n\n')}

Write a well-structured markdown report of approximately ${limits.reportChars} characters. Include:
1. A clear answer to the question
2. Key findings from the sources
3. Citation markers [1], [2], etc. referencing the source numbers above
4. A brief conclusion

Report:`;

    const maxTokens = Math.ceil(limits.reportChars / 3);

    const response = await requestSampling(
      server,
      [{ role: 'user', content: { type: 'text', text: prompt } }],
      maxTokens,
    );

    if (!response?.content?.text || response.content.text.trim().length === 0) {
      log.debug('sampling synthesis returned empty response');
      return null;
    }

    return response.content.text.trim();
  } catch (err) {
    log.debug('sampling synthesis request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function buildFallbackReport(
  question: string,
  sources: ResearchSource[],
  maxLength: number,
): string {
  const fetchedSources = sources.filter((s) => s.markdown_content.length > 0);

  if (fetchedSources.length === 0) {
    return `## Research: ${question}\n\nNo sources available.`;
  }

  const header = `## Research: ${question}\n\nBased on ${fetchedSources.length} source(s):\n\n`;
  let report = header;
  let remaining = maxLength - header.length;

  for (let i = 0; i < fetchedSources.length; i++) {
    if (remaining <= 0) break;

    const source = fetchedSources[i];
    const sourceHeader = `### [${i + 1}] ${source.title}\n**URL:** ${source.url}\n\n`;

    if (remaining < sourceHeader.length + 20) break;

    report += sourceHeader;
    remaining -= sourceHeader.length;

    // B1: this used to fence each source body. It no longer does, and that is the point.
    //
    // `report` is RESPONSE-bound, so the response seam has to decide whether to fence it. While ANY
    // producer could emit a fence, that decision had to be made by INSPECTING THE VALUE — and the
    // value is page text, so a page that merely printed the opening-marker prefix switched the fence
    // off for the whole report. Hardening the predicate does not rescue it: with a byte-exact payload
    // a page can reproduce a complete, nonce-matched region verbatim, so EVERY content-derived
    // predicate is forgeable. The fix is to delete the decision rather than strengthen it — with zero
    // fence-bearing producers the seam fences unconditionally and there is no input left to attack.
    //
    // The PROMPT-bound fences (synthesizeWithSampling's per-source blocks) are untouched: different
    // sink, and nothing there flows into the response.
    const contentBudget = Math.min(remaining - 10, source.markdown_content.length);
    if (contentBudget > 0) {
      let content = source.markdown_content.slice(0, contentBudget);
      if (content.length < source.markdown_content.length) {
        content = content.slice(0, Math.max(contentBudget - 3, 0)) + '...';
      }
      report += content + '\n\n';
      remaining -= content.length + 2;
    }
  }

  if (report.length > maxLength) {
    report = report.slice(0, maxLength - 3) + '...';
  }

  return report.trimEnd();
}
