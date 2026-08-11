/**
 * Brief-truncation garbling benchmark.
 *
 * Scores the OLD fixed-cap `.slice()` rule against the NEW boundary-aware rule
 * over the same corpus in the same run, so the two numbers are directly
 * comparable and neither depends on a remembered baseline file.
 *
 * Corpus: the repository's own user-facing markdown. Real prose with real
 * links, fenced code, and bold runs — the constructs the cut actually breaks.
 * Synthetic strings would let the harness pick its own difficulty.
 *
 * A "defect" is a property of the OUTPUT alone, checkable without reference to
 * intent: text that stops mid-word, an unterminated code fence, a half-written
 * link, or an unmatched emphasis / inline-code delimiter. Every one of these is
 * something a reader sees as garbage.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { truncateAtBoundary } from '../../src/search/truncate.js';

const KEY_FINDING_LEN = 280;
const TRADEOFF_LEN = 280;
const PASSAGE_LEN = 500;

/** The rule this slice replaced, kept verbatim so the comparison is honest. */
function oldCut(text: string, maxChars: number, marker: string): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - marker.length).trimEnd() + marker;
}

interface Defects {
  mid_word: number;
  dangling_fence: number;
  broken_link: number;
  dangling_bold: number;
  dangling_code: number;
}

const EMPTY: Defects = {
  mid_word: 0, dangling_fence: 0, broken_link: 0, dangling_bold: 0, dangling_code: 0,
};

function scoreOne(original: string, out: string, marker: string): Defects {
  const d: Defects = { ...EMPTY };
  if (!out || out === original) return d;

  const body = out.endsWith(marker) ? out.slice(0, -marker.length) : out;

  // mid-word: the emitted body is a prefix of the source that stops with a word
  // character while the source continued with one.
  if (original.startsWith(body) && body.length < original.length) {
    const last = body.slice(-1);
    const next = original.slice(body.length, body.length + 1);
    if (/[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(next)) d.mid_word = 1;
  }

  if (((out.match(/```/g) ?? []).length) % 2 === 1) d.dangling_fence = 1;
  if (((out.match(/\*\*/g) ?? []).length) % 2 === 1) d.dangling_bold = 1;
  if (((out.replace(/```/g, '').match(/`/g) ?? []).length) % 2 === 1) d.dangling_code = 1;

  // broken link: an opening bracket with no completed `](...)` after it.
  const lastOpen = out.lastIndexOf('[');
  if (lastOpen !== -1 && !/^!?\[[^\]]*\]\([^)]*\)/.test(out.slice(lastOpen))) {
    // A bare `[N]` citation marker is legitimate and not a broken link.
    if (!/^\[[^\]]*\]/.test(out.slice(lastOpen))) d.broken_link = 1;
  }

  return d;
}

function add(a: Defects, b: Defects): Defects {
  return {
    mid_word: a.mid_word + b.mid_word,
    dangling_fence: a.dangling_fence + b.dangling_fence,
    broken_link: a.broken_link + b.broken_link,
    dangling_bold: a.dangling_bold + b.dangling_bold,
    dangling_code: a.dangling_code + b.dangling_code,
  };
}

function total(d: Defects): number {
  return d.mid_word + d.dangling_fence + d.broken_link + d.dangling_bold + d.dangling_code;
}

/** Paragraph-ish blocks, the unit key findings and passages are cut from. */
function blocks(md: string): string[] {
  return md.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}

function sentences(md: string): string[] {
  return md
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function main(): void {
  const docsDir = join(process.cwd(), 'docs');
  const files = readdirSync(docsDir).filter((f) => f.endsWith('.md'));

  const segments: Array<{ text: string; cap: number; kind: string }> = [];
  for (const f of files) {
    const md = readFileSync(join(docsDir, f), 'utf8');
    for (const b of blocks(md)) {
      segments.push({ text: b, cap: KEY_FINDING_LEN, kind: 'key_finding' });
      segments.push({ text: b, cap: PASSAGE_LEN, kind: 'passage' });
    }
    for (const s of sentences(md)) {
      segments.push({ text: s, cap: TRADEOFF_LEN, kind: 'tradeoff' });
    }
  }

  const truncated = segments.filter((s) => s.text.length > s.cap);

  let oldTotals: Defects = { ...EMPTY };
  let newTotals: Defects = { ...EMPTY };
  let oldBad = 0;
  let newBad = 0;
  let oldChars = 0;
  let newChars = 0;
  let emptied = 0;

  for (const seg of truncated) {
    const o = oldCut(seg.text, seg.cap, '…');
    const n = truncateAtBoundary(seg.text, seg.cap);
    const od = scoreOne(seg.text, o, '…');
    const nd = scoreOne(seg.text, n, '…');
    oldTotals = add(oldTotals, od);
    newTotals = add(newTotals, nd);
    if (total(od) > 0) oldBad++;
    if (total(nd) > 0) newBad++;
    oldChars += o.length;
    newChars += n.length;
    if (!n) emptied++;
  }

  const n = truncated.length;
  const pct = (x: number) => `${((x / n) * 100).toFixed(1)}%`;

  const lines: string[] = [];
  lines.push('Brief-truncation garbling benchmark');
  lines.push(`corpus: ${files.length} markdown files, ${segments.length} segments, ${n} actually truncated`);
  lines.push('');
  lines.push('defect                 OLD (.slice)      NEW (boundary-aware)');
  const row = (label: string, a: number, b: number) =>
    lines.push(`${label.padEnd(22)} ${String(a).padStart(5)} ${pct(a).padStart(8)}   ${String(b).padStart(5)} ${pct(b).padStart(8)}`);
  row('mid-word cut', oldTotals.mid_word, newTotals.mid_word);
  row('unterminated fence', oldTotals.dangling_fence, newTotals.dangling_fence);
  row('broken link', oldTotals.broken_link, newTotals.broken_link);
  row('dangling bold', oldTotals.dangling_bold, newTotals.dangling_bold);
  row('dangling inline code', oldTotals.dangling_code, newTotals.dangling_code);
  lines.push('');
  row('segments with >=1', oldBad, newBad);
  lines.push('');
  lines.push(`total defects: OLD ${total(oldTotals)} -> NEW ${total(newTotals)}`);
  lines.push('');
  // The cost side. Backing up to a boundary always discards some characters;
  // reporting only the defect drop would hide what it was bought with.
  lines.push(
    `content retained: OLD ${oldChars} chars -> NEW ${newChars} chars ` +
    `(${((newChars / oldChars) * 100).toFixed(1)}% of the old output, ` +
    `${(oldChars - newChars) / n} chars/segment given up)`,
  );
  lines.push(`segments reduced to empty by the new rule: ${emptied}`);

  process.stdout.write(lines.join('\n') + '\n');

  if (process.env.BENCH_JSON) {
    process.stdout.write(JSON.stringify({
      corpus_files: files.length,
      segments: segments.length,
      truncated: n,
      old: oldTotals,
      new: newTotals,
      old_segments_with_defect: oldBad,
      new_segments_with_defect: newBad,
    }, null, 2) + '\n');
  }
}

main();
