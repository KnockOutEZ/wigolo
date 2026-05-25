import type {
  DiffOutput,
  DiffOutputShape,
  DiffGranularity,
  StageResult,
} from '../types.js';
import { computeDiffEnvelope } from '../cache/diff-engine.js';
import { getCachedContent, isExpired } from '../cache/store.js';
import { createLogger } from '../logger.js';

const log = createLogger('cache');

const VALID_OUTPUT: DiffOutputShape[] = ['unified', 'hunks', 'summary'];
const VALID_GRANULARITY: DiffGranularity[] = ['line', 'word', 'section'];

export interface DiffInput {
  old?: { url?: string; markdown?: string; content_hash?: string };
  new?: { url?: string; markdown?: string };
  output?: DiffOutputShape;
  granularity?: DiffGranularity;
}

function resolveSide(
  side: { url?: string; markdown?: string } | undefined,
  label: 'old' | 'new',
): { ok: true; markdown: string } | { ok: false; error: string; error_reason: string } {
  if (!side || (side.markdown === undefined && side.url === undefined)) {
    return {
      ok: false,
      error: 'invalid_input',
      error_reason: `${label}.markdown or ${label}.url is required`,
    };
  }
  if (typeof side.markdown === 'string') {
    return { ok: true, markdown: side.markdown };
  }
  if (typeof side.url === 'string') {
    // Pre-validate so `normalizeUrl` (called by `getCachedContent`) doesn't
    // throw `TypeError: Invalid URL` on garbage input. Returning a structured
    // envelope here keeps the surface consistent with the other input-shape
    // errors above.
    if (!URL.canParse(side.url)) {
      return {
        ok: false,
        error: 'invalid_input',
        error_reason: `${label}.url is not a valid absolute URL: ${JSON.stringify(side.url)}`,
      };
    }
    const cached = getCachedContent(side.url);
    if (!cached || isExpired(cached)) {
      return {
        ok: false,
        error: 'cache_miss',
        error_reason: `No cached content for ${side.url}. Run \`fetch\` or \`crawl\` first to populate the cache, or pass the markdown directly.`,
      };
    }
    return { ok: true, markdown: cached.markdown };
  }
  return {
    ok: false,
    error: 'invalid_input',
    error_reason: `${label}.markdown or ${label}.url is required`,
  };
}

export async function handleDiff(
  input: DiffInput | Record<string, unknown>,
): Promise<StageResult<DiffOutput>> {
  const inp = input as DiffInput;

  const output: DiffOutputShape = inp.output ?? 'unified';
  const granularity: DiffGranularity = inp.granularity ?? 'line';

  if (!VALID_OUTPUT.includes(output)) {
    return {
      ok: false,
      error: 'invalid_input',
      error_reason: `Invalid output mode '${output}'. Expected one of: ${VALID_OUTPUT.join(', ')}.`,
      stage: 'diff',
    };
  }
  if (!VALID_GRANULARITY.includes(granularity)) {
    return {
      ok: false,
      error: 'invalid_input',
      error_reason: `Invalid granularity '${granularity}'. Expected one of: ${VALID_GRANULARITY.join(', ')}.`,
      stage: 'diff',
    };
  }

  const oldSide = resolveSide(inp.old, 'old');
  if (!oldSide.ok) {
    return { ok: false, error: oldSide.error, error_reason: oldSide.error_reason, stage: 'diff' };
  }
  const newSide = resolveSide(inp.new, 'new');
  if (!newSide.ok) {
    return { ok: false, error: newSide.error, error_reason: newSide.error_reason, stage: 'diff' };
  }

  try {
    const data = computeDiffEnvelope({
      oldMarkdown: oldSide.markdown,
      newMarkdown: newSide.markdown,
      output,
      granularity,
    });
    return { ok: true, data };
  } catch (err) {
    log.error('diff computation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: 'diff_failed',
      error_reason: err instanceof Error ? err.message : String(err),
      stage: 'diff',
    };
  }
}
