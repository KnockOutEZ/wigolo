import { createLogger } from '../logger.js';
import { computeLcsTable } from './lcs.js';

const log = createLogger('cache');

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

interface DiffCounts {
  added: number;
  removed: number;
  modified: number;
}

function computeDiffCounts(oldLines: string[], newLines: string[]): DiffCounts {
  const m = oldLines.length;
  const n = newLines.length;

  if (m === 0 && n === 0) return { added: 0, removed: 0, modified: 0 };
  if (m === 0) return { added: n, removed: 0, modified: 0 };
  if (n === 0) return { added: 0, removed: m, modified: 0 };

  const dp = computeLcsTable(oldLines, newLines);
  const stride = n + 1;
  const lcsLength = dp[m * stride + n];

  const removed = m - lcsLength;
  const added = n - lcsLength;

  let modified = 0;
  const pairable = Math.min(removed, added);
  if (pairable > 0) {
    modified = pairable;
  }

  return {
    added: added - modified,
    removed: removed - modified,
    modified,
  };
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${singular}s`;
}

/**
 * Line cap above which LCS is skipped. Must stay equal to `DIFF_LINE_CAP`
 * in `diff-engine.ts` — both modules share `lcs.ts` and degrade in
 * lock-step. A unit test pins these equal.
 */
export const MAX_DIFF_LINES = 5000;

export function computeDiffSummary(oldMarkdown: string, newMarkdown: string): string {
  try {
    const oldLines = splitLines(oldMarkdown);
    const newLines = splitLines(newMarkdown);

    if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
      log.debug('content too large for LCS diff, returning approximate summary', {
        oldLineCount: oldLines.length,
        newLineCount: newLines.length,
      });
      return `Content changed significantly (${oldLines.length} -> ${newLines.length} lines)`;
    }

    const counts = computeDiffCounts(oldLines, newLines);

    const summary =
      `${pluralize(counts.added, 'line')} added, ` +
      `${pluralize(counts.removed, 'line')} removed, ` +
      `${pluralize(counts.modified, 'line')} modified`;

    log.debug('diff summary computed', {
      oldLineCount: oldLines.length,
      newLineCount: newLines.length,
      ...counts,
    });

    return summary;
  } catch (err) {
    log.warn('diff summary computation failed', { error: err instanceof Error ? err.message : String(err) });
    return 'Unable to compute diff summary';
  }
}
