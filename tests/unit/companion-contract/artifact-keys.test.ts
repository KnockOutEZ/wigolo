/**
 * The shared-artifact key scheme is a CONTRACT, not an implementation detail: after the
 * extraction the private capture pipeline WRITES `studio://<type>|<id>` keys and the public
 * companion provider READS them, so a drift on either side orphans every artifact already in
 * the shared vector store and `index_jobs`. These arms pin the scheme's exact string shape,
 * its parse inverse, and the researchable-type set that decides which rows can be cited.
 */
import { describe, expect, it } from 'vitest';

import {
  isStudioEmbedKey,
  makeStudioEmbedKey,
  parseStudioEmbedKey,
  isResearchableArtifactType,
  RESEARCHABLE_TYPES,
  STUDIO_EMBED_PREFIX,
} from '../../../src/companion-contract/artifact-keys.js';

describe('studio embed key scheme', () => {
  it('constructs `studio://<type>|<id>` — the exact string already on disk', () => {
    expect(makeStudioEmbedKey('clip', 7)).toBe('studio://clip|7');
    expect(makeStudioEmbedKey('qa', 42)).toBe('studio://qa|42');
    expect(makeStudioEmbedKey('note', 1)).toBe('studio://note|1');
    expect(STUDIO_EMBED_PREFIX).toBe('studio://');
  });

  it('round-trips a constructed key back to the same type and id', () => {
    for (const [type, id] of [
      ['clip', 7],
      ['qa', 999999],
      ['note', 1],
      ['mark', 12],
    ] as const) {
      expect(parseStudioEmbedKey(makeStudioEmbedKey(type, id))).toEqual({ type, id });
      expect(isStudioEmbedKey(makeStudioEmbedKey(type, id))).toBe(true);
    }
  });

  it('does NOT own a key from another provider or a real url', () => {
    for (const key of [
      'https://example.com/a',
      'http://studio.example.com/clip|1',
      'notes://clip|1',
      'clip|1',
      '',
      'STUDIO://clip|1',
    ]) {
      expect(isStudioEmbedKey(key), key).toBe(false);
      expect(parseStudioEmbedKey(key), key).toBeNull();
    }
  });

  it('rejects a malformed studio key rather than guessing a type or id', () => {
    for (const key of [
      'studio://',
      'studio://clip',
      'studio://clip|',
      'studio://|7',
      'studio://clip|0',
      'studio://clip|-3',
      'studio://clip|1.5',
      'studio://clip|abc',
    ]) {
      expect(parseStudioEmbedKey(key), key).toBeNull();
    }
  });

  it('takes the LAST separator, so a type containing `|` cannot steal the id', () => {
    expect(parseStudioEmbedKey('studio://clip|extra|7')).toEqual({ type: 'clip|extra', id: 7 });
  });

  it('the `|` keeps a key deliberately non-url-parseable (callers must branch before hydration)', () => {
    // If this ever became a parseable URL the read path could feed it to normalizeUrl and
    // silently hydrate the wrong row instead of routing it to the artifact provider.
    const key = makeStudioEmbedKey('clip', 7);
    expect(key).toContain('|');
    expect(() => new URL(key)).toThrow();
  });
});

describe('researchable artifact types', () => {
  it('pins the set to exactly clip, qa and note — a drift here orphans the corpus', () => {
    expect([...RESEARCHABLE_TYPES]).toEqual(['clip', 'qa', 'note']);
  });

  it('excludes `mark`: it has null markdown, so it can match FTS but never be a source', () => {
    expect(isResearchableArtifactType('mark')).toBe(false);
    expect(isResearchableArtifactType('screenshot')).toBe(false);
    expect(isResearchableArtifactType('')).toBe(false);
  });

  it('accepts every pinned type', () => {
    for (const type of RESEARCHABLE_TYPES) {
      expect(isResearchableArtifactType(type), type).toBe(true);
    }
  });

  it('is frozen — a consumer cannot widen the policy set at runtime', () => {
    expect(Object.isFrozen(RESEARCHABLE_TYPES)).toBe(true);
  });
});
