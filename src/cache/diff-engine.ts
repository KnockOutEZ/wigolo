import { createLogger } from '../logger.js';
import type { DiffHunk, DiffSummary, DiffOutput, DiffOutputShape, DiffGranularity } from '../types.js';
import { computeLcsTable } from './lcs.js';

const log = createLogger('cache');

/**
 * Line cap above which LCS is skipped and the envelope falls back to a
 * summary-only shape with `truncated: true`. Mirrors `MAX_DIFF_LINES` in
 * `diff-summary.ts` so the two modules degrade in lock-step. A unit test
 * pins them equal — if you tune one, tune the other.
 */
export const DIFF_LINE_CAP = 5000;

/**
 * Token cap for word-granularity LCS. The LCS DP table is O(m*n) — at
 * 5000-line cap a page averaging ~25 tokens/line could reach ~125k tokens
 * per side, producing a ~15.6-billion-cell table (~62 GB at 4 bytes/cell)
 * that crashes the MCP server outright. PR #89 sec+perf reviewers flagged
 * this as HIGH. At 50k tokens per side the table is ~10 GB-virtual /
 * realistic-sparse-write — still a lot, but inside what V8 can lazily
 * back. Inputs over the cap fall back to line-granularity hunks and the
 * envelope carries `truncated: true` so callers see the degrade.
 */
export const DIFF_TOKEN_CAP = 50_000;

const UNIFIED_CONTEXT = 3;

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = normalizeLineEndings(text);
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

type EditOp =
  | { type: 'equal'; oldLine: string; newLine: string }
  | { type: 'delete'; oldLine: string }
  | { type: 'insert'; newLine: string };

/** Walk the LCS DP table backwards to produce an ordered edit script. */
function buildEditScript(oldLines: string[], newLines: string[]): EditOp[] {
  const m = oldLines.length;
  const n = newLines.length;
  const stride = n + 1;
  const dp = computeLcsTable(oldLines, newLines);
  const ops: EditOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'equal', oldLine: oldLines[i - 1], newLine: newLines[j - 1] });
      i--;
      j--;
    } else if (dp[(i - 1) * stride + j] >= dp[i * stride + (j - 1)]) {
      ops.push({ type: 'delete', oldLine: oldLines[i - 1] });
      i--;
    } else {
      ops.push({ type: 'insert', newLine: newLines[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ type: 'delete', oldLine: oldLines[i - 1] });
    i--;
  }
  while (j > 0) {
    ops.push({ type: 'insert', newLine: newLines[j - 1] });
    j--;
  }
  ops.reverse();
  return ops;
}

function countsFromOps(ops: EditOp[]): { added: number; removed: number; modified: number } {
  // Pair adjacent delete+insert runs as "modified" — git's default semantics.
  // Order-tolerant: LCS backtrack can emit insert-then-delete or
  // delete-then-insert depending on the dp-table tie-breaking.
  let added = 0;
  let removed = 0;
  let modified = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      i++;
      continue;
    }
    let dels = 0;
    let ins = 0;
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'delete') dels++;
      else if (ops[i].type === 'insert') ins++;
      i++;
    }
    const pair = Math.min(dels, ins);
    modified += pair;
    removed += dels - pair;
    added += ins - pair;
  }
  return { added, removed, modified };
}

function changedCharsFromOps(ops: EditOp[]): number {
  let total = 0;
  for (const op of ops) {
    if (op.type === 'delete') total += op.oldLine.length;
    else if (op.type === 'insert') total += op.newLine.length;
  }
  return total;
}

function approximateSummaryForTruncated(oldLines: string[], newLines: string[]): DiffSummary {
  // We can't run LCS over the cap (quadratic blow-up). Approximate counts so
  // the caller still sees the magnitude of the change.
  const m = oldLines.length;
  const n = newLines.length;
  if (m === 0) return { added_lines: n, removed_lines: 0, modified_lines: 0, total_changed_chars: charLen(newLines) };
  if (n === 0) return { added_lines: 0, removed_lines: m, modified_lines: 0, total_changed_chars: charLen(oldLines) };
  const overlap = Math.min(m, n);
  const modified = overlap;
  const added = Math.max(0, n - overlap);
  const removed = Math.max(0, m - overlap);
  return {
    added_lines: added,
    removed_lines: removed,
    modified_lines: modified,
    total_changed_chars: charLen(oldLines) + charLen(newLines),
  };
}

function charLen(lines: string[]): number {
  let total = 0;
  for (const l of lines) total += l.length;
  return total;
}

