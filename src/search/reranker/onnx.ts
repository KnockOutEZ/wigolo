import { downloadModelAssets } from './download.js';
import { resolveModelId } from './models.js';
import {
  getRerankSubprocess,
  resetAllRerankSubprocesses,
} from '../../python/reranker-subprocess.js';
import { getConfig } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('reranker');

export interface RerankDoc { text: string; }
export interface RerankScore { index: number; score: number; }

export async function onnxRerank(
  query: string,
  docs: RerankDoc[],
  opts: { modelId?: string; maxLength?: number } = {},
): Promise<RerankScore[]> {
  if (docs.length === 0) return [];
  const cfg = getConfig();
  const modelId = resolveModelId(opts.modelId ?? cfg.rerankerModel ?? 'bge-reranker-v2-m3');
  const maxLength = opts.maxLength
    ?? envInt('WIGOLO_RERANKER_MAX_LENGTH', 512);

  await downloadModelAssets(modelId, cfg.dataDir);

  log.debug('rerank dispatch', { modelId, maxLength, docs: docs.length });
  const proc = getRerankSubprocess(modelId, maxLength);
  const scores = await proc.score(query, docs.map((d) => d.text));

  return scores
    .map((score, index) => ({ index, score }))
    .sort((a, b) => b.score - a.score);
}

/** Legacy export — no native ORT sessions to dispose post-migration. */
export async function disposeOnnxSessions(): Promise<void> {
  // No-op. Retained to preserve warmup.ts import surface.
}

/** Legacy export — clears the new subprocess registry. */
export function _resetOnnxSessionCache(): void {
  resetAllRerankSubprocesses();
}

function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (!v) return defaultValue;
  const parsed = parseInt(v, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
