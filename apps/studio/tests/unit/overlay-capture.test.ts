// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { serializeQuote } from '../../src/preload/overlay-core';

/** P3 T3 — the pure quote-capture serializer (⌘⇧C). The DOM-event/IPC wiring in overlay.ts is exercised
 *  in the headed e2e lane; the text + context extraction is pinned here under jsdom. */
describe('serializeQuote — human quote capture', () => {
  it('captures trimmed selection text + url + nearest-block context', () => {
    document.body.innerHTML = '<article><p id="p">The <b>quick</b> brown fox jumps.</p></article>';
    const textNode = document.getElementById('p')!.firstChild!;
    const q = serializeQuote({ text: '  quick   brown  ', anchorNode: textNode }, 'https://ex.com/a');
    expect(q).toEqual({ text: 'quick brown', url: 'https://ex.com/a', context: 'The quick brown fox jumps.' });
  });

  it('returns null on an empty selection (nothing to capture)', () => {
    expect(serializeQuote({ text: '   ', anchorNode: document.body }, 'https://x')).toBeNull();
  });

  it('caps text at 2000 and context at 4000', () => {
    const big = 'x'.repeat(5000);
    document.body.innerHTML = `<div id="d">${big}</div>`;
    const q = serializeQuote({ text: big, anchorNode: document.getElementById('d')!.firstChild }, 'u')!;
    expect(q.text).toHaveLength(2000);
    expect(q.context).toHaveLength(4000);
  });

  it('falls back to the element ancestor when no block container matches', () => {
    document.body.innerHTML = '<span id="s">inline text</span>';
    const q = serializeQuote({ text: 'inline', anchorNode: document.getElementById('s') }, 'u')!;
    expect(q.context).toContain('inline text');
  });
});
