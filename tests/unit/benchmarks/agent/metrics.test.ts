import { describe, it, expect } from 'vitest';
import { computeAgentSummary } from '../../../../benchmarks/agent/metrics.js';
import type { TaskEvaluation } from '../../../../benchmarks/agent/types.js';

function makeEval(overrides: Partial<TaskEvaluation> = {}): TaskEvaluation {
  return {
    taskId: 't1',
    taskType: 'fact-lookup',
    query: 'test query',
    factEvaluations: [],
    factsFound: 3,
    factsTotal: 4,
    requiredFactsFound: 2,
    requiredFactsTotal: 2,
    factualAccuracy: 0.75,
    citationAccuracy: 1,
    completeness: 1,
    pagesFetched: 2,
    totalSteps: 3,
    latencyMs: 500,
    ...overrides,
  };
}

describe('computeAgentSummary', () => {
  it('computes averages for single result', () => {
    const summary = computeAgentSummary([makeEval()]);
    expect(summary.totalTasks).toBe(1);
    expect(summary.successfulTasks).toBe(1);
    expect(summary.failedTasks).toBe(0);
    expect(summary.averageFactualAccuracy).toBeCloseTo(0.75);
    expect(summary.averageCitationAccuracy).toBe(1);
    expect(summary.averageCompleteness).toBe(1);
    expect(summary.averagePagesFetched).toBe(2);
  });

  it('computes averages for multiple results', () => {
    const results = [
      makeEval({ factualAccuracy: 0.8, completeness: 1.0 }),
      makeEval({ factualAccuracy: 0.6, completeness: 0.5 }),
    ];
    const summary = computeAgentSummary(results);
    expect(summary.averageFactualAccuracy).toBeCloseTo(0.7);
    expect(summary.averageCompleteness).toBeCloseTo(0.75);
  });

  it('counts failures', () => {
    const results = [
      makeEval(),
      makeEval({ error: 'timeout' }),
    ];
    const summary = computeAgentSummary(results);
    expect(summary.failedTasks).toBe(1);
    expect(summary.successfulTasks).toBe(1);
  });

  it('computes task completion rate', () => {
    const results = [
      makeEval({ completeness: 1 }),
      makeEval({ completeness: 1 }),
      makeEval({ completeness: 0 }),
    ];
    // completion = tasks where completeness >= 0.5
    const summary = computeAgentSummary(results);
    expect(summary.taskCompletionRate).toBeCloseTo(2 / 3);
  });

  it('groups by task type', () => {
    const results = [
      makeEval({ taskType: 'fact-lookup', factualAccuracy: 0.9, latencyMs: 100 }),
      makeEval({ taskType: 'fact-lookup', factualAccuracy: 0.7, latencyMs: 200 }),
      makeEval({ taskType: 'multi-step-research', factualAccuracy: 0.6, latencyMs: 800 }),
    ];
    const summary = computeAgentSummary(results);
    expect(summary.byTaskType['fact-lookup'].count).toBe(2);
    expect(summary.byTaskType['fact-lookup'].averageAccuracy).toBeCloseTo(0.8);
    expect(summary.byTaskType['multi-step-research'].count).toBe(1);
  });

  it('handles empty results', () => {
    const summary = computeAgentSummary([]);
    expect(summary.totalTasks).toBe(0);
    expect(summary.averageFactualAccuracy).toBe(0);
    expect(summary.taskCompletionRate).toBe(0);
  });

  it('computes average latency', () => {
    const results = [
      makeEval({ latencyMs: 100 }),
      makeEval({ latencyMs: 300 }),
    ];
    const summary = computeAgentSummary(results);
    expect(summary.averageLatencyMs).toBeCloseTo(200);
  });

  it('computes average pages fetched', () => {
    const results = [
      makeEval({ pagesFetched: 1 }),
      makeEval({ pagesFetched: 5 }),
    ];
    const summary = computeAgentSummary(results);
    expect(summary.averagePagesFetched).toBeCloseTo(3);
  });
});
