import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPythonBin } from '../../python-env.js';
import { getConfig } from '../../config.js';
import { resolveModelId } from '../../search/reranker/models.js';

export interface PythonProbeResult {
  reranker: 'ok' | 'missing';
  trafilatura: 'ok' | 'missing';
  embeddings: 'ok' | 'missing';
}

const PROBE_TIMEOUT_MS = 10000;

export function probePythonPackages(dataDir: string): PythonProbeResult {
  const py = getPythonBin(dataDir);
  return {
    reranker: probeOnnxReranker(dataDir),
    trafilatura: tryImport(py, 'trafilatura'),
    embeddings: tryImport(py, 'sentence_transformers'),
  };
}

function probeOnnxReranker(dataDir: string): 'ok' | 'missing' {
  let modelId: string;
  try {
    modelId = resolveModelId(getConfig().rerankerModel);
  } catch {
    return 'missing';
  }
  const dir = join(dataDir, 'models', modelId);
  const required = ['model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json'];
  return required.every((f) => existsSync(join(dir, f))) ? 'ok' : 'missing';
}

function tryImport(py: string, moduleName: string): 'ok' | 'missing' {
  try {
    execSync(`${py} -c "import ${moduleName}"`, {
      stdio: 'pipe',
      timeout: PROBE_TIMEOUT_MS,
    });
    return 'ok';
  } catch {
    return 'missing';
  }
}
