import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decomposeQuestion } from '../../../src/research/decompose.js';

describe('decomposeQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fallback decomposition (no server)', () => {
    it('returns 2 sub-queries for quick depth', async () => {
      const result = await decomposeQuestion(
        'What are the best practices for React state management in 2025?',
        'quick',
      );
      expect(result.subQueries).toHaveLength(2);
      expect(result.samplingUsed).toBe(false);
    });

    it('returns 4 sub-queries for standard depth', async () => {
      const result = await decomposeQuestion(
        'What are the best practices for React state management in 2025?',
        'standard',
      );
      expect(result.subQueries).toHaveLength(4);
      expect(result.samplingUsed).toBe(false);
    });

    it('returns 7 sub-queries for comprehensive depth', async () => {
      const result = await decomposeQuestion(
        'What are the best practices for React state management in 2025?',
        'comprehensive',
      );
      expect(result.subQueries).toHaveLength(7);
      expect(result.samplingUsed).toBe(false);
    });

    it('handles empty question gracefully', async () => {
      const result = await decomposeQuestion('', 'standard');
      expect(result.subQueries).toHaveLength(4);
      for (const q of result.subQueries) {
        expect(typeof q).toBe('string');
      }
      expect(result.samplingUsed).toBe(false);
    });

    it('handles very short question', async () => {
      const result = await decomposeQuestion('React hooks', 'quick');
      expect(result.subQueries).toHaveLength(2);
      for (const q of result.subQueries) {
        expect(q.length).toBeGreaterThan(0);
      }
    });

    it('handles question with multiple clauses', async () => {
      const result = await decomposeQuestion(
        'Compare React and Vue for large-scale enterprise applications, considering performance, developer experience, and ecosystem maturity',
        'standard',
      );
      expect(result.subQueries).toHaveLength(4);
      for (const q of result.subQueries) {
        expect(q.length).toBeGreaterThan(0);
        expect(q.length).toBeLessThan(500);
      }
    });

    it('handles question with special characters', async () => {
      const result = await decomposeQuestion(
        'How to fix "TypeError: Cannot read property \'map\' of undefined" in React?',
        'quick',
      );
      expect(result.subQueries).toHaveLength(2);
    });

    it('returns non-duplicate sub-queries', async () => {
      const result = await decomposeQuestion(
        'What are the differences between REST APIs and GraphQL APIs in terms of performance and developer experience?',
        'standard',
      );
      const unique = new Set(result.subQueries);
      expect(unique.size).toBe(result.subQueries.length);
    });

    it('each sub-query is a non-empty trimmed string', async () => {
      const result = await decomposeQuestion(
        'Explain the trade-offs between microservices and monolithic architecture',
        'comprehensive',
      );
      for (const q of result.subQueries) {
        expect(q).toBe(q.trim());
        expect(q.length).toBeGreaterThan(0);
      }
    });

    it('defaults depth to standard if not provided', async () => {
      const result = await decomposeQuestion(
        'How does garbage collection work in modern JavaScript engines?',
        'standard',
      );
      expect(result.subQueries).toHaveLength(4);
    });
  });

  describe('sampling decomposition (with mock server)', () => {
    it('uses requestSampling when server is provided', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: {
            type: 'text',
            text: JSON.stringify({
              subQueries: [
                'React state management patterns 2025',
                'useState vs useReducer best practices',
                'React context API performance',
                'Redux vs Zustand comparison 2025',
              ],
            }),
          },
        }),
      };

      const result = await decomposeQuestion(
        'What are the best practices for React state management in 2025?',
        'standard',
        mockServer as any,
      );

      expect(result.samplingUsed).toBe(true);
      expect(result.subQueries).toHaveLength(4);
      expect(result.subQueries[0]).toBe('React state management patterns 2025');
      expect(mockServer.createMessage).toHaveBeenCalledTimes(1);
    });

    it('falls back to heuristic when sampling fails', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockRejectedValue(new Error('sampling not supported')),
      };

      const result = await decomposeQuestion(
        'What are the best practices for React state management?',
        'standard',
        mockServer as any,
      );

      expect(result.samplingUsed).toBe(false);
      expect(result.subQueries).toHaveLength(4);
    });

    it('falls back when sampling returns malformed JSON', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: { type: 'text', text: 'not valid json at all' },
        }),
      };

      const result = await decomposeQuestion(
        'What is WebAssembly?',
        'quick',
        mockServer as any,
      );

      expect(result.samplingUsed).toBe(false);
      expect(result.subQueries).toHaveLength(2);
    });

    it('falls back when sampling returns wrong number of sub-queries', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: {
            type: 'text',
            text: JSON.stringify({ subQueries: ['only one'] }),
          },
        }),
      };

      const result = await decomposeQuestion(
        'Explain quantum computing applications',
        'standard',
        mockServer as any,
      );

      expect(result.samplingUsed).toBe(false);
      expect(result.subQueries).toHaveLength(4);
    });

    it('falls back when sampling returns empty array', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: {
            type: 'text',
            text: JSON.stringify({ subQueries: [] }),
          },
        }),
      };

      const result = await decomposeQuestion(
        'What is Rust?',
        'quick',
        mockServer as any,
      );

      expect(result.samplingUsed).toBe(false);
      expect(result.subQueries).toHaveLength(2);
    });

    it('handles server timeout gracefully', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockImplementation(() =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 50),
          ),
        ),
      };

      const result = await decomposeQuestion(
        'What is AI safety?',
        'quick',
        mockServer as any,
      );

      expect(result.samplingUsed).toBe(false);
      expect(result.subQueries).toHaveLength(2);
    });
  });
});
