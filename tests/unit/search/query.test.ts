import { describe, it, expect } from 'vitest';
import { decomposeQuery } from '../../../src/search/query.js';

describe('decomposeQuery', () => {
  it('returns single-element array for short queries', () => {
    expect(decomposeQuery('react hooks')).toEqual(['react hooks']);
  });

  it('returns query as-is when exactly at limit', () => {
    const query = 'a'.repeat(200);
    expect(decomposeQuery(query)).toEqual([query]);
  });

  it('splits long queries on sentence boundaries', () => {
    const query = 'This is a very long query about React hooks and their usage patterns. ' +
      'It also covers advanced state management techniques. ' +
      'Finally it discusses performance optimization strategies for large applications with many components.';
    const parts = decomposeQuery(query);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach(p => expect(p.length).toBeLessThanOrEqual(200));
  });

  it('splits on semicolons and conjunctions', () => {
    const query = 'How to set up a React project; including routing, state management, and testing, and also deployment to production with Docker containers and CI/CD pipelines for automated deployments across multiple environments including staging and production servers running on AWS or GCP or Azure cloud platforms';
    const parts = decomposeQuery(query);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach(p => expect(p.length).toBeLessThanOrEqual(200));
  });

  it('falls back to word-boundary splitting for no-separator text', () => {
    const query = Array(50).fill('longword').join(' ');
    const parts = decomposeQuery(query);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach(p => expect(p.length).toBeLessThanOrEqual(200));
  });

  it('returns empty array for empty input', () => {
    expect(decomposeQuery('')).toEqual(['']);
  });
});
