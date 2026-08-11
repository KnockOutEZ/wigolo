import { describe, it, expect } from 'vitest';
import { truncateAtBoundary, repairTruncatedMarkdown } from '../../../src/search/truncate.js';
import { countTokens, TRUNCATION_MARKER_TOKENS } from '../../../src/search/tokens.js';
import { truncateSmartly } from '../../../src/search/truncate.js';

/**
 * P4c — the research brief cuts prose to fixed char caps (key findings at 280,
 * tradeoffs at 280, highlight passages at 500) with a bare `.slice()`. That
 * lands mid-word, and on markdown it lands mid-link and mid-code-fence, so the
 * brief ships text like "the reconciler compares the previous fib…" and links
 * that read `[the migration guide](https://exa`. The brief is the whole
 * deliverable of the research tool, so a garbled cut is a quality defect in the
 * product, not a cosmetic one.
 *
 * The repair is deliberately SUBTRACTIVE — it only ever removes characters. An
 * additive repair (closing a dangling fence) would grow the output past the
 * budget it was just cut to, which would silently break truncateByTokens'
 * `countTokens(result) <= maxTokens` guarantee.
 */

describe('truncateAtBoundary', () => {
  it('does not cut in the middle of a word', () => {
    const text = 'The reconciler compares the previous fiber tree against the next one and reuses whatever it can.';
    const out = truncateAtBoundary(text, 50);

    expect(out.length).toBeLessThanOrEqual(50);
    // Everything before the marker must be a whole word from the source.
    const body = out.replace(/…$/, '').trimEnd();
    expect(text.startsWith(body)).toBe(true);
    const nextChar = text.slice(body.length, body.length + 1);
    expect(nextChar === '' || /\s/.test(nextChar)).toBe(true);
  });

  it('prefers a sentence boundary when one is available late in the budget', () => {
    const text = 'Hooks let you use state and lifecycle features. The reconciler then compares the previous tree against the next one.';
    const out = truncateAtBoundary(text, 60);

    expect(out).toBe('Hooks let you use state and lifecycle features.…');
  });

  it('falls back to a word boundary when the only sentence end is too early', () => {
    // The 70% floor is deliberate and matches truncateByTokens: honouring a
    // sentence end at 20% of the budget would discard most of the allowance to
    // buy a nicer stopping point. A word boundary is the correct compromise.
    const text = 'Short. The reconciler then compares the previous tree against the next one and reuses what it can.';
    const out = truncateAtBoundary(text, 40);

    expect(out.startsWith('Short. The reconciler')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns the text untouched when it already fits', () => {
    const text = 'Short enough.';
    expect(truncateAtBoundary(text, 280)).toBe('Short enough.');
  });

  it('never returns more than maxChars', () => {
    const text = 'x'.repeat(1000);
    expect(truncateAtBoundary(text, 100).length).toBeLessThanOrEqual(100);
  });

  it('never emits a body that is only the marker', () => {
    // The diet slice fixed exactly this shape in applyAggregateMarkdownBudget.
    // A cut so tight that nothing survives must return empty, not a lone "…"
    // masquerading as content.
    expect(truncateAtBoundary('some real content here', 1)).toBe('');
  });

  it('does not split a markdown link', () => {
    const text = 'See [the migration guide](https://example.com/very/long/path/to/guide) for the full story of what changed.';
    const out = truncateAtBoundary(text, 45);

    expect(out).not.toContain('](http');
    expect(out).not.toMatch(/\[[^\]]*$/);
  });

  it('does not leave an unterminated code fence', () => {
    const text = 'Install it first.\n\n```bash\nnpm install wigolo --save-dev --workspaces\n```\n\nThen run it.';
    const out = truncateAtBoundary(text, 60);

    const fences = (out.match(/```/g) ?? []).length;
    expect(fences % 2).toBe(0);
  });

  it('does not leave dangling bold markers', () => {
    const text = 'The key point is that **the reconciler reuses fibers whenever the element type matches** exactly.';
    const out = truncateAtBoundary(text, 60);

    expect((out.match(/\*\*/g) ?? []).length % 2).toBe(0);
  });
});

describe('repairTruncatedMarkdown', () => {
  it('is subtractive — never grows the input', () => {
    const cases = [
      'text with ```js\nconst a = 1;',
      'a [link](http',
      'some **bold',
      'inline `code',
      'perfectly fine text',
      '```js\nconst a = 1;\n```\ndone',
    ];
    for (const c of cases) {
      expect(repairTruncatedMarkdown(c).length).toBeLessThanOrEqual(c.length);
    }
  });

  it('leaves well-formed markdown alone', () => {
    const ok = 'A paragraph with a [link](https://example.com), **bold**, and `code`.\n\n```js\nconst a = 1;\n```';
    expect(repairTruncatedMarkdown(ok)).toBe(ok);
  });

  // Over-fire guard. The first cut of this repair asked "is the last `[` the
  // start of a COMPLETE inline link?" and deleted the remainder when it was
  // not. That is true of every citation marker, reference-style link and array
  // literal in prose, so well-formed text lost everything from the bracket on.
  // The predicate has to be "is this bracket genuinely unterminated", not "is
  // this bracket an inline link".
  it('leaves a bare citation marker alone', () => {
    const s = 'According to the research [1] this holds for every case.';
    expect(repairTruncatedMarkdown(s)).toBe(s);
  });

  it('leaves an array literal in prose alone', () => {
    const s = 'Set the option to [a, b, c] and restart the daemon.';
    expect(repairTruncatedMarkdown(s)).toBe(s);
  });

  it('leaves a reference-style link alone', () => {
    const s = 'See the [migration guide][mg] for details.';
    expect(repairTruncatedMarkdown(s)).toBe(s);
  });

  it('still drops a genuinely unterminated bracket', () => {
    expect(repairTruncatedMarkdown('A dangling open bracket [like this')).toBe('A dangling open bracket');
  });

  it('still drops a half-written inline link', () => {
    expect(repairTruncatedMarkdown('See [the guide](https://ex')).toBe('See');
  });

  it('drops an unclosed fence and everything inside it', () => {
    const out = repairTruncatedMarkdown('Intro paragraph.\n\n```bash\nnpm install');
    expect(out).not.toContain('```');
    expect(out).toContain('Intro paragraph.');
  });
});

describe('the diet slice fixes still hold', () => {
  it('TRUNCATION_MARKER_TOKENS is still measured, not hardcoded', () => {
    expect(TRUNCATION_MARKER_TOKENS).toBe(countTokens('\n\n[... content truncated]'));
  });

  it('truncateSmartly still appends the marker and respects paragraph breaks', () => {
    const text = 'First paragraph here.\n\nSecond paragraph that runs on well past the cap and keeps going.';
    const out = truncateSmartly(text, 40);
    expect(out).toContain('[... content truncated]');
  });

  it('truncateSmartly no longer leaves an unterminated fence', () => {
    const text = 'Intro.\n\n```bash\nnpm install wigolo --save-dev --workspaces --foreground-scripts\n```\n\nDone.';
    const out = truncateSmartly(text, 50);
    const fences = (out.match(/```/g) ?? []).length;
    expect(fences % 2).toBe(0);
  });
});
