import { describe, it, expect } from 'vitest';
import { resolveNodePath } from '../../../src/studio/mark/pick.js';
import type { DomNode } from '../../../src/studio/perception/snapshot.js';

// #document → <html>(be2) → [<head>(be3), <body>(be4)]; body → [<div>(be5), <div>(be6)]; div6 → [#text, <button>(be7)]
const tree: DomNode = {
  nodeName: '#document', nodeType: 9, backendNodeId: 1, children: [
    { nodeName: 'HTML', localName: 'html', nodeType: 1, backendNodeId: 2, children: [
      { nodeName: 'HEAD', localName: 'head', nodeType: 1, backendNodeId: 3, children: [] },
      { nodeName: 'BODY', localName: 'body', nodeType: 1, backendNodeId: 4, children: [
        { nodeName: 'DIV', localName: 'div', nodeType: 1, backendNodeId: 5, children: [] },
        { nodeName: 'DIV', localName: 'div', nodeType: 1, backendNodeId: 6, children: [
          { nodeName: '#text', nodeType: 3, backendNodeId: 99, children: [] }, // text node — skipped
          { nodeName: 'BUTTON', localName: 'button', nodeType: 1, backendNodeId: 7, children: [] },
        ] },
      ] },
    ] },
  ],
};

describe('resolveNodePath — element-child-index walk (pure)', () => {
  it('resolves the deep button by its element path (text nodes skipped)', () => {
    // path relative to documentElement (<html>): body = html.children[1], div6 = body.children[1], button = div6.children[0] (text skipped)
    expect(resolveNodePath(tree, [1, 1, 0])).toBe(7);
  });

  it('resolves the first sibling div', () => {
    expect(resolveNodePath(tree, [1, 0])).toBe(5);
  });

  it('returns null on an out-of-range index (DOM drifted since pick)', () => {
    expect(resolveNodePath(tree, [1, 9])).toBeNull();
  });

  it('returns null on an empty/undefined root', () => {
    expect(resolveNodePath(undefined, [0])).toBeNull();
  });

  it('empty path resolves documentElement itself (the host layer rejects empty paths as marks)', () => {
    expect(resolveNodePath(tree, [])).toBe(2);
  });

  it('a DOCTYPE in the root does not shift the root index (nodeType-strict element filter)', () => {
    const withDoctype: DomNode = {
      ...tree,
      children: [{ nodeName: 'html', nodeType: 10, backendNodeId: 50, children: [] }, ...(tree.children ?? [])],
    };
    // DOCTYPE (nodeType 10) is skipped → documentElement is still be=2, so [1,0] still reaches the first div (be5).
    expect(resolveNodePath(withDoctype, [1, 0])).toBe(5);
  });
});