export interface UnifiedDiffResult {
  diff: string;
  truncated: boolean;
  summary: DiffSummary;
}

export function computeUnifiedDiff(oldText: string, newText: string): UnifiedDiffResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length > DIFF_LINE_CAP || newLines.length > DIFF_LINE_CAP) {
    log.debug('diff-engine: line cap exceeded, returning approximate summary', {
      oldLineCount: oldLines.length,
      newLineCount: newLines.length,
    });
    return {
      diff: '',
      truncated: true,
      summary: approximateSummaryForTruncated(oldLines, newLines),
    };
  }

  const ops = buildEditScript(oldLines, newLines);
  const counts = countsFromOps(ops);
  const summary: DiffSummary = {
    added_lines: counts.added,
    removed_lines: counts.removed,
    modified_lines: counts.modified,
    total_changed_chars: changedCharsFromOps(ops),
  };

  if (counts.added === 0 && counts.removed === 0 && counts.modified === 0) {
    return { diff: '', truncated: false, summary };
  }

  // Normalize once and pass to the renderer pre-sorted. Avoids a second
  // O(n) pass inside `renderUnifiedDiff`.
  const normalized = normalizeEditOrder(ops);
  const diff = renderUnifiedDiff(normalized);
  return { diff, truncated: false, summary };
}

/**
 * Cheaper alternative to `computeUnifiedDiff` for callers (the section walker)
 * that only need the summary counts. Runs LCS once via `buildEditScript`
 * and computes counts + char totals without rendering the unified patch
 * or normalizing edit order.
 */
export function computeDiffSummaryOnly(oldText: string, newText: string): UnifiedDiffResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length > DIFF_LINE_CAP || newLines.length > DIFF_LINE_CAP) {
    return {
      diff: '',
      truncated: true,
      summary: approximateSummaryForTruncated(oldLines, newLines),
    };
  }

  const ops = buildEditScript(oldLines, newLines);
  const counts = countsFromOps(ops);
  return {
    diff: '',
    truncated: false,
    summary: {
      added_lines: counts.added,
      removed_lines: counts.removed,
      modified_lines: counts.modified,
      total_changed_chars: changedCharsFromOps(ops),
    },
  };
}

/**
 * Reorder consecutive non-equal ops so all deletes come before inserts
 * within a run. Matches `git diff` rendering convention — pure ordering
 * tweak, never changes the set of ops.
 */
function normalizeEditOrder(ops: EditOp[]): EditOp[] {
  const out: EditOp[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      out.push(ops[i]);
      i++;
      continue;
    }
    const dels: EditOp[] = [];
    const ins: EditOp[] = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'delete') dels.push(ops[i]);
      else ins.push(ops[i]);
      i++;
    }
    out.push(...dels, ...ins);
  }
  return out;
}

/**
 * Render a unified-diff string. **Caller must pass already-normalized ops.**
 * `computeUnifiedDiff` runs `normalizeEditOrder` once before calling — keeping
 * the normalize step out of the render path avoids a second O(n) pass.
 */
function renderUnifiedDiff(ops: EditOp[]): string {
  // Track old/new line numbers as we walk ops; emit @@ hunks grouped by
  // proximity (within 2*UNIFIED_CONTEXT lines counts as one hunk).
  type Group = { ops: EditOp[]; oldStart: number; newStart: number };
  const groups: Group[] = [];
  let oldLine = 1;
  let newLine = 1;
  let pendingContext: EditOp[] = [];
  let current: Group | null = null;
  let trailingEquals = 0;

  const flushCurrent = () => {
    if (current) {
      groups.push(current);
      current = null;
      trailingEquals = 0;
    }
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      if (current) {
        current.ops.push(op);
        trailingEquals++;
        if (trailingEquals > 2 * UNIFIED_CONTEXT) {
          // Trim trailing context to UNIFIED_CONTEXT and flush.
          const keep = current.ops.length - (trailingEquals - UNIFIED_CONTEXT);
          current.ops = current.ops.slice(0, keep);
          flushCurrent();
          pendingContext = [op];
        }
      } else {
        pendingContext.push(op);
        if (pendingContext.length > UNIFIED_CONTEXT) {
          pendingContext.shift();
        }
      }
      oldLine++;
      newLine++;
    } else {
      if (!current) {
        const leadingContext = pendingContext.slice(-UNIFIED_CONTEXT);
        const oldStart = oldLine - leadingContext.length;
        const newStart = newLine - leadingContext.length;
        current = { ops: [...leadingContext, op], oldStart, newStart };
        pendingContext = [];
      } else {
        current.ops.push(op);
      }
      trailingEquals = 0;
      if (op.type === 'delete') oldLine++;
      else newLine++;
    }
  }

  if (current) {
    // Trim trailing context if it exceeds the window.
    const tail = current.ops.length;
    let trail = 0;
    for (let k = tail - 1; k >= 0; k--) {
      if (current.ops[k].type === 'equal') trail++;
      else break;
    }
    if (trail > UNIFIED_CONTEXT) {
      current.ops = current.ops.slice(0, tail - (trail - UNIFIED_CONTEXT));
    }
    flushCurrent();
  }

  const lines: string[] = [];
  lines.push('--- old');
  lines.push('+++ new');
  for (const g of groups) {
    let oldLen = 0;
    let newLen = 0;
    for (const op of g.ops) {
      if (op.type === 'equal') {
        oldLen++;
        newLen++;
      } else if (op.type === 'delete') {
        oldLen++;
      } else {
        newLen++;
      }
    }
    lines.push(`@@ -${g.oldStart},${oldLen} +${g.newStart},${newLen} @@`);
    for (const op of g.ops) {
      if (op.type === 'equal') lines.push(` ${op.oldLine}`);
      else if (op.type === 'delete') lines.push(`-${op.oldLine}`);
      else lines.push(`+${op.newLine}`);
    }
  }
  return lines.join('\n');
}

