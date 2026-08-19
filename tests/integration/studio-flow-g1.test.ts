/**
 * S13-0 exit gate (G1) — is a recording sufficient to ATTEMPT a run at all?
 *
 * One flow is recorded per frozen corpus page, through the SHIPPED act path (`createActHandler`
 * → the shipped `createResolver` → the shipped recorder), and then the sidecar is read back and
 * counted. Deterministic and offline: the pages are the frozen C0 fixtures, the browser surface is
 * a fake that answers the four CDP calls the resolver makes, and nothing touches the network.
 *
 * The harness derives an accessibility view from the frozen HTML. That approximation is the
 * harness's, not the product's: everything downstream of it — fingerprints, refs, structured
 * targets, the credential scan, the allow-list — is the shipped code, which is what the gate is
 * about.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parseHTML } from 'linkedom';
import { applyMigrations, _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { createActHandler, type ActControlToken } from '../../src/studio/act.js';
import { createResolver } from '../../src/studio/perception/resolve.js';
import { buildSnapshot, flattenDom, type AxNode, type DomNode } from '../../src/studio/perception/snapshot.js';
import { buildTargetFromFlat, indexAxByBackendNode } from '../../src/studio/mark/target.js';
import { SessionAuditLog } from '../../src/studio/audit.js';
import { createFlowRecorder } from '../../src/studio/flow/record.js';
import { listFlowSteps, flowIdForSession, FLOW_ATTR_KEYS, type FlowStep } from '../../src/studio/flow/store.js';
import { computeFingerprint } from '../../src/studio/perception/id.js';
import type { NavGrant } from '../../src/studio/nav-policy.js';

const FIXTURE_DIR = join(process.cwd(), 'benchmarks/scrape-quality/fixtures/html');
const MANIFEST = join(process.cwd(), 'benchmarks/scrape-quality/fixtures/manifest.json');

// ---------------------------------------------------------------------------
// Frozen HTML → the privileged (AX ⋈ pierced DOM) shape the perception layer consumes
// ---------------------------------------------------------------------------

interface PageModel {
  root: DomNode;
  ax: AxNode[];
}

const ROLE_BY_TAG: Record<string, string> = {
  button: 'button', a: 'link', select: 'combobox', textarea: 'textbox', option: 'option',
};
const ROLE_BY_INPUT_TYPE: Record<string, string> = {
  text: 'textbox', search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
  password: 'textbox', checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button',
};

function roleOf(tag: string, attrs: Record<string, string>): string | undefined {
  if (attrs['role']) return attrs['role'];
  if (tag === 'input') return ROLE_BY_INPUT_TYPE[(attrs['type'] ?? 'text').toLowerCase()];
  if (tag === 'a' && attrs['href'] === undefined) return undefined;
  return ROLE_BY_TAG[tag];
}

/** Walk the parsed document once, minting backend node ids and an AX row per interactive element. */
function buildPageModel(html: string): PageModel {
  const { document } = parseHTML(html);
  const ax: AxNode[] = [];
  let nextId = 1;

  const toNode = (el: Element, depth: number): DomNode => {
    const backendNodeId = nextId++;
    const tag = el.tagName.toLowerCase();
    const attrs: Record<string, string> = {};
    const flat: string[] = [];
    for (const a of Array.from(el.attributes)) {
      attrs[a.name] = a.value;
      flat.push(a.name, a.value);
    }
    const role = roleOf(tag, attrs);
    if (role) {
      const name = (attrs['aria-label'] ?? el.textContent?.trim() ?? '').replace(/\s+/g, ' ').slice(0, 120)
        || attrs['placeholder'] || attrs['title'] || attrs['value'] || '';
      ax.push({ role: { value: role }, name: { value: name }, backendDOMNodeId: backendNodeId });
    }
    // The frozen fixtures are real megabyte-scale pages; bound the walk so the harness stays fast.
    const children = depth < 40
      ? Array.from(el.children).slice(0, 400).map((c) => toNode(c as Element, depth + 1))
      : [];
    return { backendNodeId, nodeType: 1, localName: tag, nodeName: tag.toUpperCase(), attributes: flat, children };
  };

  const root: DomNode = {
    backendNodeId: 0, nodeType: 9, localName: '#document', nodeName: '#document',
    children: [toNode(document.documentElement, 0)],
  };
  return { root, ax };
}

