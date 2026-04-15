import { createLogger } from '../../src/logger.js';
import type {
  AgentTask,
  TaskExecutionResult,
  ExecutionStep,
} from './types.js';
import type { SearchInput, SearchOutput, FetchInput, FetchOutput } from '../../src/types.js';

const log = createLogger('extract');

const DEFAULT_MAX_STEPS = 5;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CHARS = 20000;

type SearchFn = (input: SearchInput) => Promise<SearchOutput>;
type FetchFn = (input: FetchInput) => Promise<FetchOutput>;

export function buildSearchInput(task: AgentTask): SearchInput {
  try {
    const input: SearchInput = {
      query: task.query,
      max_results: DEFAULT_MAX_RESULTS,
      include_content: true,
      content_max_chars: DEFAULT_MAX_CHARS,
    };

    if (task.expectedDomains && task.expectedDomains.length > 0) {
      input.include_domains = task.expectedDomains;
    }

    return input;
  } catch (err) {
    log.warn('buildSearchInput failed', { taskId: task.id, error: String(err) });
    return { query: task.query };
  }
}

export function buildFetchInput(url: string): FetchInput {
  return {
    url,
    render_js: 'auto',
    max_chars: DEFAULT_MAX_CHARS,
  };
}

export async function executeTask(
  task: AgentTask,
  searchFn: SearchFn,
  fetchFn: FetchFn,
): Promise<TaskExecutionResult> {
  const startTime = Date.now();
  const steps: ExecutionStep[] = [];
  const collectedContent: string[] = [];
  const collectedUrls: string[] = [];
  const maxSteps = task.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = startTime + timeoutMs;

  try {
    // Step 1: Search
    const searchInput = buildSearchInput(task);
    const searchStart = Date.now();
    let searchOutput: SearchOutput;

    try {
      searchOutput = await searchFn(searchInput);
      steps.push({
        tool: 'search',
        input: searchInput as unknown as Record<string, unknown>,
        output: searchOutput as unknown as Record<string, unknown>,
        durationMs: Date.now() - searchStart,
      });
    } catch (err) {
      steps.push({
        tool: 'search',
        input: searchInput as unknown as Record<string, unknown>,
        output: {},
        durationMs: Date.now() - searchStart,
        error: err instanceof Error ? err.message : String(err),
      });

      return {
        taskId: task.id,
        steps,
        collectedContent: '',
        collectedUrls: [],
        totalDurationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Collect content from search results that already have markdown_content
    for (const result of searchOutput.results) {
      if (result.markdown_content) {
        collectedContent.push(result.markdown_content);
        collectedUrls.push(result.url);
      }
    }

    // Step 2+: Fetch individual URLs that didn't have content
    const urlsToFetch = searchOutput.results
      .filter(r => !r.markdown_content && r.url)
      .map(r => r.url);

    let stepCount = 1; // search was step 1
    for (const url of urlsToFetch) {
      if (stepCount >= maxSteps) break;
      if (Date.now() >= deadline) break;

      const fetchInput = buildFetchInput(url);
      const fetchStart = Date.now();

      try {
        const fetchOutput = await fetchFn(fetchInput);
        steps.push({
          tool: 'fetch',
          input: fetchInput as unknown as Record<string, unknown>,
          output: fetchOutput as unknown as Record<string, unknown>,
          durationMs: Date.now() - fetchStart,
        });

        if (fetchOutput.markdown && fetchOutput.markdown.length > 0) {
          collectedContent.push(fetchOutput.markdown);
          collectedUrls.push(fetchOutput.url);
        }
      } catch (err) {
        steps.push({
          tool: 'fetch',
          input: fetchInput as unknown as Record<string, unknown>,
          output: {},
          durationMs: Date.now() - fetchStart,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      stepCount++;
    }

    return {
      taskId: task.id,
      steps,
      collectedContent: collectedContent.join('\n\n---\n\n'),
      collectedUrls,
      totalDurationMs: Date.now() - startTime,
    };
  } catch (err) {
    log.error('executeTask failed', { taskId: task.id, error: String(err) });
    return {
      taskId: task.id,
      steps,
      collectedContent: collectedContent.join('\n\n---\n\n'),
      collectedUrls,
      totalDurationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
