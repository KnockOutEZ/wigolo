/**
 * Brief-truncation garbling benchmark.
 *
 * Scores the OLD fixed-cap `.slice()` rule against the NEW boundary-aware rule
 * over the same corpus in the same run, so the two numbers are directly
 * comparable and neither depends on a remembered baseline file.
 *
 * Corpus: every piece of user-facing markdown in the repository — docs, root
 * files (README, CHANGELOG, CONTRIBUTING), skills, examples, packaging and SDK
 * readmes. Real prose with real links, badge markup, fenced code, tables and
 * bold runs — the constructs the cut actually breaks. Synthetic strings would
 * let the harness pick its own difficulty, and the first cut of this harness
 * scanned `docs/` alone, which was small enough and uniform enough to report a
 * clean zero while other shapes went unmeasured.
 *
 * A "defect" is a property of the OUTPUT alone, checkable without reference to
 * intent: text that stops mid-word, an unterminated code fence, a half-written
 * link, an unmatched emphasis / inline-code delimiter, a half-written table row,
 * or a cut that lands inside an HTML tag.
 *
 * The last two matter for a reason beyond their own counts. The first five were
 * each derived from a branch of `repairTruncatedMarkdown`, so a run over them
 * can only ever confirm that the repair does what it says — it cannot discover a
 * shape the repair never considered. `truncated_table_row` and `cut_html_tag`
 * are derived from markdown, not from the repair, and are the part of this
 * harness able to report bad news.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { truncateAtBoundary } from '../../src/search/truncate.js';

const KEY_FINDING_LEN = 280;
const TRADEOFF_LEN = 280;
const PASSAGE_LEN = 500;

/** Directories with no user-facing prose in them, or not ours to score. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', '.claude', 'dist', 'coverage',
  'internal-docs', 'fixtures', 'venv', 'build',
]);

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
  truncated_table_row: number;
  cut_html_tag: number;
  orphan_heading: number;
  orphan_reference: number;
}

const EMPTY: Defects = {
  mid_word: 0, dangling_fence: 0, broken_link: 0, dangling_bold: 0, dangling_code: 0,
  truncated_table_row: 0, cut_html_tag: 0, orphan_heading: 0, orphan_reference: 0,
};

const KEYS = Object.keys(EMPTY) as Array<keyof Defects>;

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

  // Brackets, pipes and angle brackets inside a fenced code block are literal
  // characters, not markup. Scoring them as broken markup is the same false
  // positive as reading an asterisk inside a code span as emphasis.
  const prose = out.replace(/```[\s\S]*?```/g, '');

  // broken link: an opening bracket with no completed `](...)` after it.
  const lastOpen = prose.lastIndexOf('[');
  if (lastOpen !== -1 && !/^!?\[[^\]]*\]\([^)]*\)/.test(prose.slice(lastOpen))) {
    // A bare `[N]` citation marker is legitimate and not a broken link.
    if (!/^\[[^\]]*\]/.test(prose.slice(lastOpen))) d.broken_link = 1;
  }

  // NOT derived from the repair. A markdown table row is `| a | b |`; a body
  // whose last line opens a row and never closes it renders as a stray pipe run
  // glued onto the previous cell.
  const lines = body.split('\n');
  const lastLine = lines[lines.length - 1].trimEnd();
  if (/^\s*\|/.test(lastLine) && !lastLine.endsWith('|')) d.truncated_table_row = 1;

  // NOT derived from the repair either. A cut inside `<a href="htt` leaves an
  // unterminated tag that swallows whatever a renderer puts after it. Requires a
  // name character right after `<` so `a < b` and `Array<T>` do not fire.
  if (/<[A-Za-z/][^<>]*$/.test(prose)) d.cut_html_tag = 1;

  // The two below are the harness's standing channel for bad news: neither has a
  // branch in repairTruncatedMarkdown, and neither is repaired. A number that
  // only ever comes back zero has stopped being a measurement, so at least one
  // predicate has to be able to disagree with the fix — and this one does: the
  // boundary-aware rule ends on a heading far more often than the raw slice did,
  // because backing up to a boundary frequently lands just past one.
  //
  // It is measured and left alone on evidence, not on preference. Dropping the
  // trailing heading would empty 14 of the 24 affected outputs completely, i.e.
  // it trades a heading that truthfully says where the text stopped for no
  // content at all in most cases.
  //
  // orphan heading: the body ends on a heading, so it promises a section and
  // delivers nothing.
  if (/(^|\n)#{1,6} [^\n]*$/.test(body.trimEnd())) d.orphan_heading = 1;

  // orphan reference: a `[text][id]` link whose `[id]: url` definition was cut
  // away, so the link renders as literal brackets.
  for (const m of prose.matchAll(/\[[^\]\n]+\]\[([^\]\n]+)\]/g)) {
    if (!new RegExp(`^\\s*\\[${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]:`, 'm').test(prose)) {
      d.orphan_reference = 1;
      break;
    }
  }

  return d;
}

function add(a: Defects, b: Defects): Defects {
  const out = { ...EMPTY };
  for (const k of KEYS) out[k] = a[k] + b[k];
  return out;
}

function total(d: Defects): number {
  return KEYS.reduce((sum, k) => sum + d[k], 0);
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

function collectMarkdown(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') && entry !== '.github') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collectMarkdown(full, acc);
    } else if (entry.endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

function main(): void {
  const files = collectMarkdown(process.cwd(), []).sort();

  const segments: Array<{ text: string; cap: number; kind: string }> = [];
  for (const f of files) {
    const md = readFileSync(f, 'utf8');
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
  const survivors: string[] = [];

  for (const seg of truncated) {
    const o = oldCut(seg.text, seg.cap, '…');
    const n = truncateAtBoundary(seg.text, seg.cap);
    const od = scoreOne(seg.text, o, '…');
    const nd = scoreOne(seg.text, n, '…');
    oldTotals = add(oldTotals, od);
    newTotals = add(newTotals, nd);
    if (total(od) > 0) oldBad++;
    if (total(nd) > 0) {
      newBad++;
      const which = KEYS.filter((k) => nd[k] > 0).join(',');
      survivors.push(`  [${which}] ${JSON.stringify(n.slice(-90))}`);
    }
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
  row('truncated table row*', oldTotals.truncated_table_row, newTotals.truncated_table_row);
  row('cut html tag*', oldTotals.cut_html_tag, newTotals.cut_html_tag);
  row('orphan heading*+', oldTotals.orphan_heading, newTotals.orphan_heading);
  row('orphan reference*+', oldTotals.orphan_reference, newTotals.orphan_reference);
  lines.push('  * predicate not derived from repairTruncatedMarkdown');
  lines.push('  + measured but deliberately NOT repaired — see scoreOne');
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
    `${((oldChars - newChars) / n).toFixed(1)} chars/segment given up)`,
  );
  lines.push(`segments reduced to empty by the new rule: ${emptied}`);
  if (survivors.length > 0) {
    lines.push('');
    lines.push('surviving defects in NEW output:');
    lines.push(...survivors.slice(0, 40));
    if (survivors.length > 40) lines.push(`  ... and ${survivors.length - 40} more`);
  }

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
      retained_pct: Number(((newChars / oldChars) * 100).toFixed(1)),
      emptied,
    }, null, 2) + '\n');
  }
}

main();