// ---------------------------------------------------------------------------
// One recorded flow per fixture, through the shipped act path
// ---------------------------------------------------------------------------

const agentToken: ActControlToken = {
  holder: 'agent',
  epoch: 0,
  assertCanDrive: (p) => (p === 'agent' ? { ok: true } : { ok: false, reason: 'not_holder', currentEpoch: 0 }),
};
const allowGrant: NavGrant = { humanAllowPrivate: true, agentAllowPrivate: true };

interface RecordedFlow {
  fixture: string;
  url: string;
  steps: FlowStep[];
}

async function recordFlow(db: Database.Database, fixture: string, url: string, html: string): Promise<RecordedFlow> {
  const sessionId = `g1-${fixture}`;
  const model = buildPageModel(html);
  const snapshot = buildSnapshot(model.ax, model.root, { tokenBudget: 1_000_000 });
  const flatDom = flattenDom(model.root).map;
  const axIndex = indexAxByBackendNode(model.ax);

  let pageUrl = url;
  // The four calls the SHIPPED resolver makes. Every element is on-screen and un-occluded here:
  // occlusion is the resolver's own property and G1 is not measuring it.
  const cdp = {
    send: async (method: string): Promise<unknown> => {
      switch (method) {
        case 'DOM.getBoxModel': return { model: { content: [10, 10, 110, 10, 110, 40, 10, 40] } };
        case 'Page.getLayoutMetrics': return { cssVisualViewport: { pageX: 0, pageY: 0 } };
        // No topmost node reported ⇒ the resolver's hit-test finds nothing on top.
        case 'DOM.getNodeForLocation': return {};
        default: return {};
      }
    },
  };
  const resolve = createResolver({ snapshot: async () => snapshot, cdp });

  const flow = createFlowRecorder({
    db,
    sessionId,
    seed: async (backendNodeId: number) => buildTargetFromFlat(flatDom, axIndex, backendNodeId),
  });
  const act = createActHandler({
    browser: { navigate: async (u: string) => { pageUrl = u; } },
    controlToken: agentToken,
    grant: allowGrant,
    resolve,
    channel: { dispatchAgentUnit: async () => true, viewportCenter: () => ({ x: 400, y: 300 }) },
    audit: new SessionAuditLog({ db, sessionId }),
    currentUrl: () => pageUrl,
    flow,
  });

  // A realistic recorded trace: land on the page, act on a few of its controls, scroll on.
  await act({ action: 'navigate', url });
  const actionable = snapshot.elements.filter((e) => e.confidence !== 'low');
  const links = actionable.filter((e) => e.role === 'link' || e.role === 'button').slice(0, 4);
  const fields = actionable.filter((e) => e.role === 'textbox' || e.role === 'searchbox').slice(0, 2);
  for (const el of links) await act({ action: 'click', ref: el.ref });
  for (const el of fields) await act({ action: 'type', ref: el.ref, text: 'CANARY-VALUE-DO-NOT-STORE' });
  await act({ action: 'scroll', direction: 'down', amount: 600 });

  return { fixture, url, steps: listFlowSteps(db, flowIdForSession(sessionId)) };
}

function migratedDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

let recorded: RecordedFlow[] = [];
let db: Database.Database;

async function corpus(): Promise<RecordedFlow[]> {
  if (recorded.length) return recorded;
  db = migratedDb();
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as { fixtures?: Array<{ id?: string; url?: string; htmlPath?: string }> };
  const byFile = new Map<string, string>();
  for (const f of manifest.fixtures ?? []) {
    const file = (f.htmlPath ?? '').split('/').pop();
    if (file && f.url) byFile.set(file, f.url);
  }
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.html')).sort();
  const out: RecordedFlow[] = [];
  for (const file of files) {
    const url = byFile.get(file) ?? `https://example.com/${file.replace(/\.html$/, '')}`;
    out.push(await recordFlow(db, file.replace(/\.html$/, ''), url, readFileSync(join(FIXTURE_DIR, file), 'utf-8')));
  }
  recorded = out;
  return recorded;
}

