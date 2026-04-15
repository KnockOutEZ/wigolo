import { describe, it, expect } from 'vitest';
import {
  generateAgentMarkdownReport,
  generateAgentJsonReport,
} from '../../../../benchmarks/agent/report.js';
import { computeAgentSummary } from '../../../../benchmarks/agent/metrics.js';
import type { AgentBenchmarkReport, TaskEvaluation } from '../../../../benchmarks/agent/types.js';

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

describe('generateAgentMarkdownReport', () => {
  it('generates markdown with summary section', () => {
    const report: AgentBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 5000,
      summary: computeAgentSummary([makeEval()]),
      results: [makeEval()],
    };
    const md = generateAgentMarkdownReport(report);
    expect(md).toContain('# Agent Benchmark Report');
    expect(md).toContain('Factual Accuracy');
    expect(md).toContain('Citation Accuracy');
    expect(md).toContain('Completeness');
    expect(md).toContain('Completion Rate');
  });

  it('includes task type breakdown', () => {
    const report: AgentBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 5000,
      summary: computeAgentSummary([
        makeEval({ taskType: 'fact-lookup' }),
        makeEval({ taskType: 'multi-step-research' }),
      ]),
      results: [makeEval({ taskType: 'fact-lookup' }), makeEval({ taskType: 'multi-step-research' })],
    };
    const md = generateAgentMarkdownReport(report);
    expect(md).toContain('fact-lookup');
    expect(md).toContain('multi-step-research');
  });

  it('includes per-task detail rows', () => {
    const report: AgentBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 5000,
      summary: computeAgentSummary([makeEval({ taskId: 'special-task' })]),
      results: [makeEval({ taskId: 'special-task' })],
    };
    const md = generateAgentMarkdownReport(report);
    expect(md).toContain('special-task');
  });

  it('handles empty results', () => {
    const report: AgentBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 100,
      summary: computeAgentSummary([]),
      results: [],
    };
    const md = generateAgentMarkdownReport(report);
    expect(md).toContain('# Agent Benchmark Report');
  });

  it('marks errors in task rows', () => {
    const report: AgentBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 5000,
      summary: computeAgentSummary([makeEval({ error: 'timeout' })]),
      results: [makeEval({ error: 'timeout' })],
    };
    const md = generateAgentMarkdownReport(report);
    expect(md).toContain('ERR');
  });
});

describe('generateAgentJsonReport', () => {
  it('produces valid JSON', () => {
    const report: AgentBenchmarkReport = {
      runDate: '2026-04-14T12:00:00Z',
      durationMs: 5000,
      summary: computeAgentSummary([makeEval()]),
      results: [makeEval()],
    };
    const json = generateAgentJsonReport(report);
    const parsed = JSON.parse(json);
    expect(parsed.runDate).toBe('2026-04-14T12:00:00Z');
    expect(parsed.results).toHaveLength(1);
  });
});
