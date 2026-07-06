import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ElectronApplication } from 'playwright';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchStudio } from './launch';
import { readHandle, DaemonProxy } from 'wigolo/studio';

// GATED (RUN_STUDIO_E2E). The embedded gateway boots the full wigolo subsystems, which load native
// modules (better-sqlite3, onnxruntime-node). In the Electron main these must be built for Electron's
// ABI (NODE_MODULE_VERSION), NOT Node's — so this lane requires `npx @electron/rebuild` first (the CI
// studio-e2e job / packaging step does this; the shared node_modules ships Node-ABI natives for the
// core test suites). Same env-gating discipline as studio-bridge's RUN_STUDIO_HEADED. The agent-line
// LOGIC (drive engine, host, preemption FSM, approval store, dispatch) is covered by the unit/property
// suites; this proves the running gateway end-to-end once natives are rebuilt for Electron.
const RUN = !!process.env.RUN_STUDIO_E2E;

const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');

interface ToolResult { content: Array<{ type: string; text: string }>; isError: boolean }
const body = (r: unknown) => JSON.parse((r as ToolResult).content[0].text) as Record<string, unknown>;

// End-to-end proof of the P1 agent line THROUGH the real embedded gateway: an external MCP client
// discovers the running app via the 0600 handle, authenticates with the per-launch bearer, and drives
// studio_open/observe/act/list/close. The agent SSRF fence blocks local/private pages by design, so the
// click/type/preempt/approval-on-a-live-page flows need a human-granted localhost page — those run in the
// headed lane (their LOGIC is unit/property-tested in drive-engine/studio-host/approval-store). Here we
// prove: discovery, bearer auth (wrong token refused), the open→observe→act→list→close loop, that observe
// fences page content untrusted, and that the agent nav SSRF fence is LIVE end-to-end.
describe.skipIf(!RUN)('studio agent line (e2e, real gateway)', () => {
  let app: ElectronApplication;
  let dataDir: string;
  let endpoint: string;
  let token: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-studio-e2e-'));
    app = await launchStudio({ args: [APP_MAIN], env: { ...process.env, WIGOLO_DATA_DIR: dataDir } });
    await app.firstWindow();
    // The gateway publishes the 0600 handle after start()+host injection — poll for it.
    const started = Date.now();
    let handle = readHandle(dataDir);
    while (!handle && Date.now() - started < 30_000) {
      await new Promise((r) => setTimeout(r, 250));
      handle = readHandle(dataDir);
    }
    if (!handle) throw new Error('gateway handle never published');
    endpoint = handle.endpoint;
    token = handle.token;
  });

  afterAll(async () => {
    await app?.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('rejects a client with the wrong bearer token (no token, no tools)', async () => {
    const bad = new DaemonProxy(endpoint, 'not-the-token');
    await expect(bad.callTool('studio_observe', {})).rejects.toBeTruthy();
  });

  it('studio_open → observe (fenced untrusted) → act(blocked SSRF nav) → list → close, over the bearer-authed gateway', async () => {
    const proxy = new DaemonProxy(endpoint, token);

    const opened = body(await proxy.callTool('studio_open', {}));
    expect(typeof opened.session_id).toBe('string');
    const sessionId = opened.session_id as string;

    // observe fences page perception as untrusted data, not instructions.
    const observed = body(await proxy.callTool('studio_observe', {}));
    expect(observed.trusted).toBe(false);
    expect(typeof observed.untrusted_notice).toBe('string');

    // the agent nav SSRF fence is LIVE end-to-end: cloud-metadata is never reachable.
    const act = await proxy.callTool('studio_act', { action: 'navigate', url: 'http://169.254.169.254/latest/meta-data' });
    const actBody = body(act);
    // navigate to cloud-internal is refused (error_reason navigation_blocked) — fenced, not a silent success.
    expect(actBody.error_reason ?? actBody.stage ?? 'ok').not.toBe('ok');
    expect(String(actBody.error_reason ?? '')).toMatch(/navigation_blocked|not_holder|aborted/);

    const listed = body(await proxy.callTool('studio_list', {}));
    expect(Array.isArray(listed.sessions)).toBe(true);
    expect((listed.sessions as Array<{ id: string }>).some((s) => s.id === sessionId)).toBe(true);

    const closed = body(await proxy.callTool('studio_close', { session_id: sessionId }));
    expect(closed.closed).toBe(true);
  });
});
