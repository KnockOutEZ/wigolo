import { truncateByTokens } from './tokens.js';

const TRUNC_MARKER = '\n\n[... content truncated]';

/** Ellipsis used for prose-length cuts (findings, tradeoffs, passages). */
export const ELLIPSIS = '…';

/**
 * Repair a markdown fragment that was cut at an arbitrary offset.
 *
 * STRICTLY SUBTRACTIVE: this only ever removes trailing characters, never adds
 * any. Closing a dangling fence would be the obvious repair and is the wrong
 * one — it grows the string past the budget it was just cut to, which would
 * break truncateByTokens' `countTokens(result) <= maxTokens` guarantee and the
 * aggregate markdown budget that depends on it. Dropping the broken construct
 * is always within budget.
 *
 * Ordered widest-first: a fence contains backticks, so it has to be resolved
 * before inline-code repair or the fence's own backticks read as a dangling
 * span.
 */
export function repairTruncatedMarkdown(text: string): string {
  let out = text;

  // 1. Unterminated fenced code block — drop the opening fence and its contents.
  const fenceMatches = [...out.matchAll(/^[ \t]*```/gm)];
  if (fenceMatches.length % 2 === 1) {
    const opener = fenceMatches[fenceMatches.length - 1];
    out = out.slice(0, opener.index).trimEnd();
  }

  // 2. Partial link or image — `[text](par` or a bare `[text` with no closer.
  //    Both render as literal junk, and the half-URL is not a usable citation.
  const lastOpenBracket = out.lastIndexOf('[');
  if (lastOpenBracket !== -1) {
    const tail = out.slice(lastOpenBracket);
    const complete = /^!?\[[^\]]*\]\([^)]*\)/.test(tail);
    if (!complete) {
      const imagePrefix = lastOpenBracket > 0 && out[lastOpenBracket - 1] === '!' ? 1 : 0;
      out = out.slice(0, lastOpenBracket - imagePrefix).trimEnd();
    }
  }

  // 3. Dangling emphasis / inline code — an odd delimiter count means the cut
  //    landed inside the span, so everything from the opener on is a fragment.
  for (const delim of ['**', '`']) {
    const count = out.split(delim).length - 1;
    if (count % 2 === 1) {
      out = out.slice(0, out.lastIndexOf(delim)).trimEnd();
    }
  }

  return out;
}

/**
 * Prose truncation that lands on a sentence boundary when one is close enough,
 * a word boundary otherwise, and never inside a markdown construct.
 *
 * Used for the fixed char caps on brief text (key findings, comparison
 * tradeoffs, highlight passages), where the previous bare `.slice()` cut
 * mid-word and mid-link. Returns '' rather than a lone marker when the budget
 * cannot fit any content — a body consisting only of the marker is content-free
 * output pretending to be content.
 */
export function truncateAtBoundary(
  text: string,
  maxChars: number,
  marker: string = ELLIPSIS,
): string {
  if (text.length <= maxChars) return text;

  const budget = maxChars - marker.length;
  if (budget <= 0) return '';

  const head = text.slice(0, budget);
  const threshold = budget * 0.7;

  let cut = -1;

  // Sentence boundary first — the most readable place to stop.
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('.\n'),
    head.lastIndexOf('? '),
    head.lastIndexOf('! '),
  );
  if (sentenceEnd > threshold) {
    cut = sentenceEnd + 1;
  } else {
    // Word boundary. Search the whole head, not just the tail window: a single
    // very long token (a URL, a minified blob) has no boundary to find and a
    // windowed search would silently fall back to the mid-word cut we are here
    // to remove.
    const lastSpace = head.search(/\s\S*$/);
    if (lastSpace > 0) cut = lastSpace;
  }

  const body = cut > 0 ? head.slice(0, cut) : head;
  const repaired = repairTruncatedMarkdown(body).trimEnd();
  if (!repaired) return '';

  return repaired + marker;
}

export function truncateSmartly(text: string, maxChars: number): string {
  if (maxChars <= 0) return TRUNC_MARKER;
  if (text.length <= maxChars) return text;

  const head = text.slice(0, maxChars);
  const lastPara = head.lastIndexOf('\n\n');
  const lastHeading = head.lastIndexOf('\n#');
  const lastBreak = Math.max(lastPara, lastHeading);
  const threshold = maxChars * 0.7;

  const body = lastBreak > threshold ? head.slice(0, lastBreak) : head;
  // A paragraph break is not a safe cut point on its own: `\n\n` occurs INSIDE
  // fenced code blocks, so the existing boundary search happily cut a fence in
  // half and shipped an unterminated ``` into the source body.
  return repairTruncatedMarkdown(body) + TRUNC_MARKER;
}

// max_tokens_out wins over max_chars whenever both are set. Falls back to
// truncateSmartly for chars-only budgets, and returns text unchanged when
// neither is set.
export function applyOutputBudget(
  text: string,
  opts: { maxTokensOut?: number; maxChars?: number },
): string {
  if (!text) return text;
  if (opts.maxTokensOut != null) return truncateByTokens(text, opts.maxTokensOut);
  if (opts.maxChars != null) return truncateSmartly(text, opts.maxChars);
  return text;
}
