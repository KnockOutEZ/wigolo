import { execSync } from 'node:child_process';
import { getPythonBin } from '../../python-env.js';

export interface PythonProbeResult {
  flashrank: 'ok' | 'missing';
  trafilatura: 'ok' | 'missing';
  embeddings: 'ok' | 'missing';
}

const PROBE_TIMEOUT_MS = 3000;

export function probePythonPackages(dataDir: string): PythonProbeResult {
  const py = getPythonBin(dataDir);
  return {
    flashrank: tryImport(py, 'flashrank'),
    trafilatura: tryImport(py, 'trafilatura'),
    embeddings: tryImport(py, 'sentence_transformers'),
  };
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
