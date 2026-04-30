import { encode, decode } from 'gpt-tokenizer';

const TRUNC_MARKER = '\n\n[... content truncated]';
const MARKER_TOKEN_BUDGET = 6;

export function countTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

// Token-budget truncation. Prefer sentence > paragraph > section boundary
// within the last 30% of the budget. Falls back to a hard token cut + marker.
// Caveat: gpt-tokenizer uses cl100k-base (OpenAI). Counts on Claude/Gemini/
// Llama may drift ~5-15%. Treat as approximation; we are not billing.
export function truncateByTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return TRUNC_MARKER.trim();
  if (!text) return '';
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return text;

  const budget = Math.max(0, maxTokens - MARKER_TOKEN_BUDGET);
  const head = decode(tokens.slice(0, budget));
  const threshold = head.length * 0.7;
  const lastSentence = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('.\n'),
    head.lastIndexOf('? '),
    head.lastIndexOf('! '),
  );
  if (lastSentence > threshold) {
    return head.slice(0, lastSentence + 1) + TRUNC_MARKER;
  }
  const lastPara = head.lastIndexOf('\n\n');
  if (lastPara > threshold) {
    return head.slice(0, lastPara) + TRUNC_MARKER;
  }
  const lastHeading = head.lastIndexOf('\n#');
  if (lastHeading > threshold) {
    return head.slice(0, lastHeading) + TRUNC_MARKER;
  }
  return head + TRUNC_MARKER;
}
