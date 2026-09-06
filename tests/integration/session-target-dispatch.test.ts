import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer, type Subsystems } from '../../src/server.js';
import { resetConfig } from '../../src/config.js';
import { writeHandle, removeHandle } from '../../src/companion/handle.js';
import { SESSION_TARGET_ROUTE } from '../../src/companion-contract/session-target.js';

/**
 * EXTRACT seam 5 — the three `isSessionTargeted` dispatch branches in src/server.ts, pinned on the
 * REAL CallTool wire.
 *
 * Why this file exists: `session_id` is still in the public schemas for fetch / extract / crawl, but
 * the test that covered the DISPATCH side of it went out with the domain layer in the extraction. The
 * failure that leaves open is silent and the worst shape available here — delete one guard and a
 * session-targeted call degrades into an ORDINARY ephemeral call that succeeds, so the agent gets a
 * page from an anonymous browser while believing it came from its authenticated session. Success with
 * the wrong data, never a refusal, with a green suite.
 *
 * So the assertions are the ones a deleted guard cannot survive: the ephemeral handler must NOT run,
 * the companion wire MUST carry the op + session id, and the unpaired arm must reach the caller as a
 * TYPED refusal from dispatch rather than as an untargeted run wearing a session's clothes.
 *
 * This is the dispatch seam, not `tools/session-target.ts` — the forward itself is unit-tested there.
 * The wire is stubbed at `globalThis.fetch`, the outermost point core owns, so nothing in the routing
 * path between dispatch and the socket is mocked away.
 */

const EPHEMERAL_MARKER = 'EPHEMERAL-RAN';
const SESSION_MARKER = 'SESSION-COMPANION-RAN';

const handleFetchMock = vi.hoisted(() => vi.fn());
const handleExtractMock = vi.hoisted(() => vi.fn());
const handleCrawlMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/tools/fetch.js', () => ({ handleFetch: handleFetchMock }));
vi.mock('../../src/tools/extract.js', () => ({ handleExtract: handleExtractMock }));
vi.mock('../../src/tools/crawl.js', () => ({ handleCrawl: handleCrawlMock }));
vi.mock('../../src/watch/scheduler.js', () => ({ scheduleOverdueCheck: vi.fn() }));

interface WireCall {
  url: string;
  authorization: string;
  body: { op: string; session_id: string; input: Record<string, unknown> };
}

let dataDir: string;
let prevDataDir: string | undefined;
let wireCalls: WireCall[] = [];
let wireReply: { httpOk: boolean; body: unknown } = { httpOk: true, body: null };

const HANDLE = {
  id: 'sess-480',
  endpoint: 'http://127.0.0.1:59480',
  token: 'tok-480',
  pid: process.pid,
  instanceId: 'inst-480',
};

function stubSubsystems(): Subsystems {
  return {
    searchEngines: [], router: {}, backendStatus: {}, browserPool: {}, pluginRegistry: {},
    shutdown: async () => {}, bootstrapSearxng: async () => {},
  } as unknown as Subsystems;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; parsed: Record<string, unknown> }> {
  const server = createMcpServer(stubSubsystems());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  const text = (res.content as Array<{ type: string; text: string }>).map((b) => b.text).join('\n');
  return { text, isError: res.isError === true, parsed: JSON.parse(text) as Record<string, unknown> };
}

