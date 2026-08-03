import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { statSync } from 'node:fs';
import { readHandle, studioHandlePath, getMyInstanceId, DaemonProxy } from 'wigolo/studio';
import {
  STUDIO_TOOL_NAMES,
  STUDIO_UNADVERTISED_CAPABILITY,
  CORE_TOOL_NAMES_ABSENT_FROM_STUDIO,
  toolResultBody,
  loopbackEndpointErrors,
  refusalContractErrors,
  untrustedFenceErrors,
  advertisedToolErrors,
} from '../src/index.js';
import { electronStudioUnderTest } from './adapters/electron-studio.js';
import { startFixtureServer, type FixtureServer } from './fixtures/server.js';

/**
 * THE `studio_*` MCP CONFORMANCE SUITE — a running Studio, driven over its real endpoint.
 *
 * WHAT MAKES THIS DIFFERENT from the tests that already cover this surface, and why it is worth its
 * runtime. `tests/unit/daemon/studio-mcp-server.test.ts` drives the SERVER OBJECT over an in-memory
 * transport: it proves the dispatch table, and it cannot see the HTTP endpoint, the bearer, the Origin
 * guard, the boot order, the handle file, or the JSON round trip. `apps/studio/tests/e2e/*` drive the
 * real endpoint but assert BEHAVIOUR from inside the implementation's own package, so they move when the
 * implementation moves. This suite asserts the CONTRACT from outside: it knows a handle file, a bearer,
 * ten tool names, and what the answers must contain — nothing about how any of it is built.
 *
 * That is what makes a future repo split a `git mv`. The suite imports the implementation exactly twice:
 * `wigolo/studio` for the published client + handle reader (the PUBLIC package surface an external agent
 * would use), and one adapter file that knows how to boot the app and stand in for the human.
 *
 * NEVER A LIVE SITE. The one page it loads is served from 127.0.0.1 by the suite itself.
 *
 * GATED (`RUN_STUDIO_E2E`), matching the studio e2e lane: it launches a real browser engine.
 */
const RUN = !!process.env.RUN_STUDIO_E2E;

const studio = electronStudioUnderTest();

