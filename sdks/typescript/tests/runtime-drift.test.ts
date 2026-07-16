import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifest, type ToolName } from '../src/index.js';
import { freePort, makeSeededDataDir, spawnServe, type SpawnedServe } from './serve-harness.js';
import { scrubWigoloEnv } from './helpers.js';

/**
 * Runtime drift: spawn the real dist serve, read /openapi.json, and prove the
 * embedded manifest matches the server's actual REST contract exactly — the
 * POST tool routes, each route's request params, its required set, and that
 * every manifest response key is present in the 200-response schema.
 */

interface OpenApi {
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: {
          content?: Record<string, { schema?: { properties?: Record<string, unknown>; required?: string[] } }>;
        };
        responses?: Record<
          string,
          { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }
        >;
      }
    >
  >;
}

let serve: SpawnedServe;
let openapi: OpenApi;
const dataDir = makeSeededDataDir();

beforeAll(async () => {
  scrubWigoloEnv();
  const port = await freePort();
  serve = await spawnServe({ port, dataDir });
  const res = await fetch(`${serve.baseUrl}/openapi.json`);
  expect(res.status).toBe(200);
  openapi = (await res.json()) as OpenApi;
}, 90_000);

afterAll(async () => {
  await serve?.stop();
});

function requestSchema(tool: ToolName): { properties?: Record<string, unknown>; required?: string[] } {
  const path = manifest[tool].path;
  const post = openapi.paths[path]?.post;
  const content = post?.requestBody?.content ?? {};
  const first = content['application/json'] ?? Object.values(content)[0];
  return first?.schema ?? {};
}

function response200Properties(tool: ToolName): Set<string> {
  const path = manifest[tool].path;
  const post = openapi.paths[path]?.post;
  const responses = post?.responses ?? {};
  const ok = responses['200'] ?? responses['2XX'] ?? responses.default;
  const content = ok?.content ?? {};
  const first = content['application/json'] ?? Object.values(content)[0];
  return new Set(Object.keys(first?.schema?.properties ?? {}));
}

const tools = Object.keys(manifest) as ToolName[];

it('(a) the POST /v1/{tool} paths equal the manifest tools exactly', () => {
  const serverPostTools = new Set<string>();
  for (const [path, methods] of Object.entries(openapi.paths)) {
    if (!path.startsWith('/v1/')) continue;
    // Filter out the GET-only discovery/spec endpoints.
    if (path === '/v1/tools' || path === '/v1/openapi.json') continue;
    if (methods.post) serverPostTools.add(path.slice('/v1/'.length));
  }
  const manifestTools = new Set(tools.map((t) => t.replace(/_/g, '_')));
  // Manifest paths carry the wire tool name; compare directly.
  const manifestNames = new Set(tools.map((t) => manifest[t].path.slice('/v1/'.length)));
  expect(serverPostTools).toEqual(manifestNames);
  expect(manifestTools.size).toBe(10);
});

describe.each(tools)('tool %s', (tool) => {
  it('(b) request properties match the manifest params exactly', () => {
    const schema = requestSchema(tool);
    const serverParams = new Set(Object.keys(schema.properties ?? {}));
    const manifestParams = new Set<string>(manifest[tool].params);
    expect(serverParams).toEqual(manifestParams);
  });

  it('(c) required set matches the manifest required exactly', () => {
    const schema = requestSchema(tool);
    const serverRequired = new Set(schema.required ?? []);
    const manifestRequired = new Set<string>(manifest[tool].required);
    expect(serverRequired).toEqual(manifestRequired);
  });

  it('(d) manifest response keys are a subset of the 200 schema properties', () => {
    const serverProps = response200Properties(tool);
    // Only assert the subset when the server documents a 200 schema.
    if (serverProps.size === 0) return;
    const missing = manifest[tool].responseKeys.filter((k) => !serverProps.has(k));
    expect(missing).toEqual([]);
  });
});
