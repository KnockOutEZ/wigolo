import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * EXTRACT C6 — `status` is a §2.2 consumer whose implementation moved: the two blocks it renders
 * about the browser session now come from `src/companion/*` rather than from the deleted domain
 * layer. The sibling suites (`status.test.ts`, `doctor-browser-tier.test.ts`) already pin what the
 * FORMATTER prints; neither pins WHERE the numbers came from, so both would stay green if the
 * command were re-pointed at a stale copy of those modules or stopped calling them at all and the
 * formatter fell back to its own defaults.
 *
 * So this file mocks the companion modules to sentinel values and asserts the sentinels reach the
 * machine-readable output. Every assertion here fails if the import moves off `src/companion/`.
 */

const { cfg, readSubstrateRecordMock, readEscalationCountersMock } = vi.hoisted(() => ({
  cfg: {
    dataDir: '/tmp/wigolo-companion-status',
    studioOriginBudget: 40,
    studioAnonymousOriginBudget: 4,
  },
  readSubstrateRecordMock: vi.fn(),
  readEscalationCountersMock: vi.fn(),
}));

vi.mock('../../../src/cli/tui/status-cache.js', () => ({
  readCacheStats: vi.fn().mockReturnValue({ pages: 0, bytes: 0 }),
}));
vi.mock('../../../src/cli/tui/status-python.js', () => ({
  probePythonPackages: vi.fn().mockReturnValue({ reranker: 'ok', embeddings: 'ok' }),
}));
vi.mock('../../../src/cli/tui/status-agents.js', () => ({
  readConnectedAgents: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../src/searxng/bootstrap.js', () => ({
  getBootstrapState: vi.fn().mockReturnValue({ status: 'ready' }),
}));
vi.mock('../../../src/config.js', () => ({ getConfig: () => cfg }));

// The two seams under test. Mocked at the companion path — if `status` imported these symbols from
// anywhere else, the mocks would not apply and every sentinel assertion below would miss.
vi.mock('../../../src/companion/substrate-acquire.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/companion/substrate-acquire.js')>()),
  readSubstrateRecord: readSubstrateRecordMock,
}));
vi.mock('../../../src/companion/escalation-counters.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/companion/escalation-counters.js')>()),
  readEscalationCounters: readEscalationCountersMock,
}));

import { runStatus } from '../../../src/cli/status.js';

const NO_ESCALATIONS = {
  bridgeAttempted: 0,
  bridgeServed: 0,
  bridgeDeclined: 0,
  budgetRefused: 0,
  cardShown: 0,
  cardApproved: 0,
  cardRefused: 0,
  cardUnattended: 0,
};

beforeEach(() => {
  readSubstrateRecordMock.mockReset().mockReturnValue(null);
  readEscalationCountersMock.mockReset().mockReturnValue({ ...NO_ESCALATIONS });
});

interface StatusJson {
  status: string;
  browserTier: { desktopComponent: string };
  browserSession?: {
    signedInBudget: number;
    anonymousBudget: number;
    bridgeAttempted: number;
    bridgeServed: number;
    budgetRefused: number;
    cardShown: number;
    cardUnattended: number;
  };
}

async function statusJson(): Promise<StatusJson> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = ((s: string | Uint8Array) => {
    chunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf-8'));
    return true;
  });
  (process.stderr.write as unknown) = (() => true);
  try {
    const code = await runStatus(['--json']);
    expect(code).toBe(0);
  } finally {
    (process.stdout.write as unknown) = orig;
    (process.stderr.write as unknown) = origErr;
  }
  return JSON.parse(chunks.join('')) as StatusJson;
}

describe('status — desktop-component state comes from the companion substrate module', () => {
  it('reports the version the companion record carries, not a generic "installed"', async () => {
    // WHY the version and not just the word: two hosts that both say "installed" but hold
    // different component versions are the support case this line exists to tell apart, and a
    // version echoed from the record is the only part of the line that cannot be hard-coded.
    readSubstrateRecordMock.mockReturnValue({ version: '9.9.9-pin', executable: 'bin/run' });
    const bag = await statusJson();
    expect(bag.browserTier.desktopComponent).toContain('9.9.9-pin');
    expect(bag.browserTier.desktopComponent).toContain('installed');
  });

  it('reports "not installed" when the companion module has no record', async () => {
    readSubstrateRecordMock.mockReturnValue(null);
    const bag = await statusJson();
    expect(bag.browserTier.desktopComponent).toBe('not installed');
  });

  it('asks the companion module about the configured data dir, not a default of its own', async () => {
    // A reader pointed at the wrong directory reports another profile's state as this one's.
    await statusJson();
    expect(readSubstrateRecordMock).toHaveBeenCalledWith(cfg.dataDir);
  });
});

describe('status — browser-session counters come from the companion escalation module', () => {
  it('surfaces each counter separately, so dropping any one of them reds', async () => {
    // WHY each on its own (tracker rule 7): summarising the block by its total would let a
    // regression that zeroes one lane stay green as long as the others moved.
    readEscalationCountersMock.mockReturnValue({
      ...NO_ESCALATIONS,
      bridgeAttempted: 11,
      bridgeServed: 7,
      budgetRefused: 3,
      cardShown: 5,
      cardUnattended: 2,
    });
    const bag = await statusJson();
    expect(bag.browserSession).toBeDefined();
    expect(bag.browserSession!.bridgeAttempted).toBe(11);
    expect(bag.browserSession!.bridgeServed).toBe(7);
    expect(bag.browserSession!.budgetRefused).toBe(3);
    expect(bag.browserSession!.cardShown).toBe(5);
    expect(bag.browserSession!.cardUnattended).toBe(2);
  });

  it('names BOTH origin budgets alongside the counters', async () => {
    // The counters are unreadable without the limits they were measured against.
    readEscalationCountersMock.mockReturnValue({ ...NO_ESCALATIONS, bridgeAttempted: 1 });
    const bag = await statusJson();
    expect(bag.browserSession!.signedInBudget).toBe(cfg.studioOriginBudget);
    expect(bag.browserSession!.anonymousBudget).toBe(cfg.studioAnonymousOriginBudget);
  });

  it('omits the whole block while the session has never been used', async () => {
    // D10(a): a block of zeroes printed for everyone becomes noise, and noise gets skipped when
    // it finally matters. Pinned here because the emptiness test lives on the companion counters.
    readEscalationCountersMock.mockReturnValue({ ...NO_ESCALATIONS });
    const bag = await statusJson();
    expect(bag.browserSession).toBeUndefined();
  });

  it('asks the companion module about the configured data dir', async () => {
    await statusJson();
    expect(readEscalationCountersMock).toHaveBeenCalledWith(cfg.dataDir);
  });
});
