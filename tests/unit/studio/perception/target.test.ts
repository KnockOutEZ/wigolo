import { describe, it, expect } from 'vitest';
import { buildTarget } from '../../../../src/studio/mark/target.js';
import { computeFingerprint } from '../../../../src/studio/perception/id.js';
import type { AxNode, DomNode } from '../../../../src/studio/perception/snapshot.js';

// body > div.card > button[type=submit][data-id=x]   (the marked button is backendNodeId 3)
const DOM: DomNode = {
  backendNodeId: 1,
  localName: 'body',
  children: [
    {
      backendNodeId: 2,
      localName: 'div',
      attributes: ['class', 'card'],
      children: [{ backendNodeId: 3, localName: 'button', attributes: ['type', 'submit', 'data-id', 'x'], children: [] }],
    },
  ],
};
const AX: AxNode[] = [{ backendDOMNodeId: 3, role: { value: 'button' }, name: { value: 'Buy' } }];

describe('buildTarget — structured target from a marked node', () => {
  it('builds {role, name, fingerprint, ancestorPath, attrs} for the marked backend node', () => {
    const t = buildTarget(AX, DOM, 3);
    expect(t).not.toBeNull();
    expect(t!.backendNodeId).toBe(3);
    expect(t!.role).toBe('button');
    expect(t!.name).toBe('Buy');
    // fingerprint reuses id.ts (role+name+STABLE-attr subset: type/name/placeholder only).
    expect(t!.fingerprint).toBe(computeFingerprint({ role: 'button', name: 'Buy', attrs: { type: 'submit', 'data-id': 'x' } }));
    // multi-attr fingerprint keeps the FULL attr set (heal disambiguation), not just the stable subset.
    expect(t!.attrs).toEqual({ type: 'submit', 'data-id': 'x' });
    // role/name/attrs are PAGE-DERIVED (untrusted) — welded trusted:false from the start, like 2G vision.
    expect(t!.trusted).toBe(false);
  });

  it('ancestorPath is the GENERALIZED tag chain with positional indices dropped (so it matches across list siblings)', () => {
    const t = buildTarget(AX, DOM, 3);
    expect(t!.ancestorPath).toBe('body/div/button'); // no [index] segments
  });

  it('returns null for a backend node absent from the DOM (never a wrong target)', () => {
    expect(buildTarget(AX, DOM, 999)).toBeNull();
  });

  it('a marked non-interactive node (no a11y entry) still yields a target from attrs + path (role/name empty)', () => {
    const t = buildTarget(AX, DOM, 2); // the div, no AX node
    expect(t).not.toBeNull();
    expect(t!.role).toBe('');
    expect(t!.name).toBe('');
    expect(t!.attrs).toEqual({ class: 'card' });
    expect(t!.ancestorPath).toBe('body/div');
  });
});
