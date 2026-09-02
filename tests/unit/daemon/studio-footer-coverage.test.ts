import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchStudioTool,
  setBatonGate,
  setDeliveryHooks,
  setFooterSource,
  STUDIO_ROUTE_NAMES,
  type McpToolResult,
  type StudioHostHandlers,
  type StudioToolName,
} from '../../../src/daemon/studio-dispatch.js';
import { isFooterBlock } from '../../../src/daemon/studio-footer.js';
import { writeHandle, setMyInstanceId, type SessionHandle } from '../../../src/companion/handle.js';
import { TOOL_SCHEMAS } from '../../../src/server/tool-schemas.js';

/**
 * #56's "100% coverage, MEASURED". Law 9 says the returned text is the interface, so a result path
 * without a footer is a screen with a missing element — and the only way to know none exists is to
 * enumerate them and count.
 *
 * WHAT MAKES THE NUMBER TRUSTWORTHY. The tool half of the enumeration is not a list: it is
 * `STUDIO_ROUTE_NAMES`, derived from the compile-enforced `Record<StudioToolName, HostRoute>` route
 * table, and cross-checked here against the advertised `studio_*` schema set. A tool added later is
 * therefore in this test's enumeration the moment it compiles — nobody has to remember to add it.
 * The rest of the enumeration is the paths that mint a result WITHOUT a route: the refusals, the
 * interrupt receipt and the browser-closed error.
 *
 * PROVABLY ABLE TO FAIL. The footer is attached at dispatch's single exit, so what can defeat it is
 * a new result path that returns before that exit. Adding one — a throwaway early `return
 * refusal(...)` at the top of `dispatchStudioTool` — turns the matching row here red; removing it
 * turns it green again. That probe was run against this file, and is what the exit gate's number
 * rests on.
 */

let dir: string;

const handle = (over: Partial<SessionHandle> = {}): SessionHandle => ({
  id: 's', endpoint: 'http://127.0.0.1:65000', token: 't', pid: process.pid, instanceId: 'host-A', ...over,
});

const hostHandlers = (): StudioHostHandlers => ({
  observe: async () => ({ id: 'snap1', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (input) => ({ ok: true, action: input.action, url: input.url }),
  marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 'bg-1' }),
  close: async (input) => ({ closed: true as const, session_id: input.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: ['name'], rows: [{ name: 'A' }], pages_followed: 0, artifact_id: 1 }),
});

/** The one assertion every enumerated path is held to: two blocks, the second a footer. */
function expectFooter(result: McpToolResult, label: string): void {
  expect(result.content, `${label}: expected the JSON block plus the §4.4 footer`).toHaveLength(2);
  expect(isFooterBlock(result.content[1]), `${label}: content[1] is not a footer block`).toBe(true);
  // content[0] stays the parsed block — the footer must never be folded into it.
  expect(() => JSON.parse(result.content[0]!.text), `${label}: content[0] stopped being JSON`).not.toThrow();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-footer-cov-'));
  setMyInstanceId(null);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setMyInstanceId(null);
  setBatonGate(undefined);
  setDeliveryHooks(undefined);
  setFooterSource(undefined);
});

