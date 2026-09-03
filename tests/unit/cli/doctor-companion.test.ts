import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * EXTRACT C6 — `doctor` is a §2.2 consumer whose implementation moved. Three of its reported
 * facts now come from `src/companion/*`: the signed-in origin COUNT, the escalation counters, and
 * whether the desktop component is on disk.
 *
 * `doctor-browser-tier.test.ts` already covers the line BUILDERS in isolation, which is why this
 * file drives the real `runDoctor` instead: a builder test cannot tell a wired-up section from a
 * section whose call site was dropped in the extraction, and `checkAuthenticatedOrigins` is not
 * exported, so its wiring has no other way to be observed. Each companion module is mocked to a
 * sentinel and the sentinel is asserted in doctor's own stderr output.
 */

vi.mock('node:child_process', () => ({ execSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn(), readdirSync: vi.fn(() => []) };
});
// doctor probes browser health with a real headless launch; stub the engine so the probe never
// spawns one. Nothing in this file is about the browser probe.
vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/engine/chrome'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/engine/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/engine/webkit'), launch: vi.fn(okLaunch) },
  };
});
vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({ modelId: 'stub', rerank: vi.fn().mockResolvedValue([]) })),
}));
vi.mock('../../../src/cli/warmup.js', () => ({
  installBrowser: vi.fn(async () => ({ ok: true, error: undefined })),
  installEmbeddings: vi.fn(async () => ({ embeddings: 'ok', embeddingsError: undefined })),
  wipeSearxngState: vi.fn(),
}));
vi.mock('../../../src/security/keychain.js', () => ({
  keychainAvailable: vi.fn(() => false),
  keychainGet: vi.fn(() => null),
  keychainSet: vi.fn(),
  keychainDelete: vi.fn(),
}));
vi.mock('../../../src/account/client.js', () => ({
  AccountsClient: class { async status() { return null; } },
}));

const { authenticatedOriginCountMock, readEscalationCountersMock, readSubstrateRecordMock } = vi.hoisted(() => ({
  authenticatedOriginCountMock: vi.fn(),
  readEscalationCountersMock: vi.fn(),
  readSubstrateRecordMock: vi.fn(),
}));

// The three seams under test, mocked at their companion paths. An import that moved off
// `src/companion/` would leave these mocks unused and every sentinel assertion would miss.
vi.mock('../../../src/companion/auth-origin-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/companion/auth-origin-store.js')>()),
  authenticatedOriginCount: authenticatedOriginCountMock,
}));
vi.mock('../../../src/companion/escalation-counters.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/companion/escalation-counters.js')>()),
  readEscalationCounters: readEscalationCountersMock,
}));
vi.mock('../../../src/companion/substrate-acquire.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/companion/substrate-acquire.js')>()),
  readSubstrateRecord: readSubstrateRecordMock,
}));

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { runDoctor } from '../../../src/cli/doctor.js';
import { resetConfig } from '../../../src/config.js';
import { resetBreakers } from '../../../src/search/core/engine-base.js';
import { resetBrowserTierAnnouncements, BROWSER_TIER_ENV } from '../../../src/fetch/browser-tier.js';

const DATA_DIR = '/tmp/wigolo-companion-doctor';

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

let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let output = '';

beforeEach(() => {
  output = '';
  resetConfig();
  resetBrowserTierAnnouncements();
  vi.clearAllMocks();
  authenticatedOriginCountMock.mockReturnValue(0);
  readEscalationCountersMock.mockReturnValue({ ...NO_ESCALATIONS });
  readSubstrateRecordMock.mockReturnValue(null);
  vi.mocked(spawnSync).mockReturnValue({
    status: 0, stdout: 'Python 3.12.4', stderr: '', signal: null, pid: 1, output: [], error: undefined,
  } as ReturnType<typeof spawnSync>);
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readFileSync).mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
    return '{}';
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  resetConfig();
  resetBreakers();
  delete process.env[BROWSER_TIER_ENV];
});

async function doctorOutput(): Promise<string> {
  await runDoctor(DATA_DIR);
  return output;
}

describe('doctor — browser-session block reads the companion origin store', () => {
  it('prints the count the companion module reports', async () => {
    authenticatedOriginCountMock.mockReturnValue(42);
    expect(await doctorOutput()).toContain('Signed-in origins: 42');
  });

  it('still prints the count when it is zero, rather than hiding the section', async () => {
    // A section that disappears at zero is indistinguishable from a section that broke, which is
    // the ambiguity a privacy-relevant number can least afford.
    authenticatedOriginCountMock.mockReturnValue(0);
    expect(await doctorOutput()).toContain('Signed-in origins: 0');
  });

  it('never prints the origins themselves, only how many there are (S9/F5)', async () => {
    // The list is browsing history. Pinned at the doctor boundary because that is where a
    // well-meaning "make it more helpful" change would land.
    authenticatedOriginCountMock.mockReturnValue(2);
    const text = await doctorOutput();
    expect(text).toContain('Signed-in origins: 2');
    expect(text).toMatch(/count only/i);
  });
});

describe('doctor — escalation counters read the companion counter module', () => {
  it('renders the counters the companion module reports', async () => {
    readEscalationCountersMock.mockReturnValue({
      ...NO_ESCALATIONS,
      bridgeAttempted: 13,
      bridgeServed: 8,
      bridgeDeclined: 5,
      budgetRefused: 4,
      cardShown: 6,
      cardUnattended: 1,
    });
    const text = await doctorOutput();
    // Asserted through the whole rendered block rather than one summary number, so a regression
    // that drops any single lane reds here.
    expect(text).toContain('13 attempted');
    expect(text).toContain('8 served');
    expect(text).toContain('5 declined');
    expect(text).toContain('4 request(s) held back');
    expect(text).toContain('6 shown');
    expect(text).toContain('1 skipped');
    expect(readEscalationCountersMock).toHaveBeenCalledWith(DATA_DIR);
  });

  it('prints both origin budgets next to the counters, naming their env vars', async () => {
    // A limit the user cannot see is indistinguishable from a bug when it fires.
    const text = await doctorOutput();
    expect(text).toContain('WIGOLO_STUDIO_ORIGIN_BUDGET');
    expect(text).toContain('WIGOLO_STUDIO_ANONYMOUS_ORIGIN_BUDGET');
  });
});

describe('doctor — desktop-component line reads the companion substrate module', () => {
  it('names the version the companion record carries', async () => {
    readSubstrateRecordMock.mockReturnValue({ version: '7.7.7-pin', executable: 'bin/run' });
    const text = await doctorOutput();
    expect(text).toContain('7.7.7-pin');
    expect(readSubstrateRecordMock).toHaveBeenCalled();
  });

  it('reports the component as absent when the companion module has no record', async () => {
    // "acquired and ready" and "never acquired, will download on first need" look identical from
    // the outside; this line is the only thing that separates them.
    readSubstrateRecordMock.mockReturnValue(null);
    const text = await doctorOutput();
    expect(text).toMatch(/Desktop comp\.:/);
    expect(text).not.toContain('7.7.7-pin');
  });

  it('keeps the component line free of implementation and product names', async () => {
    // Capability language: the doctor output is user-facing text.
    readSubstrateRecordMock.mockReturnValue({ version: '7.7.7-pin', executable: 'bin/run' });
    const line = (await doctorOutput())
      .split('\n')
      .find((l) => /Desktop comp\.:/.test(l)) ?? '';
    expect(line).not.toMatch(/electron/i);
    expect(line).not.toMatch(/playwright/i);
    expect(line).not.toMatch(/chromium/i);
    expect(line).not.toMatch(/studio/i);
  });
});
