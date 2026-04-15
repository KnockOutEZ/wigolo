import { createLogger } from '../../src/logger.js';
import type {
  TaskEvaluation,
  AgentBenchmarkSummary,
  TaskTypeSummary,
} from './types.js';

const log = createLogger('extract');

const COMPLETION_THRESHOLD = 0.5;

export function computeAgentSummary(results: TaskEvaluation[]): AgentBenchmarkSummary {
  try {
    if (results.length === 0) {
      return {
        totalTasks: 0,
        successfulTasks: 0,
        failedTasks: 0,
        taskCompletionRate: 0,
        averageFactualAccuracy: 0,
        averageCitationAccuracy: 0,
        averageCompleteness: 0,
        averagePagesFetched: 0,
        averageLatencyMs: 0,
        averageTokenEfficiency: 0,
        byTaskType: {},
      };
    }

    const successful = results.filter(r => !r.error);
    const failed = results.filter(r => !!r.error);
    const completed = results.filter(r => r.completeness >= COMPLETION_THRESHOLD);

    const n = results.length;
    const sn = successful.length || 1;

    const sumAccuracy = successful.reduce((s, r) => s + r.factualAccuracy, 0);
    const sumCitation = successful.reduce((s, r) => s + r.citationAccuracy, 0);
    const sumCompleteness = successful.reduce((s, r) => s + r.completeness, 0);
    const sumPages = results.reduce((s, r) => s + r.pagesFetched, 0);
    const sumLatency = results.reduce((s, r) => s + r.latencyMs, 0);
    const sumEfficiency = successful.reduce((s, r) => s + r.factsFound / Math.max(r.pagesFetched, 1), 0);

    // Group by task type
    const byTaskType: Record<string, TaskTypeSummary> = {};
    for (const r of results) {
      if (!byTaskType[r.taskType]) {
        byTaskType[r.taskType] = {
          count: 0,
          completionRate: 0,
          averageAccuracy: 0,
          averageCompleteness: 0,
          averageLatencyMs: 0,
          tokenEfficiency: 0,
        };
      }
      const tt = byTaskType[r.taskType];
      tt.count++;
      tt.averageAccuracy += r.factualAccuracy;
      tt.averageCompleteness += r.completeness;
      tt.averageLatencyMs += r.latencyMs;
      tt.tokenEfficiency = (tt.tokenEfficiency ?? 0) + r.factsFound / Math.max(r.pagesFetched, 1);
      if (r.completeness >= COMPLETION_THRESHOLD) tt.completionRate++;
    }
    for (const key of Object.keys(byTaskType)) {
      const tt = byTaskType[key];
      tt.completionRate /= tt.count;
      tt.averageAccuracy /= tt.count;
      tt.averageCompleteness /= tt.count;
      tt.averageLatencyMs /= tt.count;
      tt.tokenEfficiency = (tt.tokenEfficiency ?? 0) / tt.count;
    }

    return {
      totalTasks: n,
      successfulTasks: successful.length,
      failedTasks: failed.length,
      taskCompletionRate: completed.length / n,
      averageFactualAccuracy: sumAccuracy / sn,
      averageCitationAccuracy: sumCitation / sn,
      averageCompleteness: sumCompleteness / sn,
      averagePagesFetched: sumPages / n,
      averageLatencyMs: sumLatency / n,
      averageTokenEfficiency: sumEfficiency / sn,
      byTaskType,
    };
  } catch (err) {
    log.error('computeAgentSummary failed', { error: String(err) });
    return {
      totalTasks: results.length,
      successfulTasks: 0,
      failedTasks: results.length,
      taskCompletionRate: 0,
      averageFactualAccuracy: 0,
      averageCitationAccuracy: 0,
      averageCompleteness: 0,
      averagePagesFetched: 0,
      averageLatencyMs: 0,
      averageTokenEfficiency: 0,
      byTaskType: {},
    };
  }
}
