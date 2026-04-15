import { createLogger } from '../../src/logger.js';
import type {
  ExpectedFact,
  FactEvaluation,
  TaskEvaluation,
  TaskType,
  TaskExecutionResult,
} from './types.js';

const log = createLogger('extract');

export function normalizeForComparison(text: string): string {
  try {
    if (!text || typeof text !== 'string') return '';
    return text
      .toLowerCase()
      .replace(/[,!?;:'"()[\]{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (err) {
    log.warn('normalizeForComparison failed', { error: String(err) });
    return '';
  }
}

function wordTokenize(text: string): string[] {
  return normalizeForComparison(text).split(/\s+/).filter(w => w.length > 0);
}

function computeWordOverlap(factWords: string[], contentWords: Set<string>): number {
  if (factWords.length === 0) return 0;
  let matches = 0;
  for (const word of factWords) {
    if (contentWords.has(word)) matches++;
  }
  return matches / factWords.length;
}

export function evaluateFact(fact: ExpectedFact, content: string): FactEvaluation {
  try {
    if (!fact.fact || fact.fact.length === 0 || !content || content.length === 0) {
      return {
        fact: fact.fact,
        required: fact.required,
        found: false,
        matchType: 'not-found',
        confidence: 0,
      };
    }

    const normalizedContent = normalizeForComparison(content);
    const normalizedFact = normalizeForComparison(fact.fact);

    // Exact substring match
    if (normalizedContent.includes(normalizedFact)) {
      return {
        fact: fact.fact,
        required: fact.required,
        found: true,
        matchType: 'exact',
        confidence: 1,
      };
    }

    // Case-insensitive substring (already lowercased, but check original for partial patterns)
    if (content.toLowerCase().includes(fact.fact.toLowerCase())) {
      return {
        fact: fact.fact,
        required: fact.required,
        found: true,
        matchType: 'substring',
        confidence: 0.9,
      };
    }

    // Semantic: word overlap above threshold
    const factWords = wordTokenize(fact.fact);
    const contentWordsSet = new Set(wordTokenize(content));
    const overlap = computeWordOverlap(factWords, contentWordsSet);

    if (overlap >= 0.6) {
      return {
        fact: fact.fact,
        required: fact.required,
        found: true,
        matchType: 'semantic',
        confidence: overlap * 0.8,
      };
    }

    return {
      fact: fact.fact,
      required: fact.required,
      found: false,
      matchType: 'not-found',
      confidence: 0,
    };
  } catch (err) {
    log.warn('evaluateFact failed', { fact: fact.fact, error: String(err) });
    return {
      fact: fact.fact,
      required: fact.required,
      found: false,
      matchType: 'not-found',
      confidence: 0,
    };
  }
}

export function computeFactualAccuracy(evaluations: FactEvaluation[]): number {
  try {
    if (evaluations.length === 0) return 0;
    const totalConfidence = evaluations.reduce((sum, e) => sum + e.confidence, 0);
    return totalConfidence / evaluations.length;
  } catch (err) {
    log.warn('computeFactualAccuracy failed', { error: String(err) });
    return 0;
  }
}

export function computeCitationAccuracy(evaluations: (FactEvaluation & { category?: string })[]): number {
  try {
    const citationEvals = evaluations.filter(e => e.category === 'citation');
    if (citationEvals.length === 0) return 1; // vacuously true
    const found = citationEvals.filter(e => e.found).length;
    return found / citationEvals.length;
  } catch (err) {
    log.warn('computeCitationAccuracy failed', { error: String(err) });
    return 0;
  }
}

export function computeCompleteness(evaluations: FactEvaluation[]): number {
  try {
    const required = evaluations.filter(e => e.required);
    if (required.length === 0) return 1; // no requirements => complete
    const found = required.filter(e => e.found).length;
    return found / required.length;
  } catch (err) {
    log.warn('computeCompleteness failed', { error: String(err) });
    return 0;
  }
}

export function evaluateTask(
  taskId: string,
  taskType: TaskType,
  query: string,
  execution: TaskExecutionResult,
  expectedFacts: ExpectedFact[],
): TaskEvaluation {
  try {
    const taskFacts = expectedFacts.filter(f => f.taskId === taskId);

    const factEvaluations = taskFacts.map(fact =>
      evaluateFact(fact, execution.collectedContent),
    );

    const factsFound = factEvaluations.filter(e => e.found).length;
    const requiredEvals = factEvaluations.filter(e => e.required);
    const requiredFound = requiredEvals.filter(e => e.found).length;

    const factualAccuracy = computeFactualAccuracy(factEvaluations);
    const citationAccuracy = computeCitationAccuracy(
      factEvaluations.map((e, i) => ({ ...e, category: taskFacts[i]?.category })),
    );
    const completeness = computeCompleteness(factEvaluations);

    const pagesFetched = execution.steps.filter(s => s.tool === 'fetch').length;

    return {
      taskId,
      taskType,
      query,
      factEvaluations,
      factsFound,
      factsTotal: taskFacts.length,
      requiredFactsFound: requiredFound,
      requiredFactsTotal: requiredEvals.length,
      factualAccuracy,
      citationAccuracy,
      completeness,
      pagesFetched,
      totalSteps: execution.steps.length,
      latencyMs: execution.totalDurationMs,
      error: execution.error,
    };
  } catch (err) {
    log.error('evaluateTask failed', { taskId, error: String(err) });
    return {
      taskId,
      taskType,
      query,
      factEvaluations: [],
      factsFound: 0,
      factsTotal: expectedFacts.filter(f => f.taskId === taskId).length,
      requiredFactsFound: 0,
      requiredFactsTotal: expectedFacts.filter(f => f.taskId === taskId && f.required).length,
      factualAccuracy: 0,
      citationAccuracy: 0,
      completeness: 0,
      pagesFetched: 0,
      totalSteps: 0,
      latencyMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