describe('every studio tool result path carries the footer', () => {
  it('the route table IS the advertised studio surface — the enumeration cannot drift from it', () => {
    const advertised = Object.keys(TOOL_SCHEMAS).filter((n) => n.startsWith('studio_')).sort();
    expect([...STUDIO_ROUTE_NAMES].sort()).toEqual(advertised);
  });

  it('every route, executed on the host — success path', async () => {
    const covered: string[] = [];
    for (const name of STUDIO_ROUTE_NAMES) {
      const args = name === 'studio_act' ? { action: 'navigate', url: 'https://example.com' } : {};
      expectFooter(await dispatchStudioTool(name, args, hostHandlers(), dir), name);
      covered.push(name);
    }
    expect(covered).toHaveLength(STUDIO_ROUTE_NAMES.length);
  });

  it('every studio_act VERB — the one tool whose result paths branch on an argument', async () => {
    const verbs = ['navigate', 'click', 'type', 'scroll', 'wait_for_human'] as const;
    for (const action of verbs) {
      expectFooter(await dispatchStudioTool('studio_act', { action }, hostHandlers(), dir), `studio_act:${action}`);
    }
  });

  it('every route, executed on the host — typed-error path (a refused observer deserves the run id MORE)', async () => {
    const failing: StudioHostHandlers = {
      observe: async () => ({ error_reason: 'capture_refused', hint: 'no' }),
      act: async () => ({ error_reason: 'not_holder', hint: 'no', currentEpoch: 3 }),
      marks: async () => ({ error_reason: 'no_such_mark', hint: 'no' }),
      capture: async () => ({ error_reason: 'capture_refused', hint: 'no' }),
      spawn: async () => ({ error_reason: 'session_cap', hint: 'no' }),
      close: async () => ({ error_reason: 'no_such_session', hint: 'no' }),
      list: async () => ({ error_reason: 'unavailable', hint: 'no' }),
      say: async () => ({ error_reason: 'empty_message', hint: 'no' }),
      extractSet: async () => ({ error_reason: 'not_implemented', hint: 'no' }),
    };
    for (const name of STUDIO_ROUTE_NAMES) {
      const r = await dispatchStudioTool(name, { action: 'click' }, failing, dir);
      expect(r.isError, `${name}: a typed host error must read as an error`).toBe(true);
      expectFooter(r, `${name} (error)`);
    }
  });
});

describe('the result paths that have no route', () => {
  it('unknown_studio_tool — minted before any run exists, so it says `— no run —`', async () => {
    const r = await dispatchStudioTool('studio_grant_control', {}, hostHandlers(), dir);
    expectFooter(r, 'unknown_studio_tool');
    expect(r.content[1]!.text).toBe('— no run —');
  });

  it('the baton refusal — an observer refused before the page is touched', async () => {
    setBatonGate(async () => ({ error_reason: 'not_the_driver', error: 'cli (other) is driving run 7fq2.', hint: 'ask' }));
    expectFooter(await dispatchStudioTool('studio_act', { action: 'click' }, hostHandlers(), dir), 'not_the_driver');
  });

  it('the interrupt receipt — a result minted by the delivery layer, not by a route', async () => {
    setDeliveryHooks({
      interrupt: async () => ({ content: [{ type: 'text', text: JSON.stringify({ interrupted: true, reason: 'human took control' }) }], isError: false }),
      acknowledge: async () => {},
      deliver: async (_n, _a, result) => result,
    });
    expectFooter(await dispatchStudioTool('studio_observe', {}, hostHandlers(), dir), 'interrupt receipt');
  });

  it('the delivered result — messages ride content[0] and the footer stays exactly one block', async () => {
    setDeliveryHooks({
      interrupt: async () => undefined,
      acknowledge: async () => {},
      deliver: async (_n, _a, result) => ({
        ...result,
        content: [{ type: 'text', text: JSON.stringify({ ok: true, human_messages: [{ id: 'm1' }] }) }, ...result.content.slice(1)],
      }),
    });
    const r = await dispatchStudioTool('studio_observe', {}, hostHandlers(), dir);
    expectFooter(r, 'delivered');
    expect(JSON.parse(r.content[0]!.text).human_messages).toHaveLength(1);
  });

  it('the browser-closed error — §7 row 11, raised where a route would have answered', async () => {
    const dead = { ...hostHandlers(), observe: async () => { throw new Error('Target page, context or browser has been closed'); } };
    expectFooter(await dispatchStudioTool('studio_observe', {}, dead, dir), 'browser_closed');
  });

  it('the stdio-side refusals — no session, self-reference, unreachable host', async () => {
    expectFooter(await dispatchStudioTool('studio_observe', {}, undefined, dir), 'no_studio_session');

    setMyInstanceId('host-A');
    writeHandle(handle({ instanceId: 'host-A' }), dir);
    expectFooter(await dispatchStudioTool('studio_observe', {}, undefined, dir), 'studio_self_reference');

    setMyInstanceId('host-MINE');
    writeHandle(handle({ instanceId: 'host-FOREIGN' }), dir);
    const unreachable = await dispatchStudioTool('studio_observe', {}, undefined, dir, {
      proxyFactory: () => ({ callTool: async () => { throw new Error('ECONNREFUSED'); } }),
    });
    expectFooter(unreachable, 'studio_host_unreachable');
  });

  it('a PROXIED result is passed back VERBATIM — the host already footered it; a second one would stack', async () => {
    setMyInstanceId('host-MINE');
    writeHandle(handle({ instanceId: 'host-FOREIGN' }), dir);
    const fromHost: McpToolResult = {
      content: [
        { type: 'text', text: JSON.stringify({ id: 'snapX' }) },
        { type: 'text', text: '— run 7fq2 · driver cli (claude-code) · tab 1 —\n  cost so far: $0.00 · 0 browser actions · watch: wigolo.studio/r/7fq2' },
      ],
      isError: false,
    };
    const r = await dispatchStudioTool('studio_observe', {}, undefined, dir, { proxyFactory: () => ({ callTool: async () => fromHost }) });
    expect(r).toEqual(fromHost);
    expectFooter(r, 'proxied');
  });
});

