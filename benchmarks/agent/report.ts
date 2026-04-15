import { createLogger } from '../../src/logger.js';
import type { AgentBenchmarkReport } from './types.js';

const log = createLogger('extract');

export function generateAgentMarkdownReport(report: AgentBenchmarkReport): string {
  try {
    const { summary, results } = report;
    const lines: string[] = [];

    lines.push('# Agent Benchmark Report');
    lines.push('');
    lines.push(`**Run Date:** ${report.runDate}`);
    lines.push(`**Duration:** ${(report.durationMs / 1000).toFixed(1)}s`);
    lines.push(`**Total Tasks:** ${summary.totalTasks}`);
    lines.push(`**Successful:** ${summary.successfulTasks} | **Failed:** ${summary.failedTasks}`);
    lines.push('');

    lines.push('## Overall Metrics');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Completion Rate | ${(summary.taskCompletionRate * 100).toFixed(1)}% |`);
    lines.push(`| Factual Accuracy | ${(summary.averageFactualAccuracy * 100).toFixed(1)}% |`);
    lines.push(`| Citation Accuracy | ${(summary.averageCitationAccuracy * 100).toFixed(1)}% |`);
    lines.push(`| Completeness | ${(summary.averageCompleteness * 100).toFixed(1)}% |`);
    lines.push(`| Avg Pages Fetched | ${summary.averagePagesFetched.toFixed(1)} |`);
    lines.push(`| Avg Latency | ${summary.averageLatencyMs.toFixed(0)}ms |`);
    lines.push('');

    // Task type breakdown
    const types = Object.keys(summary.byTaskType);
    if (types.length > 0) {
      lines.push('## By Task Type');
      lines.push('');
      lines.push('| Task Type | Count | Completion | Accuracy | Completeness | Avg Latency |');
      lines.push('|-----------|-------|------------|----------|--------------|-------------|');
      for (const type of types) {
        const t = summary.byTaskType[type];
        lines.push(`| ${type} | ${t.count} | ${(t.completionRate * 100).toFixed(0)}% | ${(t.averageAccuracy * 100).toFixed(1)}% | ${(t.averageCompleteness * 100).toFixed(1)}% | ${t.averageLatencyMs.toFixed(0)}ms |`);
      }
      lines.push('');
    }

    // Per-task details
    lines.push('## Detailed Results');
    lines.push('');
    lines.push('| Task ID | Type | Accuracy | Completeness | Facts | Pages | Latency |');
    lines.push('|---------|------|----------|--------------|-------|-------|---------|');
    for (const r of results) {
      const errMark = r.error ? ' ERR' : '';
      lines.push(`| ${r.taskId}${errMark} | ${r.taskType} | ${(r.factualAccuracy * 100).toFixed(0)}% | ${(r.completeness * 100).toFixed(0)}% | ${r.factsFound}/${r.factsTotal} | ${r.pagesFetched} | ${r.latencyMs}ms |`);
    }
    lines.push('');

    return lines.join('\n');
  } catch (err) {
    log.error('generateAgentMarkdownReport failed', { error: String(err) });
    return '# Agent Benchmark Report\n\nError generating report.';
  }
}

export function generateAgentJsonReport(report: AgentBenchmarkReport): string {
  try {
    return JSON.stringify(report, null, 2);
  } catch (err) {
    log.error('generateAgentJsonReport failed', { error: String(err) });
    return JSON.stringify({ error: String(err) });
  }
}
