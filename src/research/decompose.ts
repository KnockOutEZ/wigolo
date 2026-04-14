import { createLogger } from '../logger.js';
import {
  type SamplingCapableServer,
  requestSampling,
  checkSamplingSupport,
} from '../search/sampling.js';

const log = createLogger('research');

const DEPTH_SUB_QUERY_COUNT: Record<string, number> = {
  quick: 2,
  standard: 4,
  comprehensive: 7,
};

export interface DecomposeResult {
  subQueries: string[];
  samplingUsed: boolean;
}

export async function decomposeQuestion(
  question: string,
  depth: 'quick' | 'standard' | 'comprehensive',
  server?: SamplingCapableServer,
): Promise<DecomposeResult> {
  const targetCount = DEPTH_SUB_QUERY_COUNT[depth] ?? 4;

  if (server) {
    try {
      const result = await decomposeWithSampling(question, targetCount, server);
      if (result) {
        return { subQueries: result, samplingUsed: true };
      }
    } catch (err) {
      log.warn('sampling decomposition failed, using fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const fallback = decomposeWithFallback(question, targetCount);
  return { subQueries: fallback, samplingUsed: false };
}

async function decomposeWithSampling(
  question: string,
  targetCount: number,
  server: SamplingCapableServer,
): Promise<string[] | null> {
  try {
    if (!checkSamplingSupport(server)) {
      log.debug('client does not support sampling');
      return null;
    }

    const prompt = `You are a research assistant. Break this question into exactly ${targetCount} distinct search queries that cover different aspects of the topic. Return a JSON object with a "subQueries" array of strings. Each query should be a concise search-engine-ready phrase (not a full sentence). Cover different angles: definitions, comparisons, current state, best practices, etc.

Question: ${question}

Respond with ONLY valid JSON: {"subQueries": ["query1", "query2", ...]}`;

    const response = await requestSampling(
      server,
      [{ role: 'user', content: { type: 'text', text: prompt } }],
      500,
    );

    if (!response?.content?.text) {
      log.debug('sampling returned empty response');
      return null;
    }

    const text = response.content.text.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          log.debug('could not extract JSON from sampling response');
          return null;
        }
      } else {
        return null;
      }
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).subQueries)
    ) {
      log.debug('sampling response missing subQueries array');
      return null;
    }

    const subQueries = (parsed as { subQueries: unknown[] }).subQueries
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .map((q) => q.trim());

    if (subQueries.length < targetCount) {
      log.debug('sampling returned fewer sub-queries than requested', {
        expected: targetCount,
        got: subQueries.length,
      });
      return null;
    }

    return subQueries.slice(0, targetCount);
  } catch (err) {
    log.debug('sampling request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function decomposeWithFallback(question: string, targetCount: number): string[] {
  const cleaned = question.trim();
  if (!cleaned) {
    return generateGenericQueries(targetCount);
  }

  const nounPhrases = extractNounPhrases(cleaned);
  const clauseParts = splitAtClauseBoundaries(cleaned);
  const candidates: string[] = [];

  candidates.push(cleaned.length <= 200 ? cleaned : cleaned.slice(0, 200));

  for (const clause of clauseParts) {
    const trimmed = clause.trim();
    if (trimmed.length > 3 && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  }

  for (const np of nounPhrases) {
    if (np.length > 3 && !candidates.includes(np)) {
      candidates.push(np);
    }
  }

  const keywordVariants = generateKeywordVariants(cleaned);
  for (const variant of keywordVariants) {
    if (!candidates.includes(variant)) {
      candidates.push(variant);
    }
  }

  while (candidates.length < targetCount) {
    const idx = candidates.length;
    candidates.push(`${cleaned} aspect ${idx + 1}`);
  }

  const unique = [...new Set(candidates)];
  return unique.slice(0, targetCount);
}

function splitAtClauseBoundaries(text: string): string[] {
  const separators = ['. ', '? ', '! ', '; ', ', and ', ', or ', ' -- ', ' - ', ', considering ', ', including '];
  let parts = [text];

  for (const sep of separators) {
    if (parts.length >= 10) break;
    parts = parts.flatMap((p) => {
      const split = p.split(sep).map((s) => s.trim()).filter(Boolean);
      return split.length > 1 ? split : [p];
    });
  }

  return parts;
}

function extractNounPhrases(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
    'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or',
    'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
    'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
    'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
    'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whom',
    'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
    'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its',
    'they', 'them', 'their',
  ]);

  const words = text.replace(/[?!.,;:'"()\[\]{}]/g, ' ').split(/\s+/).filter(Boolean);
  const contentWords = words.filter((w) => !stopWords.has(w.toLowerCase()));
  const phrases: string[] = [];

  for (let i = 0; i < contentWords.length; i++) {
    for (let len = 2; len <= Math.min(4, contentWords.length - i); len++) {
      const phrase = contentWords.slice(i, i + len).join(' ');
      if (phrase.length > 5) {
        phrases.push(phrase);
      }
    }
  }

  return [...new Set(phrases)];
}

function generateKeywordVariants(question: string): string[] {
  const variants: string[] = [];
  const cleaned = question.replace(/[?!.]/g, '').trim();
  const words = cleaned.split(/\s+/).filter((w) => w.length > 2);

  if (words.length >= 3) {
    variants.push(words.slice(0, Math.ceil(words.length / 2)).join(' '));
    variants.push(words.slice(Math.floor(words.length / 2)).join(' '));
  }

  const questionPatterns = [
    /^what\s+(are|is)\s+/i,
    /^how\s+(do|does|to|can)\s+/i,
    /^why\s+(do|does|is|are)\s+/i,
    /^when\s+(do|does|should)\s+/i,
    /^compare\s+/i,
    /^explain\s+/i,
  ];
  for (const pat of questionPatterns) {
    const stripped = cleaned.replace(pat, '').trim();
    if (stripped !== cleaned && stripped.length > 5) {
      variants.push(stripped);
      break;
    }
  }

  return variants;
}

function generateGenericQueries(count: number): string[] {
  const queries: string[] = [];
  for (let i = 0; i < count; i++) {
    queries.push(`topic ${i + 1}`);
  }
  return queries;
}