export interface HunksResult {
  hunks: DiffHunk[];
  truncated: boolean;
  summary: DiffSummary;
}

export function computeHunks(
  oldText: string,
  newText: string,
  granularity: DiffGranularity,
): HunksResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length > DIFF_LINE_CAP || newLines.length > DIFF_LINE_CAP) {
    return {
      hunks: [],
      truncated: true,
      summary: approximateSummaryForTruncated(oldLines, newLines),
    };
  }

  if (granularity === 'section') {
    return computeSectionHunks(oldText, newText);
  }

  // Dispatch word granularity to a token-level LCS. Line-LCS on a single
  // intra-line edit produces a hunk containing the entire line. The word
  // path tokenises both sides on whitespace + punctuation, runs LCS over
  // tokens, and emits per-run
  // hunks containing only the changed tokens — what callers asking for
  // "word granularity" actually expect.
  if (granularity === 'word') {
    return computeWordHunks(oldText, newText);
  }

  const ops = buildEditScript(oldLines, newLines);
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      i++;
      continue;
    }
    // Greedily consume a run of consecutive non-equal ops (delete + insert in
    // either order — LCS backtrack reverses produce both orderings).
    const removes: string[] = [];
    const adds: string[] = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      const op = ops[i];
      if (op.type === 'delete') removes.push(op.oldLine);
      else if (op.type === 'insert') adds.push(op.newLine);
      i++;
    }
    if (removes.length > 0 && adds.length > 0) {
      hunks.push({ before: removes.join('\n'), after: adds.join('\n'), change_type: 'modified' });
    } else if (removes.length > 0) {
      hunks.push({ before: removes.join('\n'), after: '', change_type: 'removed' });
    } else if (adds.length > 0) {
      hunks.push({ before: '', after: adds.join('\n'), change_type: 'added' });
    }
  }
  const counts = countsFromOps(ops);
  const summary: DiffSummary = {
    added_lines: counts.added,
    removed_lines: counts.removed,
    modified_lines: counts.modified,
    total_changed_chars: changedCharsFromOps(ops),
  };
  return { hunks, truncated: false, summary };
}

// Word-granularity hunks. Splits on whitespace/punctuation
// boundaries — emits whitespace and word tokens separately so we can
// reconstruct readable hunk text without inventing spaces. Empty tokens
// are dropped; the result is the same sequence a human would read.
function tokenizeWords(text: string): string[] {
  if (!text) return [];
  // Group runs of whitespace + runs of non-whitespace separately. Keeps
  // intra-line spacing intact and produces sensible LCS alignments.
  return text.match(/\s+|[^\s]+/g) ?? [];
}