describe('the measured number the SD2 exit gate reads', () => {
  /**
   * Ten routed tools + five `studio_act` verbs + the seven routeless paths (unknown tool, baton
   * refusal, interrupt receipt, browser-closed, and the three stdio refusals). Asserted rather than
   * printed so the count cannot quietly shrink; the tool half is derived, so it can only grow with
   * the route table.
   */
  it('covers every path, and says how many', async () => {
    const paths: Array<[string, () => Promise<McpToolResult>]> = [
      ...STUDIO_ROUTE_NAMES.map((name): [string, () => Promise<McpToolResult>] => [
        `route:${name}`,
        () => dispatchStudioTool(name, name === 'studio_act' ? { action: 'navigate' } : {}, hostHandlers(), dir),
      ]),
      ...(['navigate', 'click', 'type', 'scroll', 'wait_for_human'] as const).map((a): [string, () => Promise<McpToolResult>] => [
        `verb:${a}`,
        () => dispatchStudioTool('studio_act', { action: a }, hostHandlers(), dir),
      ]),
      ['refusal:unknown_studio_tool', () => dispatchStudioTool('studio_nope' as StudioToolName, {}, hostHandlers(), dir)],
      ['refusal:not_the_driver', async () => {
        setBatonGate(async () => ({ error_reason: 'not_the_driver', hint: 'ask' }));
        try { return await dispatchStudioTool('studio_act', { action: 'click' }, hostHandlers(), dir); } finally { setBatonGate(undefined); }
      }],
      ['receipt:interrupt', async () => {
        setDeliveryHooks({
          interrupt: async () => ({ content: [{ type: 'text', text: '{"interrupted":true}' }], isError: false }),
          acknowledge: async () => {}, deliver: async (_n, _a, r) => r,
        });
        try { return await dispatchStudioTool('studio_observe', {}, hostHandlers(), dir); } finally { setDeliveryHooks(undefined); }
      }],
      ['error:browser_closed', () => dispatchStudioTool('studio_observe', {}, { ...hostHandlers(), observe: async () => { throw new Error('browser has been closed'); } }, dir)],
      ['refusal:no_studio_session', () => dispatchStudioTool('studio_observe', {}, undefined, dir)],
      ['refusal:studio_self_reference', async () => {
        setMyInstanceId('host-A');
        writeHandle(handle({ instanceId: 'host-A' }), dir);
        return dispatchStudioTool('studio_observe', {}, undefined, dir);
      }],
      ['refusal:studio_host_unreachable', async () => {
        setMyInstanceId('host-MINE');
        writeHandle(handle({ instanceId: 'host-FOREIGN' }), dir);
        return dispatchStudioTool('studio_observe', {}, undefined, dir, {
          proxyFactory: () => ({ callTool: async () => { throw new Error('ECONNREFUSED'); } }),
        });
      }],
    ];

    const footered: string[] = [];
    for (const [label, run] of paths) {
      expectFooter(await run(), label);
      footered.push(label);
    }

    expect(footered).toHaveLength(paths.length);
    expect(paths).toHaveLength(STUDIO_ROUTE_NAMES.length + 5 + 7);
    expect(footered.length / paths.length).toBe(1); // 100%, measured
  });
});
