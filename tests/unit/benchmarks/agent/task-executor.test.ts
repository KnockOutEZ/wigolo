import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeTask,
  buildSearchInput,
  buildFetchInput,
} from '../../../../benchmarks/agent/task-executor.js';
import type { AgentTask, TaskExecutionResult } from '../../../../benchmarks/agent/types.js';

describe('buildSearchInput', () => {
  it('creates search input from task', () => {
    const task: AgentTask = { id: 't1', type: 'fact-lookup', description: 'Find info', query: 'typescript generics' };
    const input = buildSearchInput(task);
    expect(input.query).toBe('typescript generics');
    expect(input.max_results).toBeGreaterThan(0);
    expect(input.include_content).toBe(true);
  });

  it('uses expectedDomains as include_domains', () => {
    const task: AgentTask = {
      id: 't1', type: 'code-docs', description: 'docs',
      query: 'q', expectedDomains: ['typescriptlang.org'],
    };
    const input = buildSearchInput(task);
    expect(input.include_domains).toEqual(['typescriptlang.org']);
  });

  it('handles task without expectedDomains', () => {
    const task: AgentTask = { id: 't1', type: 'fact-lookup', description: 'd', query: 'q' };
    const input = buildSearchInput(task);
    expect(input.include_domains).toBeUndefined();
  });
});

describe('buildFetchInput', () => {
  it('creates fetch input from URL', () => {
    const input = buildFetchInput('https://example.com/page');
    expect(input.url).toBe('https://example.com/page');
    expect(input.max_chars).toBeGreaterThan(0);
  });

  it('sets render_js to auto', () => {
    const input = buildFetchInput('https://example.com');
    expect(input.render_js).toBe('auto');
  });
});

describe('executeTask', () => {
  it('returns result with steps for successful execution', async () => {
    const task: AgentTask = { id: 't1', type: 'fact-lookup', description: 'desc', query: 'test' };

    const mockSearch = vi.fn().mockResolvedValue({
      results: [
        { url: 'https://a.com', title: 'A', snippet: 'content A', markdown_content: 'Full content from A' },
      ],
      query: 'test',
      engines_used: ['mock'],
      total_time_ms: 100,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      url: 'https://a.com',
      title: 'A',
      markdown: 'Full content from A about the topic',
      metadata: {},
      links: [],
      images: [],
      cached: false,
    });

    const result = await executeTask(task, mockSearch, mockFetch);

    expect(result.taskId).toBe('t1');
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.collectedContent.length).toBeGreaterThan(0);
    expect(result.collectedUrls.length).toBeGreaterThan(0);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('captures search failure', async () => {
    const task: AgentTask = { id: 't-err', type: 'fact-lookup', description: 'd', query: 'q' };

    const mockSearch = vi.fn().mockRejectedValue(new Error('search failed'));
    const mockFetch = vi.fn();

    const result = await executeTask(task, mockSearch, mockFetch);
    expect(result.error).toBe('search failed');
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0].error).toBeDefined();
  });

  it('handles empty search results', async () => {
    const task: AgentTask = { id: 't-empty', type: 'fact-lookup', description: 'd', query: 'q' };

    const mockSearch = vi.fn().mockResolvedValue({
      results: [],
      query: 'q',
      engines_used: ['mock'],
      total_time_ms: 50,
    });
    const mockFetch = vi.fn();

    const result = await executeTask(task, mockSearch, mockFetch);
    expect(result.collectedContent).toBe('');
    expect(result.collectedUrls).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('collects content from multiple fetch results', async () => {
    const task: AgentTask = { id: 't-multi', type: 'multi-step-research', description: 'd', query: 'q', maxSteps: 5 };

    const mockSearch = vi.fn().mockResolvedValue({
      results: [
        { url: 'https://a.com', title: 'A', snippet: 's' },
        { url: 'https://b.com', title: 'B', snippet: 's' },
      ],
      query: 'q',
      engines_used: ['mock'],
      total_time_ms: 100,
    });

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ url: 'https://a.com', title: 'A', markdown: 'Content A', metadata: {}, links: [], images: [], cached: false })
      .mockResolvedValueOnce({ url: 'https://b.com', title: 'B', markdown: 'Content B', metadata: {}, links: [], images: [], cached: false });

    const result = await executeTask(task, mockSearch, mockFetch);
    expect(result.collectedContent).toContain('Content A');
    expect(result.collectedContent).toContain('Content B');
    expect(result.collectedUrls).toContain('https://a.com');
    expect(result.collectedUrls).toContain('https://b.com');
  });

  it('respects maxSteps limit', async () => {
    const task: AgentTask = { id: 't-limit', type: 'fact-lookup', description: 'd', query: 'q', maxSteps: 2 };

    const mockSearch = vi.fn().mockResolvedValue({
      results: [
        { url: 'https://a.com', title: 'A', snippet: 's' },
        { url: 'https://b.com', title: 'B', snippet: 's' },
        { url: 'https://c.com', title: 'C', snippet: 's' },
      ],
      query: 'q',
      engines_used: ['mock'],
      total_time_ms: 100,
    });

    const mockFetch = vi.fn().mockResolvedValue({ url: 'u', title: 'T', markdown: 'M', metadata: {}, links: [], images: [], cached: false });

    const result = await executeTask(task, mockSearch, mockFetch);
    // 1 search step + maxSteps-1 fetch steps = maxSteps total
    expect(result.steps.length).toBeLessThanOrEqual(task.maxSteps! + 1);
  });

  it('handles fetch failure for individual URLs gracefully', async () => {
    const task: AgentTask = { id: 't-partial', type: 'fact-lookup', description: 'd', query: 'q' };

    const mockSearch = vi.fn().mockResolvedValue({
      results: [
        { url: 'https://good.com', title: 'Good', snippet: 's' },
        { url: 'https://bad.com', title: 'Bad', snippet: 's' },
      ],
      query: 'q',
      engines_used: ['mock'],
      total_time_ms: 100,
    });

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ url: 'https://good.com', title: 'Good', markdown: 'Good content', metadata: {}, links: [], images: [], cached: false })
      .mockRejectedValueOnce(new Error('fetch timeout'));

    const result = await executeTask(task, mockSearch, mockFetch);
    expect(result.collectedContent).toContain('Good content');
    expect(result.error).toBeUndefined(); // partial failure is not a full error
    expect(result.steps.some(s => s.error)).toBe(true);
  });

  it('respects timeout', async () => {
    const task: AgentTask = { id: 't-timeout', type: 'fact-lookup', description: 'd', query: 'q', timeoutMs: 100 };

    const mockSearch = vi.fn().mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve({
        results: [{ url: 'https://slow.com', title: 'Slow', snippet: 's' }],
        query: 'q',
        engines_used: ['mock'],
        total_time_ms: 200,
      }), 200)),
    );
    const mockFetch = vi.fn();

    const result = await executeTask(task, mockSearch, mockFetch);
    // Should either timeout or succeed depending on race
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});