function computeWordHunks(oldText: string, newText: string): HunksResult {
  const oldTokens = tokenizeWords(oldText);
  const newTokens = tokenizeWords(newText);

  // PR #89 sec+perf reviewers (HIGH): word-LCS is O(m*n) in token count.
  // Without this cap a caller passing a few hundred KB of text can OOM the
  // server (table cells = (m+1)*(n+1) × 4 bytes). Fall back to
  // line-granularity hunks — still useful, never throws — and signal
  // truncation so the caller sees the degrade.
  if (oldTokens.length > DIFF_TOKEN_CAP || newTokens.length > DIFF_TOKEN_CAP) {
    log.debug('diff-engine: word-token cap exceeded, falling back to line granularity', {
      oldTokenCount: oldTokens.length,
      newTokenCount: newTokens.length,
      cap: DIFF_TOKEN_CAP,
    });
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);
    // Line cap might also bite — if so emit an approximate summary like
    // the line path does. Otherwise run line-LCS to produce real hunks.
    if (oldLines.length > DIFF_LINE_CAP || newLines.length > DIFF_LINE_CAP) {
      return {
        hunks: [],
        truncated: true,
        summary: approximateSummaryForTruncated(oldLines, newLines),
      };
    }
    const lineFallback = computeHunks(oldText, newText, 'line');
    return {
      hunks: lineFallback.hunks,
      truncated: true,
      summary: lineFallback.summary,
    };
  }

  const ops = buildEditScript(oldTokens, newTokens);

  // Group consecutive non-equal ops into a single hunk. Each hunk's
  // before/after concatenates the changed tokens — no padding context, to
  // contrast with line-granularity which carries the full line for any
  // intra-line change.
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      i++;
      continue;
    }
    const removes: string[] = [];
    const adds: string[] = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      const op = ops[i];
      if (op.type === 'delete') removes.push(op.oldLine);
      else if (op.type === 'insert') adds.push(op.newLine);
      i++;
    }
    // Skip pure-whitespace flips (only whitespace-token runs changed) — these
    // are usually re-flow noise the caller doesn't want as a hunk.
    const beforeStr = removes.join('');
    const afterStr = adds.join('');
    if (beforeStr.trim().length === 0 && afterStr.trim().length === 0) continue;
    if (removes.length > 0 && adds.length > 0) {
      hunks.push({ before: beforeStr, after: afterStr, change_type: 'modified' });
    } else if (removes.length > 0) {
      hunks.push({ before: beforeStr, after: '', change_type: 'removed' });
    } else if (adds.length > 0) {
      hunks.push({ before: '', after: afterStr, change_type: 'added' });
    }
  }

  // Reuse the existing line-granularity summary so total_changed_chars
  // semantics remain consistent across granularities (sum of changed
  // characters in delete + insert ops). Computed on the line edit-script
  // — the word path's character cost equals the line path's for the
  // changed lines, so the field stays comparable across runs.
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lineOps = buildEditScript(oldLines, newLines);
  const counts = countsFromOps(lineOps);
  const summary: DiffSummary = {
    added_lines: counts.added,
    removed_lines: counts.removed,
    modified_lines: counts.modified,
    total_changed_chars: changedCharsFromOps(lineOps),
  };
  return { hunks, truncated: false, summary };
}

interface Section {
  title?: string;
  body: string;
}

const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;

function splitSections(text: string): Section[] {
  const lines = splitLines(text);
  const sections: Section[] = [];
  let current: Section = { title: undefined, body: '' };
  const bodyLines: string[] = [];
  let hasSeenHeading = false;

  const flush = () => {
    current.body = bodyLines.join('\n');
    sections.push(current);
    bodyLines.length = 0;
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      if (hasSeenHeading || bodyLines.length > 0) {
        flush();
      }
      current = { title: m[2], body: '' };
      hasSeenHeading = true;
    } else {
      bodyLines.push(line);
    }
  }
  flush();
  return sections;
}

