import { createRequire } from 'node:module';
import { getConfig } from '../config.js';
import { getBootstrapState } from '../searxng/bootstrap.js';
import { readCacheStats } from './tui/status-cache.js';
import { probePythonPackages } from './tui/status-python.js';
import { readConnectedAgents } from './tui/status-agents.js';
import { formatStatus, type StatusBag } from './tui/status-format.js';

const require = createRequire(import.meta.url);
interface PackageJson { version?: string }
const pkg = require('../../package.json') as PackageJson;

export async function runStatus(_args: string[]): Promise<number> {
  const dataDir = getConfig().dataDir;

  const bootstrap = getBootstrapState(dataDir);
  const searxng: StatusBag['searxng'] =
    bootstrap === null ? 'pending' :
    bootstrap.status === 'ready' ? 'ready' :
    bootstrap.status === 'failed' ? 'failed' :
    'pending';

  const python = probePythonPackages(dataDir);
  const cache = readCacheStats(dataDir);
  const agents = readConnectedAgents({});

  const bag: StatusBag = {
    version: pkg.version ?? '0.0.0',
    searxng,
    flashrank: python.flashrank,
    trafilatura: python.trafilatura,
    embeddings: python.embeddings,
    cache,
    agents,
  };

  process.stderr.write(formatStatus(bag));
  return 0;
}
