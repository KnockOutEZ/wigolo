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
