import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { Validator } from '@seriousme/openapi-schema-validator';
import { buildOpenApi, buildToolsIndex } from '../../../src/daemon/rest/openapi.js';
import { CLAMP_TABLE } from '../../../src/daemon/rest/limits.js';
import { MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT } from '../../../src/studio/run-store.js';
import * as SCHEMAS from '../../../src/server/tool-schemas.js';
import { DaemonHttpServer } from '../../../src/daemon/http-server.js';

/**
 * WHY: the served OpenAPI document is the machine contract SDK generators read.
 * If it does not validate against the 3.1 meta-schema, or its bounds drift from
 * the enforced clamp table, or it leaks an implementation name, generated SDKs
 * emit requests the server rejects or expose internal dependency names — both
 * are contract breaks these rows pin.
 */

const TOOLS = ['search', 'fetch', 'crawl', 'cache', 'extract', 'find_similar', 'research', 'agent', 'diff', 'watch'];

// The imported schema objects also serve MCP ListTools; assembly must not mutate
// them. Snapshot BEFORE any buildOpenApi() call.
const PRE_ASSEMBLY_SNAPSHOT: Record<string, string> = {
  FETCH_TOOL_SCHEMA: JSON.stringify(SCHEMAS.FETCH_TOOL_SCHEMA),
  SEARCH_TOOL_SCHEMA: JSON.stringify(SCHEMAS.SEARCH_TOOL_SCHEMA),
  CRAWL_TOOL_SCHEMA: JSON.stringify(SCHEMAS.CRAWL_TOOL_SCHEMA),
  CACHE_TOOL_SCHEMA: JSON.stringify(SCHEMAS.CACHE_TOOL_SCHEMA),
  EXTRACT_TOOL_SCHEMA: JSON.stringify(SCHEMAS.EXTRACT_TOOL_SCHEMA),
  FIND_SIMILAR_TOOL_SCHEMA: JSON.stringify(SCHEMAS.FIND_SIMILAR_TOOL_SCHEMA),
  RESEARCH_TOOL_SCHEMA: JSON.stringify(SCHEMAS.RESEARCH_TOOL_SCHEMA),
  AGENT_TOOL_SCHEMA: JSON.stringify(SCHEMAS.AGENT_TOOL_SCHEMA),
  DIFF_TOOL_SCHEMA: JSON.stringify(SCHEMAS.DIFF_TOOL_SCHEMA),
  WATCH_TOOL_SCHEMA: JSON.stringify(SCHEMAS.WATCH_TOOL_SCHEMA),
};

