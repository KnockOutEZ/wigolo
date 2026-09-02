import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SmartRouter } from '../../src/fetch/router.js';
import type { HttpClient, BrowserPoolInterface, TlsFetcher, ClearanceStore } from '../../src/fetch/router.js';
import type { RawFetchResult } from '../../src/types.js';
import { ChallengeBlockedError } from '../../src/fetch/browser-pool.js';
import { readEscalationCounters } from '../../src/companion/escalation-counters.js';
import { resetConfig } from '../../src/config.js';

/**
 * EXTRACT Phase-C base-vs-tip differential — the UNPAIRED fetch ladder.
 *
 * The extraction rewires three seams the compiler cannot police: the router's lazy
 * `import('./companion-bridge.js')` resolves by string, the escalation rung's gate is a pair of
 * filesystem stats, and the transport underneath it is being swapped wholesale. Nothing about that
 * shows up as a red import, so the only honest check is behavioural: run the ladder with NO companion
 * paired, record what every rung did, and compare against a capture taken at the pre-extraction tip.
 *
 * Recorded per fixture: the tier call sequence, the final `method`/`statusCode` (or the stage error and
 * its reason), and the escalation counters. The counters are the sharp part — under an unpaired install
 * the rung must never be entered at all, so all three read zero. A capture where `bridgeAttempted` moved
 * means the gate opened on a machine with no companion, which is exactly the regression this guards.
 *
 * MODES
 *  - `CAPTURE=1` writes the baseline and asserts nothing. Run it at the tip you are comparing FROM.
 *  - default: compares against the baseline. The baseline lives under gitignored `internal-docs/`, so on
 *    CI and in fresh clones it is simply absent — that is a typed, logged no-op, never a `.skip` and
 *    never a red.
 *  - `WIGOLO_LADDER_DIFF_REQUIRED=1` turns a no-op into a failure. The Phase-C gate sets it, because a
 *    differential that silently declined to run is indistinguishable from one that passed.
 *
 * `WIGOLO_LADDER_BASELINE_DIR` overrides the baseline directory (the worker worktrees do not carry
 * `internal-docs/` at all — it exists only in the main checkout).
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BASELINE_DIR =
  process.env.WIGOLO_LADDER_BASELINE_DIR ??
  join(REPO_ROOT, 'internal-docs', 'superpowers', 'plans', 'extract-base-capture');
const BASELINE_FILE = join(BASELINE_DIR, 'fetch-ladder-unpaired.json');
const CAPTURE_MODE = process.env.CAPTURE === '1';
const REQUIRED = process.env.WIGOLO_LADDER_DIFF_REQUIRED === '1';

const PLAIN_URL = 'https://plain.example/article';
const CHALLENGE_URL = 'https://walled.example/article';
const SPA_URL = 'https://spa.example/app';

const ARTICLE_HTML = `<html><head><title>plain</title></head><body><article>${'ordinary prose the extractor is happy with. '.repeat(8)}</article></body></html>`;
const HYDRATED_HTML = `<html><head><title>spa</title></head><body><main><article>${'hydrated client-rendered prose that beats the shell threshold. '.repeat(8)}</article></body></html>`;
const SPA_SHELL_HTML = '<html><head><title>spa</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const CHALLENGE_HTML =
  '<html><head><title>Just a moment...</title></head><body><div id="challenge-running"></div><p>Checking your browser before accessing walled.example.</p></body></html>';

/** One fixture's observed ladder behaviour. This shape IS the baseline format. */
interface LadderRecord {
  url: string;
  /** Every leaf tier the router actually entered, in order. */
  tiers: string[];
  outcome: 'served' | 'stage_error';
  method?: string;
  statusCode?: number;
  escalated?: boolean;
  error?: string;
  errorReason?: string;
  challengeClass?: string;
  solveMethod?: string | null;
  /** Escalation-rung counters after the run. Unpaired, every one of these must be 0. */
  counters: { bridgeAttempted: number; bridgeServed: number; bridgeDeclined: number };
}

function httpBody(url: string, html: string, statusCode: number, headers: Record<string, string> = {}) {
  return { url, finalUrl: url, html, contentType: 'text/html', statusCode, headers };
}

/**
 * Run one fixture through a real {@link SmartRouter} with recording leaf tiers and NO companion
 * override, so the escalation rung's own gate (handle stat + launchable substrate) is the live one.
 */
