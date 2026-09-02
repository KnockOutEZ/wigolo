import { createRequire } from 'node:module';
import { getConfig } from '../config.js';
import { getBootstrapState } from '../searxng/bootstrap.js';
import { readCacheStats } from './tui/status-cache.js';
import { probePythonPackages } from './tui/status-python.js';
import { readConnectedAgents } from './tui/status-agents.js';
import { formatStatus, type StatusBag } from './tui/status-format.js';
import { readEscalationCounters } from '../companion/escalation-counters.js';
import { resolveBrowserTier } from '../fetch/browser-tier.js';
import { readTierOccupancy } from '../fetch/tier-occupancy.js';
import { readSubstrateRecord } from '../companion/substrate-acquire.js';

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

  // D10(a): surface the escalation counters here as well as in `doctor`, because this is the command a
  // user actually runs. Rendered ONLY once the browser session has been used at all — printing a block of
  // zeroes for everyone would make the section noise, and noise gets skipped when it finally matters.
  const counters = readEscalationCounters(dataDir);
  const used = counters.bridgeAttempted + counters.budgetRefused + counters.cardShown + counters.cardUnattended;
  const cfg = getConfig();

  // D-S10-2: read the ONE resolver. `status` does not probe the display itself.
  const tier = resolveBrowserTier();
  const substrate = readSubstrateRecord(dataDir);

  // D-S10-4: the row for the tier this host resolved to right now. Rendered only once something
  // has been fetched, on the same reasoning as browserSession above.
  const rungs = readTierOccupancy(dataDir)[tier.tier];
  const rungsUsed = Object.values(rungs).some((n) => n > 0);

  const bag: StatusBag = {
    version: pkg.version ?? '0.0.0',
    browserTier: {
      tier: tier.tier,
      detail: tier.detail,
      ...(tier.ceiling ? { ceiling: tier.ceiling } : {}),
      ...(tier.remedy ? { remedy: tier.remedy } : {}),
      // S10-d: whether the desktop component was actually acquired. Rendered ALWAYS, unlike the
      // counter blocks above, because "not installed" is the informative state here — a rung
      // reported without saying whether its component is on disk is the ambiguity this closes.
      desktopComponent: substrate ? `installed (version ${substrate.version})` : 'not installed',
    },
    ...(rungsUsed ? { rungsUsed: rungs } : {}),
    searxng,
    reranker: python.reranker,
    embeddings: python.embeddings,
    cache,
    agents,
    ...(used > 0
      ? {
          browserSession: {
            signedInBudget: cfg.studioOriginBudget,
            anonymousBudget: cfg.studioAnonymousOriginBudget,
            bridgeAttempted: counters.bridgeAttempted,
            bridgeServed: counters.bridgeServed,
            budgetRefused: counters.budgetRefused,
            cardShown: counters.cardShown,
            cardUnattended: counters.cardUnattended,
          },
        }
      : {}),
  };

  if (_args.includes('--json')) {
    // Machine shape on stdout; keep the pretty block off stdout so the output
    // pipes cleanly through jq. `status` is informational — runStatus never
    // fails, so it is always 'ok'.
    process.stdout.write(`${JSON.stringify({ status: 'ok', ...bag })}\n`);
    return 0;
  }

  process.stderr.write(formatStatus(bag));
  return 0;
}