describe('OpenAPI document assembly', () => {
  it('validates against the OpenAPI 3.1 meta-schema', async () => {
    const doc = buildOpenApi();
    const validator = new Validator();
    const result = await validator.validate(doc as object);
    if (!result.valid) {
      // Surface the errors so a schema mistake is diagnosable, not just "false".
      console.error('OpenAPI validation errors:', JSON.stringify(result.errors, null, 2));
    }
    expect(result.valid).toBe(true);
  });

  it('declares openapi 3.1 + info.version = package version + title', async () => {
    const doc = buildOpenApi() as { openapi: string; info: { title: string; version: string } };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('wigolo REST API');
    // Package version, not the stub 0.0.0.
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(doc.info.version).not.toBe('0.0.0');
  });

  it('has a POST path for all 10 tools plus /v1/tools and the openapi aliases', () => {
    const doc = buildOpenApi() as { paths: Record<string, Record<string, unknown>> };
    for (const tool of TOOLS) {
      expect(doc.paths[`/v1/${tool}`]).toBeDefined();
      expect(doc.paths[`/v1/${tool}`].post).toBeDefined();
    }
    expect(doc.paths['/v1/tools']).toBeDefined();
    expect(doc.paths['/openapi.json']).toBeDefined();
    expect(doc.paths['/v1/openapi.json']).toBeDefined();
  });

  it('documents the untrusted-content representation header on EVERY tool route, defaulting to inline', () => {
    // A generated client must be able to DISCOVER the opt-out; prose in a markdown file is not the
    // machine contract. And the served `default` is what tells a reader which representation they
    // get for doing nothing — if it ever disagreed with the router's fallback, the contract would be
    // lying about a security-relevant default.
    // MUT: drop the parameter (or set default:'envelope') → RED for all 10 routes.
    const doc = buildOpenApi() as { paths: Record<string, { post: { parameters?: Array<{ name: string; in: string; schema: { enum: string[]; default: string } }> } }> };
    for (const tool of TOOLS) {
      const params = doc.paths[`/v1/${tool}`].post.parameters ?? [];
      const header = params.find((p) => p.name === 'X-Wigolo-Untrusted-Content');
      expect(header, `${tool} must document the representation header`).toBeDefined();
      expect(header?.in).toBe('header');
      expect(header?.schema.enum).toEqual(['inline', 'envelope']);
      expect(header?.schema.default).toBe('inline');
    }
  });

  it('injects the limits.ts clamp bounds onto the served schemas (drift gate)', () => {
    const doc = buildOpenApi() as { paths: Record<string, { post: { requestBody: { content: { 'application/json': { schema: Record<string, { properties?: Record<string, Record<string, unknown>> }> } } } } }> };
    for (const spec of CLAMP_TABLE) {
      const schema = doc.paths[`/v1/${spec.tool}`].post.requestBody.content['application/json'].schema as { properties: Record<string, Record<string, unknown>> };
      const field = schema.properties[spec.field];
      expect(field).toBeDefined();
      if (spec.kind === 'scalar') {
        expect(field.maximum).toBe(spec.max);
      } else {
        // Array clamp — either directly maxItems, or on the oneOf array branch.
        if (field.type === 'array') {
          expect(field.maxItems).toBe(spec.max);
        } else {
          const branches = field.oneOf as Record<string, unknown>[];
          const arrayBranch = branches.find((b) => b.type === 'array');
          expect(arrayBranch).toBeDefined();
          expect((arrayBranch as Record<string, unknown>).maxItems).toBe(spec.max);
        }
      }
    }
  });

  it('does not mutate the imported *_TOOL_SCHEMA objects', () => {
    // buildOpenApi already ran in earlier tests (memoized); assert the source
    // objects still deep-equal their pre-assembly snapshot.
    buildOpenApi();
    for (const [name, snapshot] of Object.entries(PRE_ASSEMBLY_SNAPSHOT)) {
      expect(JSON.stringify((SCHEMAS as Record<string, unknown>)[name])).toBe(snapshot);
    }
    // And specifically: the source search schema array branch has NO maxItems
    // (the bound lives only on the served copy).
    const src = SCHEMAS.SEARCH_TOOL_SCHEMA.properties.query as { oneOf: Record<string, unknown>[] };
    const arrayBranch = src.oneOf.find((b) => b.type === 'array') as Record<string, unknown>;
    expect(arrayBranch.maxItems).toBeUndefined();
    // The source crawl schema max_pages carries no `maximum`.
    const crawlMaxPages = SCHEMAS.CRAWL_TOOL_SCHEMA.properties.max_pages as Record<string, unknown>;
    expect(crawlMaxPages.maximum).toBeUndefined();
  });

  it('uses only capability language — no implementation names anywhere', () => {
    const doc = buildOpenApi();
    const json = JSON.stringify(doc).toLowerCase();
    const forbidden = ['playwright', 'searxng', 'readability', 'defuddle', 'turndown', 'trafilatura', 'fastembed', 'onnx', 'sqlite', 'chromium', 'puppeteer'];
    for (const term of forbidden) {
      expect(json.includes(term), `forbidden implementation name "${term}" leaked into the OpenAPI doc`).toBe(false);
    }
  });

  it('notes the format:answer degradation in the search route description', () => {
    const doc = buildOpenApi() as { paths: Record<string, { post: { description: string } }> };
    const desc = doc.paths['/v1/search'].post.description.toLowerCase();
    expect(desc).toContain('degrade');
    expect(desc).toContain('evidence');
  });

  it('references a shared ErrorEnvelope component with the documented status codes', () => {
    const doc = buildOpenApi() as {
      components: { schemas: { ErrorEnvelope: { required: string[]; properties: Record<string, unknown> } } };
      paths: Record<string, { post?: { responses: Record<string, unknown> } }>;
    };
    const env = doc.components.schemas.ErrorEnvelope;
    expect(env.required).toEqual(['ok', 'error', 'error_reason']);
    expect(env.properties.stage).toBeDefined();
    expect(env.properties.hint).toBeDefined();
    // Each tool route enumerates the documented error statuses.
    const searchResponses = doc.paths['/v1/search'].post!.responses;
    for (const code of ['400', '401', '403', '404', '405', '413', '429', '500', '501', '502', '503', '504']) {
      expect(searchResponses[code]).toBeDefined();
    }
  });

  it('marks the bearer security scheme as optional (http/bearer)', () => {
    const doc = buildOpenApi() as {
      components: { securitySchemes: { bearerAuth: { type: string; scheme: string } } };
      security: unknown[];
    };
    expect(doc.components.securitySchemes.bearerAuth.type).toBe('http');
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    // Optional = the empty requirement object is one of the alternatives.
    expect(doc.security).toContainEqual({});
  });
});