async function runFixture(url: string, dataDir: string): Promise<LadderRecord> {
  const tiers: string[] = [];

  const httpClient: HttpClient = {
    fetch: async (target: string) => {
      tiers.push('http');
      if (target.startsWith('https://plain.')) return httpBody(target, ARTICLE_HTML, 200);
      if (target.startsWith('https://spa.')) return httpBody(target, SPA_SHELL_HTML, 200);
      return httpBody(target, CHALLENGE_HTML, 403, { 'cf-mitigated': 'challenge', server: 'cloudflare' });
    },
  };

  const tlsFetcher: TlsFetcher = async (target: string) => {
    tiers.push('tls');
    if (target.startsWith('https://walled.')) {
      return httpBody(target, CHALLENGE_HTML, 403, { 'cf-mitigated': 'challenge', server: 'cloudflare' });
    }
    return httpBody(target, ARTICLE_HTML, 200);
  };

  const browserPool: BrowserPoolInterface = {
    fetchWithBrowser: async (target: string): Promise<RawFetchResult> => {
      tiers.push('browser');
      if (target.startsWith('https://walled.')) throw new ChallengeBlockedError(target);
      return {
        url: target,
        finalUrl: target,
        html: HYDRATED_HTML,
        contentType: 'text/html',
        statusCode: 200,
        method: 'browser',
        headers: {},
      };
    },
  };

  const clearanceStore: ClearanceStore = {
    get: () => null,
    clear: () => {},
    getBackoff: () => null,
    recordBackoff: () => {},
  };

  const router = new SmartRouter({
    httpClient,
    browserPool,
    tlsFetcher,
    pdfProbe: async () => false,
    clearanceStore,
  });

  const result = (await router.fetch(url, { renderJs: 'auto' })) as unknown as Record<string, unknown>;
  const counters = readEscalationCounters(dataDir);
  const base = {
    url,
    tiers,
    counters: {
      bridgeAttempted: counters.bridgeAttempted,
      bridgeServed: counters.bridgeServed,
      bridgeDeclined: counters.bridgeDeclined,
    },
  };

  if (typeof result.error === 'string') {
    return {
      ...base,
      outcome: 'stage_error',
      error: result.error,
      ...(typeof result.error_reason === 'string' ? { errorReason: result.error_reason } : {}),
      ...(typeof result.challenge_class === 'string' ? { challengeClass: result.challenge_class } : {}),
      ...('solve_method' in result ? { solveMethod: (result.solve_method as string | null) ?? null } : {}),
    };
  }
  return {
    ...base,
    outcome: 'served',
    method: result.method as string,
    statusCode: result.statusCode as number,
    escalated: result.escalated === true,
  };
}

describe('EXTRACT — unpaired fetch-ladder differential', () => {
  let dataDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // A data dir with no `studio/current.json` IS the unpaired install, and auto-launch off keeps a
    // machine that happens to have the substrate installed from opening the gate the capture is about.
    dataDir = mkdtempSync(join(tmpdir(), 'wig-ladder-diff-'));
    process.env.WIGOLO_DATA_DIR = dataDir;
    process.env.WIGOLO_STUDIO_AUTO_LAUNCH = '0';
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('matches the pre-extraction capture rung for rung', async () => {
    const records: LadderRecord[] = [];
    for (const url of [PLAIN_URL, CHALLENGE_URL, SPA_URL]) {
      records.push(await runFixture(url, dataDir));
    }

    if (CAPTURE_MODE) {
      mkdirSync(BASELINE_DIR, { recursive: true });
      writeFileSync(BASELINE_FILE, `${JSON.stringify({ fixtures: records }, null, 2)}\n`);
      // Capture mode asserts only that the capture is non-empty — the comparison is the next run's job.
      expect(records).toHaveLength(3);
      return;
    }

    if (!existsSync(BASELINE_FILE)) {
      const reason = `fetch-ladder differential: no baseline at ${BASELINE_FILE} — comparison skipped (capture with CAPTURE=1)`;
      // Deliberately not `.skip`: the test body ran, the reason is on the record, and the gate below
      // turns this same state into a failure where the differential is load-bearing.
      process.stderr.write(`${reason}\n`);
      expect(REQUIRED, reason).toBe(false);
      return;
    }

    const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8')) as { fixtures: LadderRecord[] };
    expect(records).toEqual(baseline.fixtures);
    // The unpaired rung must never be entered. Asserted separately from the deep-equal so a baseline
    // captured on a machine that DID reach the bridge cannot quietly bless that as "identical".
    for (const record of records) {
      expect(record.counters).toEqual({ bridgeAttempted: 0, bridgeServed: 0, bridgeDeclined: 0 });
    }
  });
});