beforeAll(() => {
  // A PRIVATE data dir, because the pairing state under test is a FILE: writing the companion handle
  // into the shared suite data dir would make a sibling file's "no companion paired" read this one's
  // handle. Under $TMPDIR, never in the tree.
  prevDataDir = process.env.WIGOLO_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-sd480-'));

  // The activation gate is the FIRST statement in the CallTool handler and reads
  // `<dataDir>/account/state.json`, so a fresh dataDir refuses every tool call before dispatch is
  // reached. The suite's seeded state is copied across rather than bypassed — the gate still runs
  // all six of its steps, exactly as tests/setup.ts intends.
  const seeded = join(prevDataDir ?? '', 'account', 'state.json');
  if (!prevDataDir || !existsSync(seeded)) {
    throw new Error(`expected an activated suite install at ${seeded} (tests/setup.ts seeds it)`);
  }
  mkdirSync(join(dataDir, 'account'), { recursive: true, mode: 0o700 });
  copyFileSync(seeded, join(dataDir, 'account', 'state.json'));

  process.env.WIGOLO_DATA_DIR = dataDir;
  resetConfig();
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.WIGOLO_DATA_DIR;
  else process.env.WIGOLO_DATA_DIR = prevDataDir;
  resetConfig();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  wireCalls = [];
  wireReply = { httpOk: true, body: null };
  // The ephemeral arms return a marker no session answer carries: if a guard is deleted, the call
  // still SUCCEEDS and the marker is what tells the untargeted run apart from the targeted one.
  handleFetchMock.mockResolvedValue({
    ok: true,
    data: { markdown: EPHEMERAL_MARKER, url: 'https://ephemeral.example/p', title: '', metadata: {}, links: [], images: [], cached: false },
  });
  handleExtractMock.mockResolvedValue({ ok: true, data: { data: EPHEMERAL_MARKER } });
  handleCrawlMock.mockResolvedValue({
    pages: [{ url: 'https://ephemeral.example/p', title: '', markdown: EPHEMERAL_MARKER, depth: 0 }],
    total_found: 1,
    crawled: 1,
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    wireCalls.push({
      url: String(url),
      authorization: init.headers.authorization,
      body: JSON.parse(init.body) as WireCall['body'],
    });
    return { ok: wireReply.httpOk, json: async () => wireReply.body };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  removeHandle(dataDir);
});

describe('EXTRACT seam 5 — a paired companion: session_id forwards over the companion wire', () => {
  beforeEach(() => {
    writeHandle(HANDLE, dataDir);
  });

  it('SEAM-FETCH: fetch with session_id reaches the companion, never the ephemeral fetch', async () => {
    // MUT: delete the `isSessionTargeted(input)` branch at the fetch arm → handleFetch runs, the
    // wire is never touched, EPHEMERAL_MARKER lands on the envelope → RED on all four assertions.
    wireReply = {
      httpOk: true,
      body: {
        ok: true,
        data: { markdown: SESSION_MARKER, url: 'https://session.example/p', title: 'live session page', metadata: {}, links: [], images: [], cached: false },
      },
    };

    const res = await callTool('fetch', { url: 'https://session.example/p', session_id: 'sess-480' });

    expect(handleFetchMock).not.toHaveBeenCalled();
    expect(wireCalls).toHaveLength(1);
    expect(wireCalls[0].url).toBe(`${HANDLE.endpoint}${SESSION_TARGET_ROUTE}`);
    expect(wireCalls[0].authorization).toBe(`Bearer ${HANDLE.token}`);
    expect(wireCalls[0].body.op).toBe('fetch');
    expect(wireCalls[0].body.session_id).toBe('sess-480');
    expect(wireCalls[0].body.input.url).toBe('https://session.example/p');
    expect(res.isError).toBe(false);
    expect(res.text).toContain(SESSION_MARKER);
    expect(res.text).not.toContain(EPHEMERAL_MARKER);
    expect(res.parsed.url).toBe('https://session.example/p');
  });

  it('SEAM-EXTRACT: extract with session_id reaches the companion, never the ephemeral extract', async () => {
    // MUT: delete the branch at the extract arm → handleExtract runs → RED.
    wireReply = { httpOk: true, body: { ok: true, data: { data: SESSION_MARKER } } };

    const res = await callTool('extract', { url: 'https://session.example/p', mode: 'metadata', session_id: 'sess-480' });

    expect(handleExtractMock).not.toHaveBeenCalled();
    expect(wireCalls).toHaveLength(1);
    expect(wireCalls[0].url).toBe(`${HANDLE.endpoint}${SESSION_TARGET_ROUTE}`);
    expect(wireCalls[0].body.op).toBe('extract');
    expect(wireCalls[0].body.session_id).toBe('sess-480');
    expect(res.isError).toBe(false);
    expect(res.text).toContain(SESSION_MARKER);
    expect(res.text).not.toContain(EPHEMERAL_MARKER);
  });

  it('SEAM-CRAWL: crawl with session_id reaches the companion, never the ephemeral crawl', async () => {
    // MUT: delete the branch at the crawl arm → handleCrawl runs → RED.
    wireReply = {
      httpOk: true,
      body: {
        ok: true,
        data: { pages: [{ url: 'https://session.example/p', title: 'live', markdown: SESSION_MARKER, depth: 0 }], total_found: 1, crawled: 1 },
      },
    };

    const res = await callTool('crawl', { url: 'https://session.example/p', session_id: 'sess-480' });

    expect(handleCrawlMock).not.toHaveBeenCalled();
    expect(wireCalls).toHaveLength(1);
    expect(wireCalls[0].url).toBe(`${HANDLE.endpoint}${SESSION_TARGET_ROUTE}`);
    expect(wireCalls[0].body.op).toBe('crawl');
    expect(wireCalls[0].body.session_id).toBe('sess-480');
    expect(res.isError).toBe(false);
    expect(res.text).toContain(SESSION_MARKER);
    expect(res.text).not.toContain(EPHEMERAL_MARKER);
  });

  it('SEAM-PASSTHROUGH: the companion\'s own typed refusal reaches the agent in its own words', async () => {
    // The paired arm is not "forward on success": a companion refusal carries live counters in its
    // sentence, and dispatch must publish it rather than fall back to an ephemeral run.
    // MUT: make the arm fall through to handleFetch on !sr.ok → EPHEMERAL_MARKER, isError false → RED.
    wireReply = {
      httpOk: false,
      body: {
        ok: false,
        error: 'no_such_session',
        error_reason: 'Session sess-480 is closed (2 of 3 navigations used this minute).',
        stage: 'fetch',
        hint: 'Open the session again, or omit session_id.',
      },
    };

    const res = await callTool('fetch', { url: 'https://session.example/p', session_id: 'sess-480' });

    expect(handleFetchMock).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    // stageErrorEnvelope swaps the orientation: machine code lands on `error_reason`, prose on `error`.
    expect(res.parsed.error_reason).toBe('no_such_session');
    expect(res.parsed.stage).toBe('fetch');
    expect(String(res.parsed.error)).toContain('2 of 3 navigations');
    expect(res.text).not.toContain(EPHEMERAL_MARKER);
  });
});

describe('EXTRACT seam 5 — unpaired: session_id refuses at dispatch, never a silent untargeted run', () => {
  // No handle on disk. This is the arm the whole seam exists for: a caller who asked for their
  // authenticated session and quietly received an anonymous fetch would believe a page came from a
  // session it never touched, so the ONLY acceptable answer is a typed refusal.

  it('SEAM-UNPAIRED-FETCH: typed companion_unavailable, ephemeral fetch never runs', async () => {
    const res = await callTool('fetch', { url: 'https://session.example/p', session_id: 'sess-480' });

    expect(handleFetchMock).not.toHaveBeenCalled();
    expect(wireCalls).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(res.parsed.error_reason).toBe('companion_unavailable');
    expect(res.parsed.stage).toBe('fetch');
    expect(res.text).not.toContain(EPHEMERAL_MARKER);
  });

  it('SEAM-UNPAIRED-EXTRACT: typed companion_unavailable, ephemeral extract never runs', async () => {
    const res = await callTool('extract', { url: 'https://session.example/p', mode: 'metadata', session_id: 'sess-480' });

    expect(handleExtractMock).not.toHaveBeenCalled();
    expect(wireCalls).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(res.parsed.error_reason).toBe('companion_unavailable');
    expect(res.parsed.stage).toBe('extract');
    expect(res.text).not.toContain(EPHEMERAL_MARKER);
  });

  it('SEAM-UNPAIRED-CRAWL: the refusal arrives as the crawl shape\'s own error field', async () => {
    // Crawl has no ok/err envelope of its own, so its refusal rides `error` — the same field every
    // other crawl failure uses. The envelope must not change shape because the refusal came off a wire.
    const res = await callTool('crawl', { url: 'https://session.example/p', session_id: 'sess-480' });

    expect(handleCrawlMock).not.toHaveBeenCalled();
    expect(wireCalls).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(String(res.parsed.error)).toContain('companion_unavailable');
    expect(res.parsed.pages).toEqual([]);
    expect(res.parsed.crawled).toBe(0);
    expect(res.text).not.toContain(EPHEMERAL_MARKER);
  });
});

describe('EXTRACT seam 5 — the predicate is a router, not a switch that is always on', () => {
  // Guards the OTHER miswiring: a branch hard-wired true (or a predicate that counts a blank id)
  // would send every ordinary call at a companion. These two rows fail on that mutation and pass on
  // the deletion, so together with the rows above no single edit to the seam leaves the suite green.
  beforeEach(() => {
    writeHandle(HANDLE, dataDir);
  });

  it('SEAM-NO-ID: no session_id runs the ephemeral path even with a companion paired', async () => {
    const res = await callTool('fetch', { url: 'https://ephemeral.example/p' });

    expect(handleFetchMock).toHaveBeenCalledTimes(1);
    expect(wireCalls).toHaveLength(0);
    expect(res.text).toContain(EPHEMERAL_MARKER);
  });

  it('SEAM-BLANK-ID: a whitespace-only session_id is not an address and stays ephemeral', async () => {
    const res = await callTool('fetch', { url: 'https://ephemeral.example/p', session_id: '   ' });

    expect(handleFetchMock).toHaveBeenCalledTimes(1);
    expect(wireCalls).toHaveLength(0);
    expect(res.text).toContain(EPHEMERAL_MARKER);
  });
});