/**
 * WHY: the run surface is the part of the contract an SDK author cannot re-derive from the code —
 * a run outlives every UI, so the served document is the only thing telling them how to hold a
 * stream open, when to resume, and which statuses exist. The tool loop above never touches it, so
 * everything below was shipped unpinned: the vocabularies could drift from the router's enforcement
 * fully green, and the stream description could promise a lifetime the implementation does not keep.
 */
describe('OpenAPI run surface', () => {
  /**
   * The store's own vocabulary, read from its type declaration rather than from the daemon that
   * documents it. Deriving `expected` from the same module the doc derives from would make these
   * rows agree with themselves; the point is a signal from OUTSIDE the daemon.
   */
  function unionMembers(alias: string): string[] {
    const src = readFileSync(new URL(`../../../src/studio/run-store.ts`, import.meta.url), 'utf-8');
    const decl = new RegExp(`export type ${alias} =([^;]+);`).exec(src);
    if (!decl) throw new Error(`could not find "export type ${alias}" in run-store.ts`);
    return decl[1].split('|').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s.length > 0);
  }

  function runPaths(): Record<string, Record<string, { operationId?: string; description?: string; parameters?: Array<{ name: string; in: string; description?: string; schema: Record<string, unknown> }> }>> {
    return (buildOpenApi() as { paths: Record<string, Record<string, never>> }).paths;
  }

  it('serves all three run routes with their operation ids', () => {
    // MUT: drop any runPaths() entry → RED. A generated SDK silently loses the whole resource family.
    const paths = runPaths();
    expect(paths['/v1/runs']?.post?.operationId).toBe('createRun');
    expect(paths['/v1/runs']?.get?.operationId).toBe('listRuns');
    expect(paths['/v1/runs/{id}']?.get?.operationId).toBe('getRun');
    expect(paths['/v1/runs/{id}/events']?.get?.operationId).toBe('streamRunEvents');
  });

  it('documents exactly the store\'s run status vocabulary (drift gate)', () => {
    // Differential: the doc's enum against the RunStatus union in the store. Adding a seventh status
    // to the store without documenting it — or documenting one the store cannot produce — is RED.
    const expected = unionMembers('RunStatus');
    expect(expected.length).toBeGreaterThan(0);
    const doc = buildOpenApi() as { paths: Record<string, { get: { responses: Record<string, { content: { 'application/json': { schema: { properties: { run: { properties: { status: { enum: string[] } } } } } } } }> } }> };
    const status = doc.paths['/v1/runs/{id}'].get.responses['200'].content['application/json'].schema.properties.run.properties.status;
    expect([...status.enum].sort()).toEqual([...expected].sort());
    // And the list filter's description names the same set, so a 400 is diagnosable from the doc.
    const filter = runPaths()['/v1/runs'].get.parameters!.find((p) => p.name === 'status');
    for (const value of expected) expect(filter!.description).toContain(value);
  });

  it('documents exactly law 3\'s driver vocabulary (drift gate)', () => {
    const expected = unionMembers('DriverKind');
    const driver = runPaths()['/v1/runs'].post as unknown as { requestBody: { content: { 'application/json': { schema: { properties: { driver: { properties: { kind: { enum: string[] } } } } } } } } };
    expect([...driver.requestBody.content['application/json'].schema.properties.driver.properties.kind.enum].sort()).toEqual([...expected].sort());
  });

  it('serves the list bounds the router actually enforces', () => {
    // The router 400s a limit outside [1, MAX_LIST_LIMIT]; a doc that advertised a wider range would
    // have generated clients emitting requests the server rejects.
    const limit = runPaths()['/v1/runs'].get.parameters!.find((p) => p.name === 'limit');
    expect(limit!.schema.minimum).toBe(1);
    expect(limit!.schema.maximum).toBe(MAX_LIST_LIMIT);
    expect(limit!.schema.default).toBe(DEFAULT_LIST_LIMIT);
  });

  it('documents both resume points and says which one wins', () => {
    // Last-Event-ID is the ONLY way a client recovers from a server-side end; a doc that omitted it
    // would leave the reconnect path undiscoverable from the machine contract.
    const params = runPaths()['/v1/runs/{id}/events'].get.parameters!;
    const since = params.find((p) => p.name === 'since');
    expect(since!.schema.minimum).toBe(0);
    const resume = params.find((p) => p.name === 'Last-Event-ID');
    expect(resume!.in).toBe('header');
    expect(resume!.description!.toLowerCase()).toContain('precedence');
  });

  it('admits that the server ends the stream, and tells the client to resume rather than give up', () => {
    /**
     * The defect this row exists for: the description used to read "the server does not close the
     * stream, including after the run ends". `runs.ts` ends it at four doors — a stalled reader, a
     * hold-buffer overflow before and during the go-live flush, and an unhealable seq gap — and
     * every one of those log lines ends "so the client resumes". The implementation's correctness
     * argument DEPENDS on the reconnect the spec told SDK authors would never be needed, so a
     * client written to the old text treats the end as fatal and drops the tail permanently.
     * MUT: restore any never-closes phrasing → RED.
     */
    const desc = runPaths()['/v1/runs/{id}/events'].get.description!.toLowerCase();
    expect(desc).toMatch(/server may end the stream/);
    expect(desc).toContain('last-event-id');
    expect(desc).toMatch(/must treat it as a resume point|must .*resume/);
    // Each door a client can actually be on the wrong side of is named, so "why did it end" is
    // answerable from the contract alone.
    for (const cause of ['byte budget', 'overflows', 'gap']) expect(desc).toContain(cause);
    // No surviving promise that the server keeps it open forever.
    expect(desc).not.toMatch(/does not close|never close|will not close|does not end the stream/);
  });
});

