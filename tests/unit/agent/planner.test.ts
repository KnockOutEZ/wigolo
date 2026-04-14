import { describe, it, expect, vi, beforeEach } from 'vitest';
import { planExecution } from '../../../src/agent/planner.js';

describe('planExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fallback planning (no server)', () => {
    it('extracts search queries from a simple prompt', async () => {
      const result = await planExecution('Find the pricing for the top 5 CRM tools');
      expect(result.searches.length).toBeGreaterThan(0);
      expect(result.urls).toHaveLength(0);
      expect(result.samplingUsed).toBe(false);
    });

    it('extracts URLs from prompt when present', async () => {
      const result = await planExecution(
        'Compare the pricing at https://salesforce.com/pricing and https://hubspot.com/pricing',
      );
      expect(result.urls.length).toBeGreaterThanOrEqual(2);
      expect(result.urls).toContain('https://salesforce.com/pricing');
      expect(result.urls).toContain('https://hubspot.com/pricing');
    });

    it('combines URLs and search queries', async () => {
      const result = await planExecution(
        'Get the pricing from https://example.com/pricing and also search for CRM pricing comparison',
      );
      expect(result.urls.length).toBeGreaterThanOrEqual(1);
      expect(result.searches.length).toBeGreaterThan(0);
    });

    it('merges explicit urls parameter with extracted URLs', async () => {
      const result = await planExecution('Check pricing details', ['https://explicit.com/pricing']);
      expect(result.urls).toContain('https://explicit.com/pricing');
    });

    it('deduplicates URLs from prompt and parameter', async () => {
      const result = await planExecution(
        'Check https://example.com/page',
        ['https://example.com/page'],
      );
      const uniqueUrls = new Set(result.urls);
      expect(uniqueUrls.size).toBe(result.urls.length);
    });

    it('handles empty prompt', async () => {
      const result = await planExecution('');
      expect(result.searches).toHaveLength(0);
      expect(result.urls).toHaveLength(0);
      expect(result.notes).toBeTruthy();
      expect(result.samplingUsed).toBe(false);
    });

    it('handles prompt with only whitespace', async () => {
      const result = await planExecution('   ');
      expect(result.searches).toHaveLength(0);
      expect(result.urls).toHaveLength(0);
    });

    it('generates keyword-based search queries', async () => {
      const result = await planExecution(
        'Find the latest performance benchmarks for Bun versus Node.js versus Deno',
      );
      expect(result.searches.length).toBeGreaterThan(0);
      for (const q of result.searches) {
        expect(typeof q).toBe('string');
        expect(q.length).toBeGreaterThan(0);
      }
    });

    it('handles special characters in prompt', async () => {
      const result = await planExecution(
        'Fix "TypeError: Cannot read property \'map\' of undefined" in React.js',
      );
      expect(result.searches.length).toBeGreaterThan(0);
    });

    it('handles very long prompt', async () => {
      const longPrompt = 'Find information about ' + 'technology '.repeat(200);
      const result = await planExecution(longPrompt);
      expect(result.searches.length).toBeGreaterThan(0);
      for (const q of result.searches) {
        expect(q.length).toBeLessThan(500);
      }
    });

    it('extracts multiple URLs with different protocols', async () => {
      const result = await planExecution(
        'Check https://secure.example.com and http://legacy.example.com',
      );
      expect(result.urls).toContain('https://secure.example.com');
      expect(result.urls).toContain('http://legacy.example.com');
    });

    it('notes field contains useful context', async () => {
      const result = await planExecution('Find pricing for CRM tools');
      expect(typeof result.notes).toBe('string');
    });

    it('search queries do not exceed a reasonable length', async () => {
      const result = await planExecution(
        'Compare every single aspect of React, Vue, Angular, Svelte, SolidJS, Qwik, Lit, and Stencil frameworks including performance, developer experience, ecosystem, community, learning curve, and job market',
      );
      for (const q of result.searches) {
        expect(q.length).toBeLessThan(300);
      }
    });

    it('generates at most 5 search queries in fallback mode', async () => {
      const result = await planExecution('Comprehensive comparison of all JavaScript frameworks');
      expect(result.searches.length).toBeLessThanOrEqual(5);
    });
  });

  describe('sampling planning (with mock server)', () => {
    it('uses requestSampling when server is provided', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: {
            type: 'text',
            text: JSON.stringify({
              searches: ['CRM pricing comparison 2025', 'best CRM tools small business'],
              urls: ['https://g2.com/categories/crm'],
              notes: 'Focus on enterprise and SMB pricing tiers',
            }),
          },
        }),
      };

      const result = await planExecution('Find pricing for top CRM tools', undefined, mockServer as any);
      expect(result.samplingUsed).toBe(true);
      expect(result.searches).toContain('CRM pricing comparison 2025');
      expect(result.urls).toContain('https://g2.com/categories/crm');
      expect(mockServer.createMessage).toHaveBeenCalledTimes(1);
    });

    it('falls back when sampling fails', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockRejectedValue(new Error('sampling not supported')),
      };
      const result = await planExecution('Find pricing info', undefined, mockServer as any);
      expect(result.samplingUsed).toBe(false);
      expect(result.searches.length).toBeGreaterThan(0);
    });

    it('falls back when sampling returns malformed JSON', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: { type: 'text', text: 'not json' },
        }),
      };
      const result = await planExecution('Find data', undefined, mockServer as any);
      expect(result.samplingUsed).toBe(false);
    });

    it('falls back when sampling returns empty searches', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: {
            type: 'text',
            text: JSON.stringify({ searches: [], urls: [], notes: '' }),
          },
        }),
      };
      const result = await planExecution('Find some data', undefined, mockServer as any);
      expect(result.samplingUsed).toBe(false);
      expect(result.searches.length).toBeGreaterThan(0);
    });

    it('merges sampling URLs with explicit urls parameter', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockResolvedValue({
          model: 'test-model',
          content: {
            type: 'text',
            text: JSON.stringify({
              searches: ['test query'],
              urls: ['https://from-sampling.com'],
              notes: '',
            }),
          },
        }),
      };
      const result = await planExecution('Test', ['https://explicit.com'], mockServer as any);
      expect(result.urls).toContain('https://from-sampling.com');
      expect(result.urls).toContain('https://explicit.com');
    });

    it('handles sampling timeout', async () => {
      const mockServer = {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: vi.fn().mockImplementation(() =>
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 50)),
        ),
      };
      const result = await planExecution('Timeout test', undefined, mockServer as any);
      expect(result.samplingUsed).toBe(false);
    });
  });
});
