import { describe, it, expect } from 'vitest';
import {
  applyFooter,
  isFooterBlock,
  renderFooter,
  watchLink,
  FOOTER_HEADER_PATTERN,
  NO_RUN_FOOTER,
  type FooterFields,
} from '../../../src/daemon/studio-footer.js';
import { PAGE_CHANGED_BY_HUMAN } from '../../../src/studio/perception/held-snapshot.js';
import type { McpToolResult } from '../../../src/daemon/studio-dispatch.js';

/**
 * SD2 §4.4 — the result footer. Law 9: no plugin is required, so the text a tool returns IS the
 * interface for a terminal user. These rows are about the DESIGNED text: which lines exist, which
 * are conditional, and what phrasing is allowed to change (the imperatives) versus what it is not
 * (every field, every value, every number).
 */

const FULL: FooterFields = {
  runId: '7fq2',
  driverName: 'cli (claude-code)',
  tabs: 2,
  humanMessages: 1,
  pageChanged: true,
  approval: 'Allow the purchase of one monitor?',
  assertionFailed: 'price is visible',
  spendUsd: 0.42,
  browserActions: 3,
};

const lines = (fields: FooterFields, phrasing: 'mcp-tools' | 'generic' = 'generic') =>
  renderFooter(fields, phrasing).split('\n');

describe('§4.2 — the template, field by field', () => {
  it('renders the header, then the four conditionals, then cost — in that order', () => {
    expect(lines(FULL)).toEqual([
      '— run 7fq2 · driver cli (claude-code) · tab 2 —',
      '  human msgs: 1',
      `  page changed: yes — ${PAGE_CHANGED_BY_HUMAN} the page`,
      '  approval: Allow the purchase of one monitor? — resolve from any surface, or answer here',
      '  assertion failed: price is visible',
      '  cost so far: $0.42 · 3 browser actions · watch: wigolo.studio/r/7fq2',
    ]);
  });

  it('the four conditional lines are ABSENT when they have nothing to say — a permanent `no` is noise (A-51-6)', () => {
    const quiet = lines({ runId: '7fq2', driverName: 'human', tabs: 1, humanMessages: 0, pageChanged: false });
    expect(quiet).toEqual([
      '— run 7fq2 · driver human · tab 1 —',
      '  cost so far: $0.00 · 0 browser actions · watch: wigolo.studio/r/7fq2',
    ]);
  });

  it('always carries run, driver, tab count and the watch link — the four §4.2 calls "always"', () => {
    const always = renderFooter({ runId: 'abcd', driverName: 'sdk (wigolo-sdk)', tabs: 0 });
    expect(always).toContain('run abcd');
    expect(always).toContain('driver sdk (wigolo-sdk)');
    expect(always).toContain('tab 0');
    expect(always).toContain(`watch: ${watchLink('abcd')}`);
  });

  it('§7 row 1 words are quoted VERBATIM, in both registers — the tail is phrasing, the constant is contract', () => {
    for (const phrasing of ['mcp-tools', 'generic'] as const) {
      const changed = lines({ ...FULL, pageChanged: true }, phrasing).find((l) => l.includes('page changed'));
      expect(changed).toContain(PAGE_CHANGED_BY_HUMAN);
    }
  });

  it('a multi-line human prompt is flattened — the footer is line-oriented and a prompt is human-authored', () => {
    const withPrompt = lines({ ...FULL, approval: 'Allow this?\n\n  It costs money.' });
    expect(withPrompt.filter((l) => l.startsWith('  approval:'))).toEqual([
      '  approval: Allow this? It costs money. — resolve from any surface, or answer here',
    ]);
  });
});

describe('cost so far — states what it counts, never a fabricated number (#56 AC)', () => {
  it('names the unit of the action count, so the number is readable without a changelog', () => {
    expect(renderFooter({ runId: 'r1', driverName: 'cli', tabs: 1, browserActions: 12 }))
      .toContain('12 browser actions');
  });

  it('renders $0.00 when nothing has been recorded — the honest answer, not an estimate', () => {
    expect(renderFooter({ runId: 'r1', driverName: 'cli', tabs: 1 })).toContain('cost so far: $0.00 · 0 browser actions');
  });

  it('never invents a number from a nonsense input: NaN and negatives read as nothing recorded', () => {
    const odd = renderFooter({ runId: 'r1', driverName: 'cli', tabs: 1, spendUsd: Number.NaN, browserActions: -5 });
    expect(odd).toContain('cost so far: $0.00 · 0 browser actions');
  });

  it('BYOK spend shows to the cent when the log holds it', () => {
    expect(renderFooter({ runId: 'r1', driverName: 'cli', tabs: 1, spendUsd: 1.5 })).toContain('$1.50');
  });
});

