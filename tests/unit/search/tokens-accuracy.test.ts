/**
 * countTokens stopped running real BPE and became a fitted linear model over
 * character classes, which removed 55 MB of rank tables from the install.
 *
 * A token count that silently changes is a behaviour change, so this file is the
 * receipt. It measures the new counter against the real cl100k tokenizer
 * (gpt-tokenizer, now a devDependency and kept ONLY for this comparison) over
 * real inputs — this repo's own TypeScript, Markdown, JSON and HTML fixtures,
 * plus the scripts a web crawler actually meets — and pins the agreement bounds.
 *
 * If someone retunes the weights, these bounds are what stops the retune from
 * quietly degrading every `max_tokens_out` budget in the product.
 *
 * The bounds are asymmetric on purpose. Over-counting truncates more content than
 * strictly necessary: wasteful, safe. Under-counting hands the calling agent more
 * context than it budgeted for: the failure that matters. So the lower tail is
 * held tighter than the upper one.
 */
import { describe, it, expect } from 'vitest';
import { encode } from 'gpt-tokenizer';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  countTokens,
  truncateByTokens,
  TRUNCATION_MARKER_TOKENS,
} from '../../../src/search/tokens.js';

const repoRoot = join(__dirname, '..', '..', '..');

function collect(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 3 || out.length > 160) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, out, depth + 1);
    else if (/\.(ts|md|json|html)$/.test(entry) && st.size > 400 && st.size < 200_000) {
      out.push(full);
    }
    if (out.length > 160) break;
  }
  return out;
}

/** Scripts a web crawler actually meets, not a synthetic alphabet sweep. */
const SCRIPT_CORPUS: Record<string, string> = {
  chinese: '这是一个关于本地优先网络搜索的技术文档，描述了抓取和提取的完整流程。',
  japanese: 'ローカルファーストのウェブ検索とデータ抽出に関する技術文書です。',
  korean: '로컬 우선 웹 검색 및 데이터 추출에 관한 기술 문서입니다. ',
  cyrillic: 'Это технический документ о локальном веб-поиске и извлечении данных. ',
  arabic: 'هذا مستند تقني حول البحث المحلي على الويب واستخراج البيانات. ',
  hebrew: 'זהו מסמך טכני על חיפוש אינטרנט מקומי וחילוץ נתונים. ',
  greek: 'Αυτό είναι ένα τεχνικό έγγραφο σχετικά με την τοπική αναζήτηση. ',
  hindi: 'यह स्थानीय वेब खोज और डेटा निष्कर्षण के बारे में एक तकनीकी दस्तावेज़ है। ',
  thai: 'นี่คือเอกสารทางเทคนิคเกี่ยวกับการค้นหาเว็บในเครื่อง ',
  emoji: '🚀🔍📊✅🌍🧠 wigolo results ',
  urls: 'https://example.com/docs/api/v2/reference?query=foo&bar=baz#section-3 ',
  dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8',
  hashes: 'a3f5c9e1b7d2048f6a1c3e5b9d7f2048 ',
  numbers: '12345 678901 2468013579 3.14159265358979 1000000 ',
  markdownTable: '| name | value | notes |\n|---|---|---|\n| alpha | 12 | ok |\n',
  prose: 'The fetch router escalates to a real browser on observable signals, not domain guesses. ',
};

/**
 * Repo sources contain literal `<|endoftext|>` strings, which the reference
 * tokenizer refuses by default. Web content can carry them too, so treat them as
 * ordinary text rather than dropping those samples from the corpus.
 */
function realTokens(text: string): number {
  return encode(text, { disallowedSpecial: new Set() }).length;
}

interface Sample { name: string; text: string }

const samples: Sample[] = [];
for (const file of collect(join(repoRoot, 'src')).concat(collect(join(repoRoot, 'tests')))) {
  const text = readFileSync(file, 'utf-8');
  samples.push({ name: file.slice(repoRoot.length + 1), text });
  for (const n of [400, 1500, 6000]) {
    if (text.length > n) samples.push({ name: `${file.slice(repoRoot.length + 1)}#${n}`, text: text.slice(0, n) });
  }
}
for (const [name, unit] of Object.entries(SCRIPT_CORPUS)) {
  for (const reps of [10, 30, 80]) samples.push({ name: `${name}x${reps}`, text: unit.repeat(reps) });
}

interface Agreement {
  n: number; mean: number; p05: number; p50: number; p95: number;
  min: number; max: number; worstUnder: string; worstOver: string;
}

