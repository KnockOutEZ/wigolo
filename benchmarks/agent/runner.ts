import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../src/logger.js';
import { evaluateTask } from './evaluator.js';
import { computeAgentSummary } from './metrics.js';
import { generateAgentMarkdownReport, generateAgentJsonReport } from './report.js';
import { executeTask } from './task-executor.js';
import type {
  AgentTask,
  ExpectedFact,
  ExpectedOutput,
  TaskEvaluation,
  AgentBenchmarkReport,
  AgentRunnerOptions,
} from './types.js';
import type { SearchInput, SearchOutput, FetchInput, FetchOutput } from '../../src/types.js';

const log = createLogger('extract');

export function loadTasks(tasksPath: string): AgentTask[] {
  try {
    const raw = readFileSync(tasksPath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error('Tasks file missing "tasks" array');
    }
    if (parsed.tasks.length === 0) {
      throw new Error('Tasks file has empty tasks array');
    }

    return parsed.tasks as AgentTask[];
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in tasks file: ${err.message}`);
    }
    throw err;
  }
}

export function loadExpected(expectedPath: string): ExpectedFact[] {
  try {
    const raw = readFileSync(expectedPath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!parsed.outputs || !Array.isArray(parsed.outputs)) {
      throw new Error('Expected file missing "outputs" array');
    }

    const allFacts: ExpectedFact[] = [];
    for (const output of parsed.outputs as ExpectedOutput[]) {
      for (const fact of output.facts) {
        allFacts.push(fact);
      }
    }

    return allFacts;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in expected file: ${err.message}`);
    }
    throw err;
  }
}

export function filterTasks(
  tasks: AgentTask[],
  filter?: string,
): AgentTask[] {
  try {
    if (!filter) return tasks;

    const lower = filter.toLowerCase();
    return tasks.filter(t => {
      if (t.type.toLowerCase() === lower) return true;
      if (t.id.toLowerCase().includes(lower)) return true;
      if (t.tags?.some(tag => tag.toLowerCase() === lower)) return true;
      return false;
    });
  } catch (err) {
    log.warn('filterTasks failed', { error: String(err) });
    return tasks;
  }
}

export async function runAgentBenchmark(
  options: AgentRunnerOptions,
  searchFn?: (input: SearchInput) => Promise<SearchOutput>,
  fetchFn?: (input: FetchInput) => Promise<FetchOutput>,
): Promise<AgentBenchmarkReport> {
  const startTime = Date.now();

  if (!existsSync(options.tasksPath)) {
    throw new Error(`Tasks file not found: ${options.tasksPath}`);
  }
  if (!existsSync(options.expectedPath)) {
    throw new Error(`Expected file not found: ${options.expectedPath}`);
  }

  const tasks = loadTasks(options.tasksPath);
  const expectedFacts = loadExpected(options.expectedPath);
  const filtered = filterTasks(tasks, options.filter);

  if (filtered.length === 0) {
    throw new Error(`No tasks match filter "${options.filter}"`);
  }

  log.info('starting agent benchmark', {
    totalTasks: filtered.length,
    totalFacts: expectedFacts.length,
  });

  // Provide no-op implementations if no search/fetch functions given
  const doSearch = searchFn ?? (async (_input: SearchInput): Promise<SearchOutput> => ({
    results: [],
    query: _input.query,
    engines_used: ['none'],
    total_time_ms: 0,
  }));

  const doFetch = fetchFn ?? (async (_input: FetchInput): Promise<FetchOutput> => ({
    url: _input.url,
    title: '',
    markdown: '',
    metadata: {},
    links: [],
    images: [],
    cached: false,
    error: 'no fetch function provided',
  }));

  const evaluations: TaskEvaluation[] = [];

  for (const task of filtered) {
    const execution = await executeTask(task, doSearch, doFetch);
    const evaluation = evaluateTask(
      task.id,
      task.type,
      task.query,
      execution,
      expectedFacts,
    );

    evaluations.push(evaluation);

    if (options.verbose) {
      log.info('task benchmark complete', {
        taskId: task.id,
        accuracy: evaluation.factualAccuracy.toFixed(3),
        completeness: evaluation.completeness.toFixed(3),
        latencyMs: evaluation.latencyMs,
      });
    }
  }

  const durationMs = Date.now() - startTime;
  const summary = computeAgentSummary(evaluations);

  const report: AgentBenchmarkReport = {
    runDate: new Date().toISOString(),
    durationMs,
    summary,
    results: evaluations,
  };

  try {
    if (!existsSync(options.outputDir)) {
      mkdirSync(options.outputDir, { recursive: true });
    }

    writeFileSync(
      join(options.outputDir, 'agent-benchmark.json'),
      generateAgentJsonReport(report),
      'utf-8',
    );

    writeFileSync(
      join(options.outputDir, 'agent-benchmark.md'),
      generateAgentMarkdownReport(report),
      'utf-8',
    );

    log.info('agent benchmark complete', {
      totalTasks: summary.totalTasks,
      completionRate: (summary.taskCompletionRate * 100).toFixed(1) + '%',
      accuracy: (summary.averageFactualAccuracy * 100).toFixed(1) + '%',
      durationMs,
    });
  } catch (err) {
    log.error('failed to write agent benchmark output', { error: String(err) });
  }

  return report;
}
