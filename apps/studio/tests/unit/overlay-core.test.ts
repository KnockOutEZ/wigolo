// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { elementPath, serializePayload, whiskerLabel, ancestorWalk } from '../../src/preload/overlay-core';

describe('elementPath — element-child indices from documentElement', () => {
  it('encodes a nested element as a path (text nodes ignored)', () => {
    document.body.innerHTML = '<div id="a"></div><div id="b">txt<button id="go">Buy</button></div>';
    const btn = document.getElementById('go')!;
    // body is html.children[1]; div#b is body.children[1]; button is div#b.children[0] (text ignored)
    expect(elementPath(btn)).toEqual([1, 1, 0]);
  });

  it('documentElement resolves to the empty path', () => {
    expect(elementPath(document.documentElement)).toEqual([]);
  });
});

describe('whiskerLabel — the hover label naming the element', () => {
  it('names by tag + class + trimmed text (div.plan-card · "Pro plan")', () => {
    const el = document.createElement('div');
    el.className = 'plan-card pricing';
    el.textContent = 'Pro plan';
    expect(whiskerLabel(el)).toBe('div.plan-card · "Pro plan"');
  });

  it('degrades to tag when no class/text', () => {
    expect(whiskerLabel(document.createElement('section'))).toBe('section');
  });
});

describe('ancestorWalk — ⇧/scroll climbs the ancestor chain, floors at documentElement', () => {
  it('climbs to parentElement and stops at documentElement', () => {
    document.body.innerHTML = '<div class="card"><span id="s">x</span></div>';
    const span = document.getElementById('s')!;
    const card = span.parentElement!;
    expect(ancestorWalk(span, 'up')).toBe(card);
    let cur: Element = span;
    for (let i = 0; i < 50; i++) cur = ancestorWalk(cur, 'up');
    expect(cur).toBe(document.documentElement); // never climbs past root
  });
});

describe('serializePayload — best-effort rich element payload', () => {
  it('captures tag/id/classes/attrs/data-*/text and degrades framework to null', () => {
    const el = document.createElement('button');
    el.id = 'buy';
    el.className = 'btn primary';
    el.setAttribute('data-testid', 'buy-btn');
    el.setAttribute('aria-label', 'Buy now');
    el.textContent = 'Buy';
    const p = serializePayload(el);
    expect(p.tag).toBe('button');
    expect(p.id).toBe('buy');
    expect(p.classes).toEqual(['btn', 'primary']);
    expect(p.attrs['data-testid']).toBe('buy-btn');
    expect(p.attrs['aria-label']).toBe('Buy now');
    expect(p.dataset.testid).toBe('buy-btn');
    expect(p.text).toBe('Buy');
    expect(p.component).toBeNull(); // no React fiber in jsdom → graceful degrade
    expect(p.source).toBeNull();
  });
});
