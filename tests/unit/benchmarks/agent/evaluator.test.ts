import { describe, it, expect } from 'vitest';
import {
  evaluateFact,
  evaluateTask,
  normalizeForComparison,
  computeFactualAccuracy,
  computeCitationAccuracy,
  computeCompleteness,
} from '../../../../benchmarks/agent/evaluator.js';
import type {
  ExpectedFact,
  TaskExecutionResult,
  ExecutionStep,
} from '../../../../benchmarks/agent/types.js';

describe('normalizeForComparison', () => {
  it('lowercases and trims', () => {
    expect(normalizeForComparison('  Hello World  ')).toBe('hello world');
  });

  it('collapses whitespace', () => {
    expect(normalizeForComparison('hello   \n  world')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeForComparison('')).toBe('');
  });

  it('handles null/undefined', () => {
    expect(normalizeForComparison(null as unknown as string)).toBe('');
    expect(normalizeForComparison(undefined as unknown as string)).toBe('');
  });

  it('strips common punctuation for fuzzy matching', () => {
    const result = normalizeForComparison('Hello, World! How are you?');
    expect(result).not.toContain(',');
    expect(result).not.toContain('!');
    expect(result).not.toContain('?');
  });
});

describe('evaluateFact', () => {
  it('finds exact match in content', () => {
    const fact: ExpectedFact = { taskId: 't1', fact: 'TypeScript 5.0', required: true };
    const content = 'The latest version is TypeScript 5.0 with many improvements.';
    const result = evaluateFact(fact, content);
    expect(result.found).toBe(true);
    expect(result.matchType).toBe('exact');
    expect(result.confidence).toBe(1);
  });

  it('finds substring match (case-insensitive)', () => {
    const fact: ExpectedFact = { taskId: 't1', fact: 'event loop', required: true };
    const content = 'The JavaScript EVENT LOOP processes callbacks from the task queue.';
    const result = evaluateFact(fact, content);
    expect(result.found).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('returns not-found for absent fact', () => {
    const fact: ExpectedFact = { taskId: 't1', fact: 'quantum computing', required: true };
    const content = 'JavaScript is a programming language for the web.';
    const result = evaluateFact(fact, content);
    expect(result.found).toBe(false);
    expect(result.matchType).toBe('not-found');
    expect(result.confidence).toBe(0);
  });

  it('finds semantic match with word overlap', () => {
    const fact: ExpectedFact = { taskId: 't1', fact: 'handles async operations', required: false };
    const content = 'The runtime handles asynchronous operations using promises and callbacks.';
    const result = evaluateFact(fact, content);
    // "handles" and "operations" overlap, plus "async" is a prefix of "asynchronous"
    expect(result.found).toBe(true);
    expect(result.matchType).toBe('semantic');
  });

  it('handles empty content', () => {
    const fact: ExpectedFact = { taskId: 't1', fact: 'test', required: true };
    const result = evaluateFact(fact, '');
    expect(result.found).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it('handles empty fact', () => {
    const fact: ExpectedFact = { taskId: 't1', fact: '', required: true };
    const result = evaluateFact(fact, 'some content');
    expect(result.found).toBe(false);
  });

  it('preserves fact text in result', () => {
    const fact: ExpectedFact = { taskId: 't1', fact: 'specific fact text', required: true };
    const result = evaluateFact(fact, 'specific fact text here');
    expect(result.fact).toBe('specific fact text');
  });

  it('preserves required flag in result', () => {
    const fact: ExpectedFact = { taskId: 't1', fact: 'test', required: false };
    const result = evaluateFact(fact, 'test content');
    expect(result.required).toBe(false);
  });
});

describe('computeFactualAccuracy', () => {
  it('returns 1.0 when all facts found', () => {
    const evaluations = [
      { fact: 'a', required: true, found: true, matchType: 'exact' as const, confidence: 1 },
      { fact: 'b', required: false, found: true, matchType: 'exact' as const, confidence: 1 },
    ];
    expect(computeFactualAccuracy(evaluations)).toBe(1);
  });

  it('returns 0 when no facts found', () => {
    const evaluations = [
      { fact: 'a', required: true, found: false, matchType: 'not-found' as const, confidence: 0 },
    ];
    expect(computeFactualAccuracy(evaluations)).toBe(0);
  });

  it('computes correct fraction', () => {
    const evaluations = [
      { fact: 'a', required: true, found: true, matchType: 'exact' as const, confidence: 1 },
      { fact: 'b', required: true, found: false, matchType: 'not-found' as const, confidence: 0 },
    ];
    expect(computeFactualAccuracy(evaluations)).toBe(0.5);
  });

  it('weights by confidence', () => {
    const evaluations = [
      { fact: 'a', required: true, found: true, matchType: 'exact' as const, confidence: 1 },
      { fact: 'b', required: true, found: true, matchType: 'semantic' as const, confidence: 0.5 },
    ];
    const accuracy = computeFactualAccuracy(evaluations);
    expect(accuracy).toBeCloseTo(0.75);
  });

  it('returns 0 for empty evaluations', () => {
    expect(computeFactualAccuracy([])).toBe(0);
  });
});

describe('computeCitationAccuracy', () => {
  it('returns 1.0 when all citation facts found', () => {
    const evaluations = [
      { fact: 'url1', required: true, found: true, matchType: 'exact' as const, confidence: 1, category: 'citation' as const },
      { fact: 'text', required: true, found: true, matchType: 'exact' as const, confidence: 1, category: 'factual' as const },
    ];
    expect(computeCitationAccuracy(evaluations)).toBe(1);
  });

  it('returns 0 when no citation facts exist', () => {
    const evaluations = [
      { fact: 'text', required: true, found: true, matchType: 'exact' as const, confidence: 1, category: 'factual' as const },
    ];
    // No citation facts => no citation accuracy applicable => return 1 (vacuously true)
    expect(computeCitationAccuracy(evaluations)).toBe(1);
  });

  it('computes fraction of found citation facts', () => {
    const evaluations = [
      { fact: 'url1', required: true, found: true, matchType: 'exact' as const, confidence: 1, category: 'citation' as const },
      { fact: 'url2', required: true, found: false, matchType: 'not-found' as const, confidence: 0, category: 'citation' as const },
    ];
    expect(computeCitationAccuracy(evaluations)).toBe(0.5);
  });
});

describe('computeCompleteness', () => {
  it('returns 1.0 when all required facts found', () => {
    const evaluations = [
      { fact: 'a', required: true, found: true, matchType: 'exact' as const, confidence: 1 },
      { fact: 'b', required: true, found: true, matchType: 'exact' as const, confidence: 1 },
      { fact: 'c', required: false, found: false, matchType: 'not-found' as const, confidence: 0 },
    ];
    expect(computeCompleteness(evaluations)).toBe(1);
  });

  it('returns 0 when no required facts found', () => {
    const evaluations = [
      { fact: 'a', required: true, found: false, matchType: 'not-found' as const, confidence: 0 },
    ];
    expect(computeCompleteness(evaluations)).toBe(0);
  });

  it('returns 1 when no required facts exist', () => {
    const evaluations = [
      { fact: 'a', required: false, found: false, matchType: 'not-found' as const, confidence: 0 },
    ];
    expect(computeCompleteness(evaluations)).toBe(1);
  });

  it('computes correct fraction of required facts', () => {
    const evaluations = [
      { fact: 'a', required: true, found: true, matchType: 'exact' as const, confidence: 1 },
      { fact: 'b', required: true, found: false, matchType: 'not-found' as const, confidence: 0 },
      { fact: 'c', required: true, found: true, matchType: 'exact' as const, confidence: 1 },
    ];
    expect(computeCompleteness(evaluations)).toBeCloseTo(2 / 3);
  });
});

describe('evaluateTask', () => {
  const makeExecResult = (overrides: Partial<TaskExecutionResult> = {}): TaskExecutionResult => ({
    taskId: 't1',
    steps: [],
    collectedContent: 'TypeScript 5.0 was released with decorator support.',
    collectedUrls: ['https://typescriptlang.org'],
    totalDurationMs: 500,
    ...overrides,
  });

  const sampleFacts: ExpectedFact[] = [
    { taskId: 't1', fact: 'TypeScript 5.0', required: true },
    { taskId: 't1', fact: 'decorator support', required: true },
    { taskId: 't1', fact: 'pattern matching', required: false },
  ];

  it('evaluates all facts against collected content', () => {
    const result = evaluateTask('t1', 'fact-lookup', 'ts features', makeExecResult(), sampleFacts);
    expect(result.factsTotal).toBe(3);
    expect(result.factsFound).toBe(2); // TypeScript 5.0 + decorator support
    expect(result.requiredFactsFound).toBe(2);
    expect(result.requiredFactsTotal).toBe(2);
  });

  it('computes factual accuracy', () => {
    const result = evaluateTask('t1', 'fact-lookup', 'ts features', makeExecResult(), sampleFacts);
    expect(result.factualAccuracy).toBeGreaterThan(0.5);
  });

  it('handles execution error', () => {
    const result = evaluateTask('t1', 'fact-lookup', 'ts features', makeExecResult({ error: 'timeout' }), sampleFacts);
    expect(result.error).toBe('timeout');
  });

  it('counts pages fetched', () => {
    const steps: ExecutionStep[] = [
      { tool: 'search', input: {}, output: {}, durationMs: 100 },
      { tool: 'fetch', input: {}, output: {}, durationMs: 200 },
      { tool: 'fetch', input: {}, output: {}, durationMs: 150 },
    ];
    const result = evaluateTask('t1', 'fact-lookup', 'query', makeExecResult({ steps }), sampleFacts);
    expect(result.pagesFetched).toBe(2);
    expect(result.totalSteps).toBe(3);
  });

  it('records latency', () => {
    const result = evaluateTask('t1', 'fact-lookup', 'query', makeExecResult({ totalDurationMs: 1234 }), sampleFacts);
    expect(result.latencyMs).toBe(1234);
  });

  it('handles empty content', () => {
    const result = evaluateTask('t1', 'fact-lookup', 'query', makeExecResult({ collectedContent: '' }), sampleFacts);
    expect(result.factsFound).toBe(0);
    expect(result.factualAccuracy).toBe(0);
  });

  it('handles no expected facts', () => {
    const result = evaluateTask('t1', 'fact-lookup', 'query', makeExecResult(), []);
    expect(result.factsTotal).toBe(0);
    expect(result.factualAccuracy).toBe(0);
  });
});