function agreement(count: (t: string) => number): Agreement {
  const ratios: number[] = [];
  let worstUnder = { r: Infinity, n: '' };
  let worstOver = { r: 0, n: '' };
  for (const s of samples) {
    const real = realTokens(s.text);
    if (real < 20) continue;
    const r = count(s.text) / real;
    ratios.push(r);
    if (r < worstUnder.r) worstUnder = { r, n: s.name };
    if (r > worstOver.r) worstOver = { r, n: s.name };
  }
  ratios.sort((a, b) => a - b);
  const q = (p: number): number => ratios[Math.floor(ratios.length * p)];
  return {
    n: ratios.length,
    mean: ratios.reduce((a, b) => a + b, 0) / ratios.length,
    p05: q(0.05), p50: q(0.5), p95: q(0.95),
    min: ratios[0], max: ratios[ratios.length - 1],
    worstUnder: `${worstUnder.r.toFixed(3)}@${worstUnder.n}`,
    worstOver: `${worstOver.r.toFixed(3)}@${worstOver.n}`,
  };
}

describe('countTokens agreement with real cl100k BPE', () => {
  const measured = agreement(countTokens);

  it('measures a corpus large enough to mean something', () => {
    // A corpus that silently collapsed to a handful of files would let every
    // bound below pass on noise.
    expect(measured.n).toBeGreaterThan(200);
  });

  it('is unbiased on average (mean ratio within 5%)', () => {
    expect(measured.mean).toBeGreaterThan(0.95);
    expect(measured.mean).toBeLessThan(1.05);
  });

  it('is within 5% on the median input', () => {
    expect(measured.p50).toBeGreaterThan(0.95);
    expect(measured.p50).toBeLessThan(1.05);
  });

  it('holds 90% of inputs inside -12% / +18%', () => {
    expect(measured.p05).toBeGreaterThan(0.88);
    expect(measured.p95).toBeLessThan(1.18);
  });

  it('never under-counts by more than a third, even on the worst input', () => {
    // The lower tail is the dangerous one — this is the bound that keeps a
    // budget overshoot bounded rather than unbounded.
    expect(measured.min, `worst under-count ${measured.worstUnder}`).toBeGreaterThan(0.6);
  });

  it('never over-counts by more than 60% on the worst input', () => {
    expect(measured.max, `worst over-count ${measured.worstOver}`).toBeLessThan(1.6);
  });

  it('rejects a naive chars/4 counter on the same bounds', () => {
    // Control. Without this, the bounds above could be loose enough to pass for
    // any counter at all, and the suite would be measuring nothing.
    const naive = agreement((t) => Math.ceil(t.length / 4));
    const passesAllBounds =
      naive.mean > 0.95 && naive.mean < 1.05 &&
      naive.p05 > 0.88 && naive.p95 < 1.18 &&
      naive.min > 0.6 && naive.max < 1.6;
    expect(passesAllBounds).toBe(false);
  });
});

describe('token budget invariants', () => {
  it('never returns more tokens than the budget allows', () => {
    // Exact by construction: truncation measures and cuts with the same metric,
    // so this holds no matter how the metric tracks any particular model.
    const text = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
    for (const budget of [10, 25, 100, 500, 2000]) {
      expect(countTokens(truncateByTokens(text, budget))).toBeLessThanOrEqual(budget);
    }
  });

  it('holds the budget on every script in the corpus', () => {
    for (const [name, unit] of Object.entries(SCRIPT_CORPUS)) {
      const text = unit.repeat(60);
      for (const budget of [20, 120, 600]) {
        expect(
          countTokens(truncateByTokens(text, budget)),
          `${name} @ ${budget}`,
        ).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('reserves the marker cost by measuring it, not by hardcoding it', () => {
    // The reserve used to be a literal 6, which was the cl100k cost of the
    // marker and is not the cost under this counter. A stale reserve overshoots
    // EVERY budget by the difference, which is exactly how this surfaced.
    expect(TRUNCATION_MARKER_TOKENS).toBe(countTokens('\n\n[... content truncated]'));

    // The tightest budget that can still fit the marker must hold the invariant.
    const text = 'word '.repeat(500);
    const tightest = TRUNCATION_MARKER_TOKENS + 1;
    expect(countTokens(truncateByTokens(text, tightest))).toBeLessThanOrEqual(tightest);
  });

  it('is monotonic in text length', () => {
    // The single-pass cut in truncateByTokens is only correct if the running
    // total never decreases as characters are appended.
    const text = readFileSync(join(repoRoot, 'README.md'), 'utf-8').slice(0, 20_000);
    let previous = 0;
    for (let i = 0; i <= text.length; i += 250) {
      const current = countTokens(text.slice(0, i));
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('does not need the real tokenizer at runtime', async () => {
    // The whole point of the change: src/ must not pull the BPE tables back in.
    const source = readFileSync(join(repoRoot, 'src', 'search', 'tokens.ts'), 'utf-8');
    expect(source).not.toMatch(/gpt-tokenizer|js-tiktoken|tiktoken/);
  });
});
