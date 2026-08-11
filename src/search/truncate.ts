import { truncateByTokens } from './tokens.js';

const TRUNC_MARKER = '\n\n[... content truncated]';

/** Ellipsis used for prose-length cuts (findings, tradeoffs, passages). */
export const ELLIPSIS = '…';

/**
 * Hard ceiling on repair passes.
 *
 * The loop does not rely on this to terminate — every pass that changes the
 * string makes it strictly shorter, so the sequence is strictly decreasing and
 * bounded below by the empty string. The ceiling is a second, independent bound
 * so that a future pass which stopped being subtractive could not turn this into
 * a synchronous spin. That failure mode has already cost this codebase twice,
 * most recently a de-collision suffix appended after a length cap, which wedged
 * a vitest worker so hard that no test timeout could fire.
 */
export const MAX_REPAIR_PASSES = 8;

/**
 * One repair pass. Ordered widest-first: a fence contains backticks, so it has
 * to be resolved before inline-code repair or the fence's own backticks read as
 * a dangling span; and the table step runs before the link step so a row cut
 * inside a link cell is dropped whole rather than left with the wrong number of
 * cells.
 */
function repairOnce(text: string): string {
  let out = text;

  // 1. Unterminated fenced code block — drop the opening fence and its contents.
  const fenceMatches = [...out.matchAll(/^[ \t]*```/gm)];
  if (fenceMatches.length % 2 === 1) {
    const opener = fenceMatches[fenceMatches.length - 1];
    out = out.slice(0, opener.index).trimEnd();
  }

  // 2. Half-written table row. A row cut before its closing pipe renders as a
  //    stray pipe run welded onto the previous cell, and no amount of link or
  //    emphasis repair touches it — the constructs are all balanced.
  out = dropTruncatedTableRow(out);

  // 3. Partial link or image — `[text` with no closing bracket, or `[text](par`
  //    with no closing paren. Both render as literal junk and the half-URL is
  //    not a usable citation.
  //
  //    A bare `[text]` with no `(` following is NOT broken: that is a citation
  //    marker (`[1]`), a reference-style link, or an array literal in prose
  //    ("set it to [a, b, c]"). Treating "not a complete inline link" as broken
  //    deleted every one of those along with the rest of the line.
  const lastOpenBracket = out.lastIndexOf('[');
  if (lastOpenBracket !== -1) {
    const tail = out.slice(lastOpenBracket);
    const closeIdx = tail.indexOf(']');
    const broken =
      closeIdx === -1 ||
      (tail[closeIdx + 1] === '(' && !tail.slice(closeIdx + 1).includes(')'));
    if (broken) {
      const imagePrefix = lastOpenBracket > 0 && out[lastOpenBracket - 1] === '!' ? 1 : 0;
      out = out.slice(0, lastOpenBracket - imagePrefix).trimEnd();
    }
  }

  // 4. Dangling emphasis / inline code — an odd delimiter count means the cut
  //    landed inside the span, so everything from the opener on is a fragment.
  for (const delim of ['**', '`']) {
    const count = out.split(delim).length - 1;
    if (count % 2 === 1) {
      out = out.slice(0, out.lastIndexOf(delim)).trimEnd();
    }
  }

  // 5. Cut inside a raw HTML tag — `<a href="htt`. Markdown passes raw HTML
  //    through, so an unterminated tag swallows whatever a renderer puts after
  //    it. Scoped to a cut mid-TAG, not to element balancing: requires a name
  //    character right after `<` so `a < b` and `Array<T>` do not match.
  const openTag = /<[A-Za-z/][^<>]*$/.exec(out);
  if (openTag) {
    out = out.slice(0, openTag.index).trimEnd();
  }

  return out;
}

/**
 * Drop a trailing table row that the cut left open.
 *
 * Fires only when an EARLIER row of the same contiguous table block closes with
 * a pipe. GFM allows a table whose rows carry a leading pipe and no trailing one
 * (`| a | b`), and every row of such a table would otherwise look truncated;
 * reading the style off a row that survived intact is what tells the two apart.
 * A cell count would not: the commonest real cut lands inside the LAST cell of a
 * three-column row, which still splits into three cells.
 */
function dropTruncatedTableRow(text: string): string {
  const lines = text.split('\n');
  const lastIdx = lines.length - 1;
  const last = lines[lastIdx].trimEnd();
  if (!/^\s*\|/.test(last) || last.endsWith('|')) return text;

  let closesWithPipe = false;
  for (let i = lastIdx - 1; i >= 0 && /^\s*\|/.test(lines[i]); i--) {
    if (lines[i].trimEnd().endsWith('|')) {
      closesWithPipe = true;
      break;
    }
  }
  if (!closesWithPipe) return text;

  return lines.slice(0, lastIdx).join('\n').trimEnd();
}

/**
 * Repair a markdown fragment that was cut at an arbitrary offset, iterating to a
 * fixed point.
 *
 * STRICTLY SUBTRACTIVE: this only ever removes trailing characters, never adds
 * any. Closing a dangling fence would be the obvious repair and is the wrong one
 * here — it grows the string past the budget it was just cut to, which would
 * break truncateByTokens' `countTokens(result) <= maxTokens` guarantee and the
 * aggregate markdown budget that depends on it. Dropping the broken construct is
 * always within budget. (The budget-aware callers below CAN re-close a fence,
 * because they know the cap and can pay for the closer out of the content.)
 *
 * A single pass is not enough, and the shape that proves it is ordinary badge
 * markup: `[![alt](img)](url)` cut inside the image leaves the outer `[` behind
 * — the exact junk this function exists to remove, one level out. Every step can
 * expose work for another step, so the pass repeats until it changes nothing.
 */
export function repairTruncatedMarkdown(text: string): string {
  let out = text;
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const next = repairOnce(out);
    if (next === out) return out;
    // Every pass is subtractive, so this cannot hold. If it ever does, the pass
    // stopped shrinking and iterating again would be a spin — stop instead.
    if (next.length >= out.length) return next;
    out = next;
  }
  return out;
}

/**
 * Re-cut a body that is nothing but an unterminated code fence so the fence
 * closes, within `maxChars`.
 *
 * The subtractive repair deletes an unterminated fence and everything in it.
 * When the fence IS the body — a gist, a config file, a source page that is one
 * big block — that leaves nothing, so the source contributed no body at all to
 * the report at any budget, silently. Emitting the code that fits and closing
 * the fence costs the closer's own characters and keeps the rest.
 *
 * Returns null when the body is not a lone fence, or when the budget cannot even
 * pay for the opener plus the closer. Length is `<= maxChars` by construction:
 * the closer's cost is subtracted from the content allowance before the cut.
 */
function closeTruncatedFence(body: string, maxChars: number): string | null {
  const m = /^\s*(`{3,})[^\n]*\n/.exec(body);
  if (!m) return null;

  const opener = m[0];
  const closer = m[1];
  // opener + code + '\n' + closer, and a newline for whatever the caller appends.
  const overhead = opener.length + 1 + closer.length + 1;
  const room = maxChars - overhead;
  if (room <= 0) return null;

  let code = body.slice(opener.length);
  // Only a lone fence qualifies: if the body already closed this one, the
  // subtractive repair was not the thing that emptied it.
  if (new RegExp(`^\\s*${closer}`, 'm').test(code)) return null;

  if (code.length > room) {
    code = code.slice(0, room);
    const nl = code.lastIndexOf('\n');
    if (nl > 0) code = code.slice(0, nl);
  }
  code = code.replace(/\s+$/, '');
  if (!code) return null;

  return `${opener}${code}\n${closer}`;
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
  if (!repaired) {
    const fenced = closeTruncatedFence(body, budget);
    if (!fenced) return '';
    return marker ? `${fenced}\n${marker}` : fenced;
  }

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
  const repaired = repairTruncatedMarkdown(body);
  if (!repaired) {
    // A page that is one code block would otherwise be reduced to the marker
    // alone — content-free output pretending to be content.
    const fenced = closeTruncatedFence(body, maxChars);
    if (fenced) return fenced + TRUNC_MARKER;
  }
  return repaired + TRUNC_MARKER;
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