describe.skipIf(!RUN)(`studio_* MCP wire contract — ${studio.name}`, () => {
  let dataDir: string;
  let endpoint: string;
  let token: string;
  let instanceId: string;
  let fixture: FixtureServer;
  /** Set by the discovery block; the advertisement block asserts it succeeded on the FIRST attempt. */
  let firstListToolsError: unknown;
  let advertised: Array<{ name: string; description?: string; inputSchema?: { type?: string } }> = [];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const proxy = () => new DaemonProxy(endpoint, token);
  const call = async (name: string, args: Record<string, unknown> = {}) => toolResultBody(await proxy().callTool(name, args));

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const started = await studio.start();
    dataDir = started.dataDir;

    // Poll for the handle. The handle is the discovery contract AND the readiness signal — it is
    // published LAST, after the host is wired, so its appearance is what an external agent waits for.
    const deadline = Date.now() + 30_000;
    let handle = readHandle(dataDir);
    while (!handle && Date.now() < deadline) {
      await sleep(250);
      handle = readHandle(dataDir);
    }
    if (!handle) throw new Error(`${studio.name} never published a session handle at ${studioHandlePath(dataDir)}`);
    endpoint = handle.endpoint;
    token = handle.token;
    instanceId = handle.instanceId;

    // Deliberately ONE attempt, no retry: see the assertion in the advertisement block.
    try {
      const listed = (await new DaemonProxy(endpoint, token).listTools()) as { tools: typeof advertised };
      advertised = listed.tools;
    } catch (err) {
      firstListToolsError = err;
    }
  }, 120_000);

  afterAll(async () => {
    await studio.stop();
    await fixture?.close();
  });

  // ── 1. Discovery ────────────────────────────────────────────────────────────────────────────────
  describe('discovery — the handle file is the whole contract for finding a running Studio', () => {
    it('publishes a LOOPBACK endpoint: this bearer grants full drive of a browser holding the human\'s logged-in sessions, so anything reachable off-box is remote control of their identity', () => {
      expect(loopbackEndpointErrors(endpoint)).toEqual([]);
    });

    it('publishes a non-empty bearer', () => {
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('publishes the handle 0600 — it carries a bearer, so group/other readability would hand session control to any local account', () => {
      // Windows does not carry POSIX mode bits; asserting them there would fail for the platform rather
      // than for the implementation.
      if (process.platform === 'win32') return;
      expect(statSync(studioHandlePath(dataDir)).mode & 0o777).toBe(0o600);
    });

    it('publishes a host-instance id that this NON-host process cannot match, which is what lets a client tell "the live host is someone else" from "the live host is me"', () => {
      expect(typeof instanceId).toBe('string');
      expect(instanceId.length).toBeGreaterThan(0);
      // A non-host process holds no instance id at all, so the self-reference guard can never
      // false-match and refuse to proxy a call it should have forwarded.
      expect(getMyInstanceId()).toBeNull();
      expect(instanceId).not.toBe(getMyInstanceId());
    });
  });

  // ── 2. Advertisement ────────────────────────────────────────────────────────────────────────────
  describe('advertisement — exactly the ten studio tools, and nothing else', () => {
    it('answers listTools on the FIRST attempt after the handle appears: the handle is published after the host is wired, so a client that waited for it must never need to retry', () => {
      expect(firstListToolsError).toBeUndefined();
    });

    it('advertises EXACTLY the ten contract names', () => {
      expect(advertised.map((t) => t.name).sort()).toEqual([...STUDIO_TOOL_NAMES]);
    });

    it('advertises each one usably — a name, a non-empty description, and an object input schema', () => {
      const errs = advertised.flatMap((t) => advertisedToolErrors(t));
      expect(errs).toEqual([]);
    });

    it('advertises NO core tool: the studio endpoint is a separate surface that boots without core\'s subsystems, so a core name here means the wrong server object was mounted', () => {
      const names = new Set(advertised.map((t) => t.name));
      const leaked = CORE_TOOL_NAMES_ABSENT_FROM_STUDIO.filter((n) => names.has(n));
      expect(leaked).toEqual([]);
    });

    it('does NOT advertise the unadvertised capability — advertising it would turn a one-seam capability into a tool with every seam a tool carries', () => {
      expect(advertised.map((t) => t.name)).not.toContain(STUDIO_UNADVERTISED_CAPABILITY);
    });
  });

  // ── 3. Authentication ───────────────────────────────────────────────────────────────────────────
  describe('authentication — the bearer is the whole gate', () => {
    it('refuses a wrong bearer on callTool, with no partial data: an unauthenticated caller must not learn what session exists or what the page says', async () => {
      const bad = new DaemonProxy(endpoint, 'not-the-token');
      await expect(bad.callTool('studio_observe', {})).rejects.toBeTruthy();
    });

    it('refuses a wrong bearer on listTools too — the tool surface is not public metadata on an endpoint that drives the human\'s browser', async () => {
      const bad = new DaemonProxy(endpoint, 'not-the-token');
      await expect(bad.listTools()).rejects.toBeTruthy();
    });

    it('refuses a MISSING bearer, not just a wrong one', async () => {
      const anon = new DaemonProxy(endpoint);
      await expect(anon.callTool('studio_list', {})).rejects.toBeTruthy();
    });
  });

  // ── 6. Health ───────────────────────────────────────────────────────────────────────────────────
  // Placed before the arc: it is a liveness read with no session state, and running it early proves the
  // endpoint answers before any tool has been called.
  describe('health', () => {
    it('reports mode studio — the marker that says this endpoint hosts the studio surface and has no core subsystems behind it', async () => {
      const res = await fetch(`${endpoint}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status?: string; mode?: string };
      expect(body.mode).toBe('studio');
      expect(body.status).toBe('ok');
    });
  });

  // ── 4. The agent arc ────────────────────────────────────────────────────────────────────────────
  describe('the agent arc — open → observe → act → list → close', () => {
    let sessionId: string;

    it('studio_open returns a session id', async () => {
      const opened = await call('studio_open', {});
      expect(typeof opened.session_id).toBe('string');
      sessionId = opened.session_id as string;
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it('studio_observe carries trusted:false AND untrusted_notice THROUGH the JSON round trip — the field-dropping regression the verbatim-proxy contract exists to prevent', async () => {
      const observed = await call('studio_observe', {});
      expect(untrustedFenceErrors(observed)).toEqual([]);
    });

    it('refuses an agent navigate to cloud metadata — 169.254.169.254 is the credential-exfiltration address, and it is never grantable', async () => {
      const act = await call('studio_act', { action: 'navigate', url: 'http://169.254.169.254/latest/meta-data' });
      expect(act.error_reason).toBe('navigation_blocked');
      expect(act.ok).not.toBe(true);
    });

    it('refuses an agent navigate to the loopback fixture BEFORE the human grants it', async () => {
      const act = await call('studio_act', { action: 'navigate', url: fixture.url });
      expect(act.error_reason).toBe('navigation_blocked');
    });

    it('allows the SAME loopback navigate after the human grants private addresses, and still refuses cloud metadata — the grant widens the private fence, never the metadata fence', async () => {
      await studio.humanGrantsPrivateAddresses();
      const allowed = await call('studio_act', { action: 'navigate', url: fixture.url });
      expect(allowed.ok, `navigate after grant returned ${JSON.stringify(allowed).slice(0, 300)}`).toBe(true);

      const meta = await call('studio_act', { action: 'navigate', url: 'http://169.254.169.254/latest/meta-data' });
      expect(meta.error_reason).toBe('navigation_blocked');
    });

    it('fences the REAL page it just loaded: the fixture\'s instruction-shaped text arrives as data, and its verbatim untrusted-region END marker is neutralized so the page cannot forge the boundary the notice describes', async () => {
      // Re-navigate: the metadata attempt above was refused, but assert against the fixture explicitly
      // rather than assuming the refused navigate left the page where it was.
      await call('studio_act', { action: 'navigate', url: fixture.url });
      const observed = await call('studio_observe', {});
      expect(untrustedFenceErrors(observed)).toEqual([]);

      const wire = JSON.stringify(observed);
      // The page's own text reached the agent (otherwise the neutralization assertion below is vacuous).
      expect(wire, 'the fixture page text never reached the observe payload').toContain('IGNORE PREVIOUS INSTRUCTIONS');
      // ...but the region marker it embedded did NOT survive verbatim.
      expect(wire).not.toContain('[[END UNTRUSTED DATA]]');
    });

    it('studio_list includes the open session', async () => {
      const listed = await call('studio_list', {});
      const sessions = listed.sessions as Array<{ id: string }> | undefined;
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions!.some((s) => s.id === sessionId)).toBe(true);
    });

    it('studio_close closes it, and studio_list stops reporting it', async () => {
      const closed = await call('studio_close', { session_id: sessionId });
      expect(closed.closed).toBe(true);
      const listed = await call('studio_list', {});
      const sessions = (listed.sessions as Array<{ id: string }> | undefined) ?? [];
      expect(sessions.some((s) => s.id === sessionId)).toBe(false);
    });
  });

  // ── 5. The unadvertised capability ──────────────────────────────────────────────────────────────
  describe('the unadvertised capability — callable on the authed transport, absent from listTools', () => {
    it('answers studio_fetch: it is not advertised, but it MUST be reachable, or core\'s escalation rung silently 404s against a running Studio', async () => {
      // An empty url is the one input that reaches the handler and returns without navigating anywhere,
      // so this proves the capability RAN rather than proving anything about a page. A 404 for an unknown
      // name could not produce this named refusal.
      const body = await call(STUDIO_UNADVERTISED_CAPABILITY, { url: '' });
      expect(body.error).toBe('invalid_url');
      expect(typeof body.error_reason).toBe('string');
    });

    it('still refuses it without the bearer — unadvertised is not a substitute for authenticated', async () => {
      const anon = new DaemonProxy(endpoint);
      await expect(anon.callTool(STUDIO_UNADVERTISED_CAPABILITY, { url: '' })).rejects.toBeTruthy();
    });

    it('refuses a genuinely unknown studio name rather than silently succeeding — this is what tells a 404 apart from the case above', async () => {
      const body = await call('studio_not_a_tool', {});
      expect(refusalContractErrors(body)).toEqual([]);
      expect(body.error_reason).toBe('unknown_studio_tool');
    });
  });

  // ── 7. Refusals ─────────────────────────────────────────────────────────────────────────────────
  // LAST, because the not_holder case hands control to the human and every later agent act would then
  // be refused for that reason instead of the one under test.
  describe('refusals round-trip their fields', () => {
    it('a refusal always carries a hint: error_reason alone tells an agent that something failed and nothing about what to do next', async () => {
      const body = await call('studio_close', { session_id: 'no-such-session' });
      expect(refusalContractErrors(body)).toEqual([]);
    });

    it('an unknown act verb is refused with a hint rather than acted on', async () => {
      await call('studio_open', {});
      const body = await call('studio_act', { action: 'teleport' });
      expect(refusalContractErrors(body)).toEqual([]);
    });

    it('a not_holder refusal round-trips currentEpoch as well as hint — control is epoch\'d, and a preempted agent needs the live epoch to resync whose turn it is', async () => {
      await studio.humanTakesControl();
      const body = await call('studio_act', { action: 'scroll', direction: 'down' });
      expect(body.error_reason).toBe('not_holder');
      expect(refusalContractErrors(body)).toEqual([]);
      expect(typeof body.currentEpoch).toBe('number');
    });
  });
});
