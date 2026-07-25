import { describe, it, expect, beforeEach } from 'vitest';
import { getEmbedderStatus } from '../../../src/embedding/embedder-status.js';
import { expectedTokenizerBinding } from '../../../src/cli/doctor.js';

/**
 * WHY: #231 — when the native tokenizer binding is absent the embedding model
 * fails to load and search drops to rerank-only ranking. That degradation used
 * to be invisible outside a daemon log line. These rows pin that it is now
 * reported exactly once per degradation, and that the platform→binding mapping
 * covers the arm64 case that started it.
 */

describe('embedder status', () => {
  beforeEach(() => {
    getEmbedderStatus().reset();
  });

  it('starts unknown and stays quiet — a daemon that has not needed the model yet is not degraded', () => {
    const status = getEmbedderStatus();

    expect(status.state).toBe('unknown');
    expect(status.consumeWarning()).toBeUndefined();
  });

  it('reports a failure once, then stays quiet so every response is not spammed', () => {
    const status = getEmbedderStatus();
    status.markUnavailable('tokenizer binding missing');

    const first = status.consumeWarning();
    expect(first).toContain('Vector-similarity ranking is inactive');
    expect(first).toContain('tokenizer binding missing');
    expect(first).toContain('wigolo warmup --embeddings');

    expect(status.consumeWarning()).toBeUndefined();
  });

  it('stays quiet when the same failure repeats', () => {
    const status = getEmbedderStatus();
    status.markUnavailable('same reason');
    expect(status.consumeWarning()).toBeDefined();

    status.markUnavailable('same reason');
    expect(status.consumeWarning()).toBeUndefined();
  });

  it('re-arms when the failure changes, so a new problem is not masked by an old one', () => {
    const status = getEmbedderStatus();
    status.markUnavailable('first reason');
    status.consumeWarning();

    status.markUnavailable('a different reason');

    expect(status.consumeWarning()).toContain('a different reason');
  });

  it('goes quiet once the model loads', () => {
    const status = getEmbedderStatus();
    status.markUnavailable('transient');
    status.markReady();

    expect(status.state).toBe('ready');
    expect(status.consumeWarning()).toBeUndefined();
  });
});

describe('expectedTokenizerBinding', () => {
  it('maps linux arm64 to the binding that was missing from the container', () => {
    expect(expectedTokenizerBinding('linux', 'arm64')).toBe('@anush008/tokenizers-linux-arm64-gnu');
  });

  it('maps the platforms that do ship a prebuilt', () => {
    expect(expectedTokenizerBinding('linux', 'x64')).toBe('@anush008/tokenizers-linux-x64-gnu');
    expect(expectedTokenizerBinding('darwin', 'arm64')).toBe('@anush008/tokenizers-darwin-universal');
    expect(expectedTokenizerBinding('win32', 'x64')).toBe('@anush008/tokenizers-win32-x64-msvc');
  });

  it('returns nothing for a platform with no published binding', () => {
    expect(expectedTokenizerBinding('freebsd', 'x64')).toBeUndefined();
    expect(expectedTokenizerBinding('win32', 'arm64')).toBeUndefined();
  });
});
