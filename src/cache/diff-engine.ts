import { createLogger } from '../logger.js';
import type { DiffHunk, DiffSummary, DiffOutput, DiffOutputShape, DiffGranularity } from '../types.js';

const log = createLogger('cache');

/**
 * Line cap above which LCS is skipped and the envelope falls back to a
 * summary-only shape with `truncated: true`. Mirrors the cap in
 * `diff-summary.ts` so the two modules degrade in lock-step.
 *
 * NOTE: `diff-summary.ts` is marked read-only by the slice spec. The LCS
 * algorithm and size cap are reimplemented here rather than exported from
 * that file. Both implementations must stay aligned; if you tune one, tune
 * the other.
 */
export const DIFF_LINE_CAP = 5000;

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

/**
 * Classic LCS DP table. Identical algorithm to `diff-summary.ts:computeLCS`.
 * Kept private here so callers route through the higher-level engine helpers.
 */
function computeLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

type EditOp =
  | { type: 'equal'; oldLine: string; newLine: string }
  | { type: 'delete'; oldLine: string }
  | { type: 'insert'; newLine: string };

/** Walk the LCS DP table backwards to produce an ordered edit script. */
function buildEditScript(oldLines: string[], newLines: string[]): EditOp[] {
  const dp = computeLcsTable(oldLines, newLines);
  const ops: EditOp[] = [];
  let i = oldLines.length;
  let j = newLines.length;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'equal', oldLine: oldLines[i - 1], newLine: newLines[j - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
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

  const diff = renderUnifiedDiff(ops);
  return { diff, truncated: false, summary };
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

function renderUnifiedDiff(rawOps: EditOp[]): string {
  const ops = normalizeEditOrder(rawOps);
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

  // line + word granularities share the LCS walk; word currently produces
  // line-grouped hunks because the spec only requires it to land in the API
  // surface — finer-grained per-word diff is a future enhancement once the
  // section walker lands.
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

  const hunks: DiffHunk[] = [];
  const usedNewTitles = new Set<string>();
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
      const inner = computeUnifiedDiff(before, after);
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
    usedNewTitles.add(oldSec.title);
    if (oldSec.body === newSec.body) {
      continue;
    }
    const inner = computeUnifiedDiff(oldSec.body, newSec.body);
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

  // Sections present only in the new doc.
  for (const newSec of newSections) {
    if (!newSec.title) continue;
    const candidates = newByTitle.get(newSec.title);
    if (candidates && candidates.includes(newSec)) {
      // Was this consumed by the old-loop above? If so, skip.
      // After the loop, `candidates` still holds unconsumed entries.
      const idx = candidates.indexOf(newSec);
      if (idx !== -1) {
        hunks.push({
          section_title: newSec.title,
          before: '',
          after: newSec.body,
          change_type: 'added',
        });
        totalAdded += splitLines(newSec.body).length;
        totalChars += newSec.body.length;
        candidates.splice(idx, 1);
      }
    }
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
