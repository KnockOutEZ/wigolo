import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runPythonWithStdin } from '../extraction/trafilatura.js';
import { createLogger } from '../logger.js';

const execFileAsync = promisify(execFileCb);
const log = createLogger('search');

export interface RerankPassage {
  text: string;
  index: number;
}

export interface RerankResult {
  index: number;
  score: number;
}

const FLASHRANK_SCRIPT = `
import sys, json
from flashrank import Ranker, RerankRequest
data = json.loads(sys.stdin.read())
ranker = Ranker(model_name=data.get('model', 'ms-marco-MiniLM-L-12-v2'))
passages = [{"id": p["index"], "text": p["text"]} for p in data["passages"]]
req = RerankRequest(query=data["query"], passages=passages)
results = ranker.rerank(req)
print(json.dumps([{"index": int(r.metadata["id"] if hasattr(r, "metadata") else r["id"]), "score": float(r.score if hasattr(r, "score") else r["score"])} for r in results]))
`.trim();

const SUBPROCESS_TIMEOUT_MS = 30000;
const AVAILABILITY_CHECK_TIMEOUT_MS = 5000;

let availableCache: boolean | null = null;

export async function isFlashRankAvailable(): Promise<boolean> {
  if (availableCache !== null) return availableCache;
  try {
    await execFileAsync('python3', ['-c', 'import flashrank'], { timeout: AVAILABILITY_CHECK_TIMEOUT_MS });
    availableCache = true;
  } catch {
    availableCache = false;
  }
  return availableCache;
}

export function resetAvailabilityCache(): void {
  availableCache = null;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}

export async function flashRankRerank(
  query: string,
  passages: RerankPassage[],
  model?: string,
): Promise<RerankResult[] | null> {
  if (passages.length === 0) return [];

  try {
    const input = JSON.stringify({
      query,
      passages,
      model: model ?? 'ms-marco-MiniLM-L-12-v2',
    });

    const stdout = await runPythonWithStdin(FLASHRANK_SCRIPT, input, SUBPROCESS_TIMEOUT_MS);
    const parsed = JSON.parse(stdout.trim());

    if (!Array.isArray(parsed)) {
      log.warn('FlashRank returned non-array output', { output: stdout.slice(0, 200) });
      return null;
    }

    return parsed.map((r: { index: number; score: number }) => ({
      index: r.index,
      score: clampScore(r.score),
    }));
  } catch (err) {
    log.warn('FlashRank reranking failed, falling back to position scores', { error: String(err) });
    return null;
  }
}
