import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { getConfig } from '../config.js';
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

let availableCache: boolean | null = null;

export async function isFlashRankAvailable(): Promise<boolean> {
  if (availableCache !== null) return availableCache;
  try {
    await execFileAsync('python3', ['-c', 'import flashrank'], { timeout: 5000 });
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

function runPythonWithStdin(script: string, stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-c', script], { timeout: timeoutMs });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Python exited ${code}: ${stderr}`));
    });
    proc.on('error', reject);

    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

export async function flashRankRerank(
  query: string,
  passages: RerankPassage[],
  model?: string,
): Promise<RerankResult[] | null> {
  if (passages.length === 0) return [];

  try {
    const config = getConfig();
    const input = JSON.stringify({
      query,
      passages,
      model: model ?? (config as any).rerankerModel,
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
