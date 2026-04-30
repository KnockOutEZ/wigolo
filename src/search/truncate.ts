import { truncateByTokens } from './tokens.js';

const TRUNC_MARKER = '\n\n[... content truncated]';

export function truncateSmartly(text: string, maxChars: number): string {
  if (maxChars <= 0) return TRUNC_MARKER;
  if (text.length <= maxChars) return text;

  const head = text.slice(0, maxChars);
  const lastPara = head.lastIndexOf('\n\n');
  const lastHeading = head.lastIndexOf('\n#');
  const lastBreak = Math.max(lastPara, lastHeading);
  const threshold = maxChars * 0.7;

  if (lastBreak > threshold) {
    return head.slice(0, lastBreak) + TRUNC_MARKER;
  }
  return head + TRUNC_MARKER;
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