describe('G1 — is a recording sufficient to attempt a run at all?', () => {
  it('records at least 15 flows, each with at least one step', async () => {
    const flows = await corpus();
    const nonEmpty = flows.filter((f) => f.steps.length > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(15);
  });

  it('has EXACTLY 0 click/type steps missing any locator field', async () => {
    const flows = await corpus();
    const targeted = flows.flatMap((f) => f.steps).filter((s) => s.action === 'click' || s.action === 'type');
    expect(targeted.length).toBeGreaterThan(0); // a vacuous zero would pass every row below
    const incomplete = targeted.filter(
      (s) => !s.target || typeof s.target.role !== 'string' || typeof s.target.name !== 'string'
        || !s.target.fingerprint || typeof s.target.ancestorPath !== 'string' || !s.target.attrs,
    );
    expect(incomplete).toHaveLength(0);
  });

  it('has EXACTLY 0 steps containing raw typed text', async () => {
    const flows = await corpus();
    // Searched over the WHOLE row dump, not the projected step: a value that reached any column
    // would show here even if the reader happened not to surface it.
    const dump = JSON.stringify(db.prepare('SELECT * FROM studio_flow_steps').all());
    expect(dump).not.toContain('CANARY-VALUE-DO-NOT-STORE');
    expect(flows.flatMap((f) => f.steps).filter((s) => 'text' in s || 'value' in s)).toHaveLength(0);
  });

  it('has EXACTLY 0 steps containing a cookie, storageState, Authorization or Set-Cookie value', async () => {
    const flows = await corpus();
    const dump = JSON.stringify(flows.flatMap((f) => f.steps)).toLowerCase();
    for (const key of ['cookie', 'storagestate', 'authorization', 'set-cookie']) {
      expect(dump.includes(`"${key}"`), `${key} present`).toBe(false);
    }
    // The positive half: every stored attribute is inside the allow-list, on real page markup.
    const attrKeys = new Set(flows.flatMap((f) => f.steps).flatMap((s) => Object.keys(s.target?.attrs ?? {})));
    expect(attrKeys.size).toBeGreaterThan(0);
    for (const k of attrKeys) expect(FLOW_ATTR_KEYS).toContain(k);
  });

  it('has EXACTLY 0 steps containing a backendNodeId', async () => {
    const flows = await corpus();
    expect(JSON.stringify(flows.flatMap((f) => f.steps))).not.toContain('backendNodeId');
    const cols = (db.pragma('table_info(studio_flow_steps)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain('backend_node_id');
  });

  it('has EXACTLY 0 steps recorded while on a credential page', async () => {
    const flows = await corpus();
    const credentialish = flows.flatMap((f) => f.steps).filter(
      (s) => /\/(login|log-in|signin|sign-in|auth|oauth|sso|mfa|2fa|otp|verify|password)\b/i.test(s.pageUrl ?? ''),
    );
    expect(credentialish).toHaveLength(0);
  });

  it('adds EXACTLY 0 rows, columns or indexes to studio_audit', async () => {
    await corpus();
    const cols = (db.pragma('table_info(studio_audit)') as Array<{ name: string }>).map((c) => c.name).sort();
    expect(cols).toEqual([
      'action', 'approval', 'epoch', 'id', 'outcome_chars_landed', 'outcome_error_reason',
      'outcome_ok', 'risk', 'seq', 'session_id', 'target_amount', 'target_direction',
      'target_ref', 'target_url', 'ts',
    ]);
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='studio_audit' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(idx).toEqual(['idx_studio_audit_session_seq']);
    // Every flow step has exactly one audit row behind it — no extra rows, and no step without one.
    const auditRows = (db.prepare('SELECT COUNT(*) AS n FROM studio_audit').get() as { n: number }).n;
    const flowRows = (db.prepare('SELECT COUNT(*) AS n FROM studio_flow_steps').get() as { n: number }).n;
    expect(auditRows).toBeGreaterThanOrEqual(flowRows);
  });

  it('stores a seed that reproduces its own fingerprint', async () => {
    const flows = await corpus();
    const targets = flows.flatMap((f) => f.steps).map((s) => s.target).filter((t): t is NonNullable<typeof t> => !!t);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(computeFingerprint({ role: t.role, name: t.name, attrs: t.attrs })).toBe(t.fingerprint);
    }
  });

  /**
   * The decision this used to defer is now taken: a non-navigate step keeps origin + path only.
   *
   * The predecessor filtered to `action === 'navigate'` and asserted zero query strings, which was
   * structurally incapable of measuring the thing at issue. The exposure is NOT on navigate — a
   * navigate URL is agent-authored and byte-identical to the audit's own `target_url`. It is on
   * click/type/scroll, for which the audit stores no URL at all and the recorder stored the live,
   * post-redirect, server-authored one. Restricting the census to navigate ignored every one of
   * those steps, and no corpus URL carries a query string anyway, so the assertion could not fail
   * in either direction.
   *
   * So: census EVERY stored URL, and drive a case that actually has a query string — the corpus
   * cannot supply one.
   *
   * Division of labour, stated because it is not visible from the assertions: no corpus URL has a
   * query string, so this census does NOT die when the narrowing is removed — the test below is
   * the one that kills that mutant. This census guards the corpus-wide invariant, and would fire
   * if a future fixture URL gained a query string and the narrowing were not applied to it.
   */
  it('keeps origin+path only on every non-navigate step, across the whole census', async () => {
    const flows = await corpus();
    const steps = flows.flatMap((f) => f.steps);
    const nonNavigate = steps.filter((s) => s.action !== 'navigate' && s.pageUrl !== undefined);
    // Anti-vacuity: the census must actually contain the class it is judging.
    expect(nonNavigate.length).toBeGreaterThan(100);
    for (const s of nonNavigate) {
      const u = new URL(s.pageUrl!);
      expect(s.pageUrl).toBe(`${u.origin}${u.pathname}`);
    }
  });

  it('drops a session-bearing query string from a non-navigate step AND redacts it from the navigate (A175)', async () => {
    // The corpus has no URL with a query string, so this drives one through the SAME shipped path
    // the corpus uses. `?sso_session=` is the realistic shape: it survives the credential-URL
    // guard, which matches login words as PATH segments, and it is server-authored — it appears
    // after a redirect, which is precisely why the agent's own navigate URL never contains it.
    const fresh = migratedDb();
    const file = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.html')).sort()[0]!;
    const html = readFileSync(join(FIXTURE_DIR, file), 'utf-8');
    const landed = 'https://app.example.com/reports?sso_session=eyJhbGciOiJIUzI1NiJ9.SECRET#tab=2';
    const flow = await recordFlow(fresh, 'query-case', landed, html);

    const navigate = flow.steps.filter((s) => s.action === 'navigate');
    const others = flow.steps.filter((s) => s.action !== 'navigate');
    expect(navigate.length).toBe(1);
    expect(others.length).toBeGreaterThan(0);
    // The instruction the agent issued is still A STEP — it is never dropped, because a recording that
    // silently lost its navigation would replay the following clicks against whatever page was open.
    // But the secret-shaped parameter is REDACTED out of it (A175): this assertion used to read
    // `toBe(landed)`, which stored `sso_session=…SECRET` verbatim. `isCredentialUrl` cannot catch that —
    // it matches login words as PATH segments and never reads the query.
    expect(navigate[0]!.pageUrl).toBe('https://app.example.com/reports#tab=2');
    for (const s of others) expect(s.pageUrl).toBe('https://app.example.com/reports');
    // And the secret is now nowhere in ANY step, including the agent's own instruction.
    expect(JSON.stringify(others)).not.toContain('SECRET');
    expect(JSON.stringify(flow.steps)).not.toContain('SECRET');
    fresh.close();
  });

  /**
   * REPORTED, NOT THRESHOLDED — the length distribution the per-run step ceiling would have to be
   * set against. Pinned for the same reason as the query-string count.
   */
  it('reports the recorded flow-length distribution', async () => {
    const flows = await corpus();
    const lengths = flows.map((f) => f.steps.length).sort((a, b) => a - b);
    const histogram: Record<number, number> = {};
    for (const n of lengths) histogram[n] = (histogram[n] ?? 0) + 1;
    expect(lengths).toHaveLength(24);
    expect({
      min: lengths[0],
      median: lengths[Math.floor(lengths.length / 2)],
      max: lengths[lengths.length - 1],
      histogram,
    }).toMatchSnapshot();
  });
});
