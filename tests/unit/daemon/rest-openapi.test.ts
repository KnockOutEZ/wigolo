import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { Validator } from '@seriousme/openapi-schema-validator';
import { buildOpenApi, buildToolsIndex } from '../../../src/daemon/rest/openapi.js';
import { CLAMP_TABLE } from '../../../src/daemon/rest/limits.js';
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
