import { describe, it, expect } from 'vitest';
import { hashArtifact } from '../../../../src/studio/capture/hash.js';

describe('studio/capture/hashArtifact', () => {
  it('1a — namespaces by type: the same content under different types hashes differently', () => {
    expect(hashArtifact('note', 'X')).not.toBe(hashArtifact('clip', 'X'));
  });

  it('1b — the \\0 separator makes type/parts boundaries unambiguous', () => {
    // The inputs need not be real artifact types; this pins the helper's
    // separator contract. Naive concatenation yields 'notefoo' for both
    // ('note'+'foo' and 'not'+'efoo'), so a plain join would collide. The \0
    // separator keeps them distinct. This matters because the artifact-type
    // vocabulary is slated to grow, so prefix-freeness is not a durable invariant.
    expect(hashArtifact('note', 'foo')).not.toBe(hashArtifact('not', 'efoo'));
  });

  it('1c — deterministic: the same (type, ...parts) always yields the same hash', () => {
    const a = hashArtifact('clip', 'alpha', 'beta');
    const b = hashArtifact('clip', 'alpha', 'beta');
    expect(a).toBe(b);
  });
});
