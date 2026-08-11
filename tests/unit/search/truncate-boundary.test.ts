import { describe, it, expect } from 'vitest';
import {
  truncateAtBoundary,
  repairTruncatedMarkdown,
  MAX_REPAIR_PASSES,
} from '../../../src/search/truncate.js';
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

  it('does not leave a half-written table row', () => {
    const text =
      '| Variable | Default | Description |\n|---|---|---|\n| `WIGOLO_CACHE_DIR` | `~/.wigolo` | Where the local cache database lives. |\n| `WIGOLO_SEARCH` | `core` | Which search backend to run. |';
    const out = truncateAtBoundary(text, 150);

    const body = out.replace(/…$/, '');
    const lastLine = body.split('\n').pop() as string;
    if (lastLine.trimStart().startsWith('|')) {
      expect(lastLine.trimEnd().endsWith('|')).toBe(true);
    }
  });

  // A source body that is nothing but one code block used to disappear entirely
  // at every budget: the repair is subtractive, so it deleted the unterminated
  // fence and there was nothing else in the body. Contributing nothing, quietly,
  // is the one outcome that is never acceptable — the caller cannot tell it from
  // a source that had no content.
  it('emits a terminated fence rather than nothing when the body is one code block', () => {
    const text = '```js\n' + 'const value = computeSomethingUseful(input);\n'.repeat(20) + '```';
    const out = truncateAtBoundary(text, 300);

    expect(out.length).toBeGreaterThan(0);
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
    expect(out).toContain('const value = computeSomethingUseful(input);');
  });

  it('keeps the re-closed fence inside the budget', () => {
    const text = '```js\n' + 'const value = computeSomethingUseful(input);\n'.repeat(40) + '```';

    for (const cap of [40, 80, 150, 300, 700]) {
      expect(truncateAtBoundary(text, cap).length, `cap ${cap}`).toBeLessThanOrEqual(cap);
    }
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

  // Rewritten from an equality assertion on one flat input. That shape passed
  // whether the repair ran once or ran to a fixed point, so it could not tell
  // the two apart — and the difference is exactly where the repair was still
  // leaving junk. The assertion is now the postcondition ("no unterminated
  // bracket survives") over inputs at increasing nesting depth.
  it('still drops a genuinely unterminated bracket, at every nesting depth', () => {
    const cases = [
      'A dangling open bracket [like this',
      'A badge [![alt](https://img.example/b',
      'Nested further [[![alt](https://img.example/b',
    ];

    for (const c of cases) {
      const out = repairTruncatedMarkdown(c);
      const lastOpen = out.lastIndexOf('[');
      if (lastOpen === -1) continue;
      const tail = out.slice(lastOpen);
      const closeIdx = tail.indexOf(']');
      const stillBroken =
        closeIdx === -1 ||
        (tail[closeIdx + 1] === '(' && !tail.slice(closeIdx + 1).includes(')'));
      expect(stillBroken, `unterminated bracket survived in ${JSON.stringify(out)}`).toBe(false);
    }
  });

  // The defect this slice exists to close. Badge markup is `[![alt](img)](url)`:
  // repairing the inner image deletes `![alt` and hands back the outer `[`,
  // which is the same class of junk one level out. A single pass shipped it.
  it('resolves nested badge markup instead of leaving the outer bracket', () => {
    const cut =
      'Downloads: [![npm downloads](https://img.shields.io/npm/dm/wigolo)](https://www.npmjs.com/package/wigolo)\n[![lic';

    expect(repairTruncatedMarkdown(cut)).toBe(
      'Downloads: [![npm downloads](https://img.shields.io/npm/dm/wigolo)](https://www.npmjs.com/package/wigolo)',
    );
  });

  // Convergence, stated as a property rather than a pass count: applying the
  // repair to its own output must change nothing. If any pass could still expose
  // work for another, this is what fails.
  it('reaches a fixed point — repairing its own output is a no-op', () => {
    const cases = [
      'Downloads: [![npm](https://img.example/a)](https://npm.example/p)\n[![lic',
      'Intro.\n\n```js\nconst a = [1, 2;',
      '| Var | Default |\n|---|---|\n| `A` | `1` |\n| `B` | some **bold',
      'See <a href="https://example.com/a"><img src="https://img.example/b',
      'A sentence with `inline code and a [link](htt',
    ];

    for (const c of cases) {
      const once = repairTruncatedMarkdown(c);
      expect(repairTruncatedMarkdown(once), `not a fixed point for ${JSON.stringify(c)}`).toBe(once);
    }
  });

  // The bound is the guard against the failure this program has already paid for
  // twice: a repair loop that never converges wedges the worker synchronously,
  // so no test timeout can fire. Termination does not depend on the ceiling —
  // every changing pass strictly shortens the string — but the ceiling has to
  // hold anyway, and it has to be small enough to be a real ceiling.
  it('is bounded — a pathological nest terminates and never grows the input', () => {
    expect(MAX_REPAIR_PASSES).toBeLessThanOrEqual(8);

    const pathological = '['.repeat(500) + 'unterminated';
    const out = repairTruncatedMarkdown(pathological);

    expect(out.length).toBeLessThanOrEqual(pathological.length);
    // Each pass strips exactly one bracket off a nest this deep, so the number
    // removed IS the number of passes that ran. Counting brackets pins the
    // assertion to the constant; counting characters does not, because the first
    // pass alone also carries away the trailing word.
    const removed = 500 - (out.match(/\[/g) ?? []).length;
    expect(removed).toBe(MAX_REPAIR_PASSES);
  });

  // Must-not-fire. The loop must not keep eating a document that is already
  // well-formed just because it now runs more than once.
  it('leaves complete badge markup alone however many passes run', () => {
    const ok =
      'Downloads: [![npm downloads](https://img.shields.io/npm/dm/wigolo)](https://www.npmjs.com/package/wigolo) and more prose.';
    expect(repairTruncatedMarkdown(ok)).toBe(ok);
  });

  it('drops a table row the cut left open', () => {
    const cut =
      '| Variable | Default | Description |\n|---|---|---|\n| `A` | `1` | First one. |\n| `B` | `2` | Second one that ran';

    expect(repairTruncatedMarkdown(cut)).toBe(
      '| Variable | Default | Description |\n|---|---|---|\n| `A` | `1` | First one. |',
    );
  });

  // Must-not-fire. A complete table's last row closes with a pipe.
  it('leaves a complete table alone', () => {
    const ok = '| A | B |\n|---|---|\n| 1 | 2 |';
    expect(repairTruncatedMarkdown(ok)).toBe(ok);
  });

  // Must-not-fire, and the reason the rule reads the style off a surviving row
  // instead of counting cells: GFM accepts rows with a leading pipe and no
  // trailing one, and every row of such a table looks truncated on its own.
  it('leaves a table whose style omits the trailing pipe alone', () => {
    const ok = '| A | B\n|---|---\n| 1 | 2\n| 3 | 4';
    expect(repairTruncatedMarkdown(ok)).toBe(ok);
  });

  it('drops a cut that landed inside an html tag', () => {
    const cut = 'Logos:\n<a href="https://example.com/x"><img src="https://img.example/y"/></a>\n<a href="https://exa';

    expect(repairTruncatedMarkdown(cut)).toBe(
      'Logos:\n<a href="https://example.com/x"><img src="https://img.example/y"/></a>',
    );
  });

  // Must-not-fire. `<` is ordinary prose punctuation and an ordinary generic.
  it('leaves comparisons and type parameters alone', () => {
    for (const ok of [
      'Set it when a < b and the queue is empty.',
      'The signature is Array<string> and nothing else.',
      'Budgets under 5 < 10 are rejected.',
    ]) {
      expect(repairTruncatedMarkdown(ok)).toBe(ok);
    }
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

  it('truncateSmartly no longer reduces a one-fence page to the marker alone', () => {
    const page = '```json\n' + '{ "key": "a reasonably long configuration value" },\n'.repeat(30) + '```';
    const out = truncateSmartly(page, 400);

    expect(out.replace('[... content truncated]', '').trim().length).toBeGreaterThan(0);
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it('truncateSmartly no longer leaves an unterminated fence', () => {
    const text = 'Intro.\n\n```bash\nnpm install wigolo --save-dev --workspaces --foreground-scripts\n```\n\nDone.';
    const out = truncateSmartly(text, 50);
    const fences = (out.match(/```/g) ?? []).length;
    expect(fences % 2).toBe(0);
  });
});