function computeSectionHunks(oldText: string, newText: string): HunksResult {
  const oldSections = splitSections(oldText);
  const newSections = splitSections(newText);

  // Index new sections by title so we can match modifications/added/removed
  // by section identity rather than positional ordering. Untitled (prelude)
  // sections compare positionally — only one is allowed per doc.
  const newByTitle = new Map<string, Section[]>();
  for (const s of newSections) {
    if (s.title) {
      const arr = newByTitle.get(s.title) ?? [];
      arr.push(s);
      newByTitle.set(s.title, arr);
    }
  }

  // Track which new sections (by reference) have been consumed as matches
  // against old sections. After the old-loop, anything still NOT in this
  // set is a pure addition. Using a Set keeps the final "section added"
  // pass O(n) instead of the previous O(sections²) via `Array.includes`.
  const consumedNew = new Set<Section>();

  const hunks: DiffHunk[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalModified = 0;
  let totalChars = 0;

  // Handle prelude (untitled) section pairing positionally.
  const oldPrelude = oldSections.find((s) => !s.title);
  const newPrelude = newSections.find((s) => !s.title);
  if (oldPrelude || newPrelude) {
    const before = oldPrelude?.body ?? '';
    const after = newPrelude?.body ?? '';
    if (before !== after) {
      const inner = computeDiffSummaryOnly(before, after);
      if (before && after) {
        hunks.push({ before, after, change_type: 'modified' });
      } else if (after) {
        hunks.push({ before: '', after, change_type: 'added' });
      } else {
        hunks.push({ before, after: '', change_type: 'removed' });
      }
      totalAdded += inner.summary.added_lines;
      totalRemoved += inner.summary.removed_lines;
      totalModified += inner.summary.modified_lines;
      totalChars += inner.summary.total_changed_chars;
    }
  }

  for (const oldSec of oldSections) {
    if (!oldSec.title) continue;
    const candidates = newByTitle.get(oldSec.title);
    if (!candidates || candidates.length === 0) {
      // Section removed in new doc.
      hunks.push({
        section_title: oldSec.title,
        before: oldSec.body,
        after: '',
        change_type: 'removed',
      });
      totalRemoved += splitLines(oldSec.body).length;
      totalChars += oldSec.body.length;
      continue;
    }
    // Pop the first unused candidate (handles duplicate titles deterministically).
    const newSec = candidates.shift()!;
    consumedNew.add(newSec);
    if (oldSec.body === newSec.body) {
      continue;
    }
    const inner = computeDiffSummaryOnly(oldSec.body, newSec.body);
    hunks.push({
      section_title: oldSec.title,
      before: oldSec.body,
      after: newSec.body,
      change_type: 'modified',
    });
    totalAdded += inner.summary.added_lines;
    totalRemoved += inner.summary.removed_lines;
    totalModified += inner.summary.modified_lines;
    totalChars += inner.summary.total_changed_chars;
  }

  // Sections present only in the new doc — anything we didn't consume above.
  // Walking `newSections` in original order keeps the hunk output stable.
  for (const newSec of newSections) {
    if (!newSec.title) continue;
    if (consumedNew.has(newSec)) continue;
    hunks.push({
      section_title: newSec.title,
      before: '',
      after: newSec.body,
      change_type: 'added',
    });
    totalAdded += splitLines(newSec.body).length;
    totalChars += newSec.body.length;
  }

  return {
    hunks,
    truncated: false,
    summary: {
      added_lines: totalAdded,
      removed_lines: totalRemoved,
      modified_lines: totalModified,
      total_changed_chars: totalChars,
    },
  };
}

export interface DiffEnvelopeInput {
  oldMarkdown: string;
  newMarkdown: string;
  output: DiffOutputShape;
  granularity: DiffGranularity;
}

export function computeDiffEnvelope(input: DiffEnvelopeInput): DiffOutput {
  const { oldMarkdown, newMarkdown, output, granularity } = input;

  if (oldMarkdown === newMarkdown) {
    return {
      changed: false,
      summary: {
        added_lines: 0,
        removed_lines: 0,
        modified_lines: 0,
        total_changed_chars: 0,
      },
    };
  }

  if (output === 'summary') {
    const u = computeUnifiedDiff(oldMarkdown, newMarkdown);
    const out: DiffOutput = {
      changed:
        u.summary.added_lines > 0 ||
        u.summary.removed_lines > 0 ||
        u.summary.modified_lines > 0 ||
        u.truncated,
      summary: u.summary,
    };
    if (u.truncated) out.truncated = true;
    return out;
  }

  if (output === 'hunks') {
    const h = computeHunks(oldMarkdown, newMarkdown, granularity);
    const changed =
      h.hunks.length > 0 ||
      h.summary.added_lines > 0 ||
      h.summary.removed_lines > 0 ||
      h.summary.modified_lines > 0;
    const out: DiffOutput = {
      changed,
      hunks: h.hunks,
      summary: h.summary,
    };
    if (h.truncated) out.truncated = true;
    return out;
  }

  // unified (default)
  const u = computeUnifiedDiff(oldMarkdown, newMarkdown);
  const changed =
    u.summary.added_lines > 0 ||
    u.summary.removed_lines > 0 ||
    u.summary.modified_lines > 0 ||
    u.truncated;
  const out: DiffOutput = {
    changed,
    summary: u.summary,
  };
  if (!u.truncated) out.unified_diff = u.diff;
  if (u.truncated) out.truncated = true;
  return out;
}
