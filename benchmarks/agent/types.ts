export type TaskType = 'fact-lookup' | 'multi-step-research' | 'data-extraction' | 'comparison' | 'code-docs';

export interface AgentTask {
  id: string;
  type: TaskType;
  description: string;
  query: string;
  expectedUrls?: string[];
  expectedDomains?: string[];
  tags?: string[];
  maxSteps?: number;
  timeoutMs?: number;
}

export interface ExpectedFact {
  taskId: string;
  fact: string;
  required: boolean;
  category?: 'factual' | 'citation' | 'completeness';
}

export interface ExpectedOutput {
  taskId: string;
  facts: ExpectedFact[];
  minimumFactCount?: number;
}

export interface FactEvaluation {
  fact: string;
  required: boolean;
  found: boolean;
  matchType: 'exact' | 'substring' | 'semantic' | 'not-found';
  matchedIn?: string;
  confidence: number;
}

export interface TaskEvaluation {
  taskId: string;
  taskType: TaskType;
  query: string;
  factEvaluations: FactEvaluation[];
  factsFound: number;
  factsTotal: number;
  requiredFactsFound: number;
  requiredFactsTotal: number;
  factualAccuracy: number;
  citationAccuracy: number;
  completeness: number;
  pagesFetched: number;
  totalSteps: number;
  latencyMs: number;
  error?: string;
}

export interface AgentBenchmarkSummary {
  totalTasks: number;
  successfulTasks: number;
  failedTasks: number;
  taskCompletionRate: number;
  averageFactualAccuracy: number;
  averageCitationAccuracy: number;
  averageCompleteness: number;
  averagePagesFetched: number;
  averageLatencyMs: number;
  byTaskType: Record<string, TaskTypeSummary>;
}

export interface TaskTypeSummary {
  count: number;
  completionRate: number;
  averageAccuracy: number;
  averageCompleteness: number;
  averageLatencyMs: number;
}

export interface AgentBenchmarkReport {
  runDate: string;
  durationMs: number;
  summary: AgentBenchmarkSummary;
  results: TaskEvaluation[];
}

export interface AgentRunnerOptions {
  tasksPath: string;
  expectedPath: string;
  outputDir: string;
  filter?: string;
  verbose?: boolean;
  maxConcurrency?: number;
}

export interface ExecutionStep {
  tool: 'search' | 'fetch';
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  durationMs: number;
  error?: string;
}

export interface TaskExecutionResult {
  taskId: string;
  steps: ExecutionStep[];
  collectedContent: string;
  collectedUrls: string[];
  totalDurationMs: number;
  error?: string;
}
