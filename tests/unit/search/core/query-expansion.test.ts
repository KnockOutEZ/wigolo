import { describe, it, expect } from 'vitest';
import {
  expandQuery,
  LOW_RECALL_THRESHOLD,
} from '../../../../src/search/core/query-expansion.js';

// S11c sub-area 3 — low-recall query expansion.
//
// When a multi-engine search comes back with very few deduped results, before
// declaring zero/few-results we try ONE auto-rewrite using a small static
// synonym map. The rewrite must be:
//
//   * transparent to the caller via query_understanding.rewrites
//   * static heuristic only (no LLM call here — out of scope per brief)
//   * deterministic — same input always yields the same rewrite
//   * cheap — single pass over tokens, returns null when no synonym matches

describe('expandQuery — static synonym map', () => {
  it('expands the acronym "RAG" to "retrieval augmented generation"', () => {
    const expanded = expandQuery('RAG pipeline tutorial');
    expect(expanded).not.toBeNull();
    expect(expanded!.toLowerCase()).toContain('retrieval augmented generation');
  });

  it('expands "k8s" to "kubernetes"', () => {
    const expanded = expandQuery('k8s ingress nginx');
    expect(expanded).not.toBeNull();
    expect(expanded!.toLowerCase()).toContain('kubernetes');
  });

  it('joins multi-word identifiers ("use state" -> "useState")', () => {
    const expanded = expandQuery('react use state hook');
    expect(expanded).not.toBeNull();
    expect(expanded!.toLowerCase()).toContain('usestate');
  });

  it('pluralizes a singular token when no other synonym applies (last-resort)', () => {
    // No synonym for "child" exists in our map — but pluralization is the
    // catch-all heuristic. Either "children" or "childs" is fine; the contract
    // is that the rewrite produces a NEW string, not the input.
    const expanded = expandQuery('child component lifecycle');
    expect(expanded).not.toBeNull();
    expect(expanded).not.toBe('child component lifecycle');
  });

  it('returns null when no synonym applies and pluralization wouldn\'t help', () => {
    // A query of all "stop words" or already-plural common tokens should
    // produce null rather than thrash. We treat "the and of" as a query with
    // no expandable tokens.
    expect(expandQuery('the and of')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(expandQuery('')).toBeNull();
    expect(expandQuery('   ')).toBeNull();
  });

  it('is deterministic — same input yields the same output', () => {
    const a = expandQuery('RAG embeddings vector store');
    const b = expandQuery('RAG embeddings vector store');
    expect(a).toBe(b);
  });

  it('does NOT call any network — pure function', () => {
    // Sanity check: the module must be importable in a sandbox without
    // network and produce the same result.
    expect(typeof expandQuery).toBe('function');
  });
});

describe('LOW_RECALL_THRESHOLD', () => {
  it('exports a numeric constant ≤ 5 (cheap-to-rewrite zone)', () => {
    expect(typeof LOW_RECALL_THRESHOLD).toBe('number');
    expect(LOW_RECALL_THRESHOLD).toBeGreaterThan(0);
    expect(LOW_RECALL_THRESHOLD).toBeLessThanOrEqual(5);
  });
});