describe('phrasing tailors the imperatives and NOTHING else (§4.2, law 5)', () => {
  const mcp = lines(FULL, 'mcp-tools');
  const generic = lines(FULL, 'generic');

  it('the two registers differ ONLY in the imperative tails', () => {
    expect(mcp).toHaveLength(generic.length);
    const differing = mcp.filter((line, i) => line !== generic[i]);
    expect(differing).toEqual([
      `  page changed: yes — ${PAGE_CHANGED_BY_HUMAN} with studio_observe`,
      '  approval: Allow the purchase of one monitor? — resolve from the panel, or answer here',
    ]);
  });

  it('every field, value and number is IDENTICAL across registers — content is content', () => {
    const stripImperative = (l: string) => l.split(' — ')[0];
    expect(mcp.map(stripImperative)).toEqual(generic.map(stripImperative));
  });

  it('an unmapped client gets the tool-agnostic register and is not degraded by it', () => {
    // `generic` is the default, and it carries the same six lines the named register does.
    expect(renderFooter(FULL).split('\n')).toHaveLength(6);
  });
});

describe('the no-run footer (§4.1 exception)', () => {
  it('a result minted before any run exists says so, and invents no cost or watch link', () => {
    expect(renderFooter({})).toBe(NO_RUN_FOOTER);
    expect(renderFooter({ runId: '   ' })).toBe(NO_RUN_FOOTER);
    expect(renderFooter({})).not.toContain('watch:');
    expect(renderFooter({})).not.toContain('$');
  });

  it('is recognised as a footer block, so a re-render replaces it rather than stacking', () => {
    expect(isFooterBlock({ type: 'text', text: NO_RUN_FOOTER })).toBe(true);
  });
});

describe('the footer grammar is recognisable — what the coverage test keys on', () => {
  it('matches a rendered header and never the JSON block beside it', () => {
    expect(FOOTER_HEADER_PATTERN.test('— run 7fq2 · driver cli (claude-code) · tab 2 —')).toBe(true);
    expect(FOOTER_HEADER_PATTERN.test(NO_RUN_FOOTER)).toBe(true);
    expect(isFooterBlock({ type: 'text', text: '{\n  "ok": true\n}' })).toBe(false);
    expect(isFooterBlock({ type: 'text', text: 'run 7fq2' })).toBe(false);
    expect(isFooterBlock(undefined)).toBe(false);
  });
});

describe('applyFooter — content[0] is untouched, the footer is content[1], never stacked', () => {
  const data: McpToolResult = { content: [{ type: 'text', text: '{"ok":true}' }], isError: false };

  it('appends as the SECOND block and leaves the parsed block byte-for-byte', () => {
    const out = applyFooter(data, renderFooter(FULL));
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toEqual(data.content[0]);
    expect(out.content[1]!.text.split('\n')[0]).toBe('— run 7fq2 · driver cli (claude-code) · tab 2 —');
    expect(out.isError).toBe(false);
  });

  it('REPLACES an existing footer — a result re-rendered after delivery shows one footer, not two', () => {
    const once = applyFooter(data, renderFooter({ ...FULL, humanMessages: 0 }));
    const twice = applyFooter(once, renderFooter({ ...FULL, humanMessages: 2 }));
    expect(twice.content).toHaveLength(2);
    expect(twice.content[1]!.text).toContain('human msgs: 2');
    expect(twice.content[1]!.text).not.toContain('human msgs: 0');
  });

  it('preserves isError — an error result is still a result, and deserves the run id MORE, not less', () => {
    const refused = applyFooter({ content: [{ type: 'text', text: '{"error_reason":"x"}' }], isError: true }, renderFooter(FULL));
    expect(refused.isError).toBe(true);
    expect(refused.content).toHaveLength(2);
  });
});