describe('/v1/tools index', () => {
  it('returns one entry per tool with name/description/endpoint', () => {
    const index = buildToolsIndex() as { name: string; description: string; endpoint: string }[];
    expect(index).toHaveLength(10);
    for (const entry of index) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(entry.endpoint).toBe(`/v1/${entry.name}`);
    }
    const names = index.map((e) => e.name).sort();
    expect(names).toEqual([...TOOLS].sort());
  });

  it('carries no implementation names in its descriptions', () => {
    const json = JSON.stringify(buildToolsIndex()).toLowerCase();
    for (const term of ['playwright', 'searxng', 'readability', 'sqlite', 'chromium', 'onnx']) {
      expect(json.includes(term)).toBe(false);
    }
  });
});

describe('OpenAPI over a real DaemonHttpServer', () => {
  let daemon: DaemonHttpServer;
  let port: number;

  beforeAll(async () => {
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => { await daemon.stop(); }, 30000);

  function get(path: string): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path, headers: { Connection: 'close' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = text;
          try { body = JSON.parse(text); } catch { /* leave text */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('GET /openapi.json returns the assembled document', async () => {
    const r = await get('/openapi.json');
    expect(r.status).toBe(200);
    const body = r.body as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe('3.1.0');
    expect(body.paths['/v1/search']).toBeDefined();
  });

  it('GET /v1/openapi.json returns an identical body', async () => {
    const a = await get('/openapi.json');
    const b = await get('/v1/openapi.json');
    expect(b.status).toBe(200);
    expect(JSON.stringify(b.body)).toBe(JSON.stringify(a.body));
  });

  it('GET /v1/tools returns 10 entries', async () => {
    const r = await get('/v1/tools');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect((r.body as unknown[]).length).toBe(10);
  });
});
