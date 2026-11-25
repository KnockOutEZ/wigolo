import { describe, it, expect } from 'vitest';
import { searchCategory } from '../../../../../src/cli/tui/schema/search.js';

describe('searchCategory', () => {
  it('has id search and the expected fields', () => {
    expect(searchCategory.id).toBe('search');
    expect(searchCategory.fields.length).toBe(6);
    const keys = searchCategory.fields.map((f) => f.key);
    expect(keys).toEqual([
      'WIGOLO_SEARCH',
      'WIGOLO_RERANKER',
      'WIGOLO_RERANKER_MODEL',
      'WIGOLO_RERANK_API_BASE',
      'WIGOLO_EMBEDDING_MODEL',
      'WIGOLO_EMBEDDING_API_BASE',
    ]);
  });

  it('WIGOLO_SEARCH offers core/searxng/hybrid with core default', () => {
    const f = searchCategory.fields.find((x) => x.key === 'WIGOLO_SEARCH');
    expect(f?.kind).toBe('select');
    expect(f?.default).toBe('core');
    expect(f?.options?.map((o) => o.value)).toEqual(['core', 'searxng', 'hybrid']);
  });

  it('WIGOLO_RERANKER offers local, remote, and disabled modes', () => {
    const f = searchCategory.fields.find((x) => x.key === 'WIGOLO_RERANKER');
    expect(f?.kind).toBe('select');
    expect(f?.default).toBe('onnx');
    expect(f?.options?.map((o) => o.value)).toEqual(['onnx', 'remote', 'none']);
  });

  it('WIGOLO_RERANKER_MODEL defaults to bge-reranker-v2-m3', () => {
    const f = searchCategory.fields.find((x) => x.key === 'WIGOLO_RERANKER_MODEL');
    expect(f?.kind).toBe('text');
    expect(f?.default).toBe('bge-reranker-v2-m3');
  });

  it('WIGOLO_EMBEDDING_MODEL defaults to BAAI/bge-small-en-v1.5', () => {
    const f = searchCategory.fields.find((x) => x.key === 'WIGOLO_EMBEDDING_MODEL');
    expect(f?.kind).toBe('text');
    expect(f?.default).toBe('BAAI/bge-small-en-v1.5');
  });

  it('every field has settingsPath + label', () => {
    for (const f of searchCategory.fields) {
      expect(f.settingsPath, `field ${f.key} missing settingsPath`).toBeTruthy();
      expect(f.label, `field ${f.key} missing label`).toBeTruthy();
    }
  });
});
