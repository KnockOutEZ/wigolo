import { createLogger } from '../logger.js';
import {
  type SamplingCapableServer,
  requestSampling,
  checkSamplingSupport,
} from '../search/sampling.js';

const log = createLogger('agent');

const MAX_SEARCH_QUERIES = 5;
const MAX_QUERY_LENGTH = 250;

export interface AgentPlan {
  searches: string[];
  urls: string[];
  notes: string;
  samplingUsed: boolean;
}

export async function planExecution(
  prompt: string,
  urls?: string[],
  server?: SamplingCapableServer,
): Promise<AgentPlan> {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    return {
      searches: [],
      urls: urls ?? [],
      notes: 'Empty prompt provided',
      samplingUsed: false,
    };
  }

  if (server) {
    try {
      const samplingResult = await planWithSampling(trimmedPrompt, server);
      if (samplingResult) {
        const mergedUrls = mergeUrls(samplingResult.urls, urls ?? []);
        return {
          searches: samplingResult.searches,
          urls: mergedUrls,
          notes: samplingResult.notes,
          samplingUsed: true,
        };
      }
    } catch (err) {
      log.warn('sampling planning failed, using fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const fallback = planWithFallback(trimmedPrompt);
  const mergedUrls = mergeUrls(fallback.urls, urls ?? []);

  return {
    searches: fallback.searches,
    urls: mergedUrls,
    notes: fallback.notes,
    samplingUsed: false,
  };
}

async function planWithSampling(
  prompt: string,
  server: SamplingCapableServer,
): Promise<{ searches: string[]; urls: string[]; notes: string } | null> {
  try {
    if (!checkSamplingSupport(server)) {
      log.debug('client does not support sampling for planning');
      return null;
    }

    const samplingPrompt = `You are a data gathering assistant. Given the user's prompt, create an execution plan.

Return a JSON object with:
- "searches": array of 1-5 search engine queries to find the needed data
- "urls": array of specific URLs to visit (if any are obvious from the prompt)
- "notes": brief string with any relevant observations

Prompt: ${prompt}

Respond with ONLY valid JSON: {"searches": [...], "urls": [...], "notes": "..."}`;

    const response = await requestSampling(
      server,
      [{ role: 'user', content: { type: 'text', text: samplingPrompt } }],
      500,
    );

    if (!response?.content?.text) {
      log.debug('sampling returned empty response for planning');
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
          log.debug('could not extract JSON from sampling plan response');
          return null;
        }
      } else {
        return null;
      }
    }

    if (typeof parsed !== 'object' || parsed === null) return null;

    const obj = parsed as Record<string, unknown>;
    const searches = Array.isArray(obj.searches)
      ? obj.searches.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
      : [];
    const extractedUrls = Array.isArray(obj.urls)
      ? obj.urls.filter((u): u is string => typeof u === 'string' && isValidUrl(u))
      : [];
    const notes = typeof obj.notes === 'string' ? obj.notes : '';

    if (searches.length === 0 && extractedUrls.length === 0) {
      log.debug('sampling plan had no searches or URLs');
      return null;
    }

    return { searches: searches.slice(0, MAX_SEARCH_QUERIES), urls: extractedUrls, notes };
  } catch (err) {
    log.debug('sampling planning request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function planWithFallback(prompt: string): { searches: string[]; urls: string[]; notes: string } {
  const extractedUrls = extractUrlsFromText(prompt);
  const searches = generateSearchQueries(prompt);

  return {
    searches,
    urls: extractedUrls,
    notes: 'Fallback plan from keyword extraction',
  };
}

function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s,;"')\]]+/gi;
  const matches = text.match(urlRegex) ?? [];
  const cleaned = matches.map((url) => url.replace(/[.,;:!?)]+$/, ''));
  return [...new Set(cleaned)].filter(isValidUrl);
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function generateSearchQueries(prompt: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'and',
    'but', 'or', 'not', 'so', 'yet', 'find', 'get', 'search', 'look',
    'show', 'me', 'i', 'we', 'you', 'they', 'it', 'this', 'that',
    'my', 'your', 'our', 'their', 'all', 'each', 'every', 'some',
    'any', 'also', 'about', 'up', 'out', 'if', 'then', 'than',
    'too', 'very', 'just', 'please', 'need', 'want',
  ]);

  const urlFree = prompt.replace(/https?:\/\/[^\s]+/g, '').trim();
  if (!urlFree) return [];

  const words = urlFree
    .replace(/[?!.,;:'"()\[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const contentWords = words.filter((w) => !stopWords.has(w.toLowerCase()) && w.length > 1);

  if (contentWords.length === 0) return [];

  const queries: string[] = [];

  const fullQuery = contentWords.join(' ');
  if (fullQuery.length <= MAX_QUERY_LENGTH) {
    queries.push(fullQuery);
  } else {
    queries.push(fullQuery.slice(0, MAX_QUERY_LENGTH));
  }

  if (contentWords.length >= 4) {
    const half = Math.ceil(contentWords.length / 2);
    queries.push(contentWords.slice(0, half).join(' '));
  }

  if (contentWords.length >= 4) {
    const half = Math.ceil(contentWords.length / 2);
    queries.push(contentWords.slice(half).join(' '));
  }

  if (contentWords.length >= 3) {
    const bigrams: string[] = [];
    for (let i = 0; i < contentWords.length - 1 && bigrams.length < 3; i++) {
      bigrams.push(`${contentWords[i]} ${contentWords[i + 1]}`);
    }
    if (bigrams.length > 0) {
      queries.push(bigrams.join(' '));
    }
  }

  const keyTerms = contentWords.filter(
    (w) => w.length > 4 || w[0] === w[0].toUpperCase(),
  );
  if (keyTerms.length >= 2) {
    queries.push(keyTerms.slice(0, 5).join(' '));
  }

  const unique = [...new Set(queries)].map((q) =>
    q.length > MAX_QUERY_LENGTH ? q.slice(0, MAX_QUERY_LENGTH) : q,
  );
  return unique.slice(0, MAX_SEARCH_QUERIES);
}

function mergeUrls(samplingUrls: string[], explicitUrls: string[]): string[] {
  const all = [...samplingUrls, ...explicitUrls];
  return [...new Set(all)];
}
