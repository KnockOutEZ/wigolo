/**
 * OpenAPI 3.1 assembly + /v1/tools index. Built once per process from the same
 * tool schemas the MCP server registers, the serve-mode clamp table, and the
 * documented top-level output fields — so a generated SDK cannot emit a request
 * the server would reject, and the served bounds cannot drift from enforcement.
 */
import {
  FETCH_TOOL_SCHEMA,
  SEARCH_TOOL_SCHEMA,
  CRAWL_TOOL_SCHEMA,
  CACHE_TOOL_SCHEMA,
  EXTRACT_TOOL_SCHEMA,
  FIND_SIMILAR_TOOL_SCHEMA,
  RESEARCH_TOOL_SCHEMA,
  AGENT_TOOL_SCHEMA,
  DIFF_TOOL_SCHEMA,
  WATCH_TOOL_SCHEMA,
} from '../../server/tool-schemas.js';
import { TOOL_DESCRIPTIONS, type ToolName } from '../../instructions.js';
import { CLAMP_TABLE } from './limits.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REST exposes the CORE tool surface only. The `studio_*` tools are MCP-only (D13:
 * the studio surface requires a live studio session and is never served over REST),
 * so they are excluded from the tool name here rather than stubbed into every map
 * below. Adding a core tool still fails the compile until all three maps cover it.
 */
type RestToolName = Exclude<ToolName, `studio_${string}`>;

/** Ordered tool list — drives path assembly and the /v1/tools index. */
const TOOL_ORDER: RestToolName[] = [
  'search', 'fetch', 'crawl', 'cache', 'extract',
  'find_similar', 'research', 'agent', 'diff', 'watch',
];

const TOOL_SCHEMAS: Record<RestToolName, object> = {
  fetch: FETCH_TOOL_SCHEMA,
  search: SEARCH_TOOL_SCHEMA,
  crawl: CRAWL_TOOL_SCHEMA,
  cache: CACHE_TOOL_SCHEMA,
  extract: EXTRACT_TOOL_SCHEMA,
  find_similar: FIND_SIMILAR_TOOL_SCHEMA,
  research: RESEARCH_TOOL_SCHEMA,
  agent: AGENT_TOOL_SCHEMA,
  diff: DIFF_TOOL_SCHEMA,
  watch: WATCH_TOOL_SCHEMA,
};

/**
 * Documented, stable top-level response fields per tool, mapped to a permissive
 * JSON-Schema type. `additionalProperties: true` keeps the full runtime shape
 * legal beneath — the served schema names the fields a caller can rely on, not
 * an exhaustive projection. `crawl` covers both the crawl and the map-strategy
 * shapes since one route serves both.
 */
const RESPONSE_FIELDS: Record<RestToolName, Record<string, string>> = {
  search: {
    results: 'array', query: 'string', engines_used: 'array', total_time_ms: 'number',
    response_time_ms: 'number', evidence: 'array', citations: 'array', highlights: 'array',
    answer: 'string', warning: 'string', error: 'string',
  },
  fetch: {
    url: 'string', title: 'string', markdown: 'string', metadata: 'object', links: 'array',
    images: 'array', cached: 'boolean', fetch_method: 'string', http_status: 'number',
    site_data: 'object', evidence: 'array', response_time_ms: 'number', error: 'string',
  },
  crawl: {
    pages: 'array', total_found: 'number', crawled: 'number', links: 'array',
    urls: 'array', sitemap_found: 'boolean', response_time_ms: 'number', error: 'string',
  },
  cache: {
    results: 'array', stats: 'object', cleared: 'number', changes: 'array', error: 'string',
  },
  extract: {
    data: 'object', source_url: 'string', mode: 'string', warnings: 'array',
    truncated: 'boolean', response_time_ms: 'number', error: 'string',
  },
  find_similar: {
    results: 'array', method: 'string', cache_hits: 'number', search_hits: 'number',
    embedding_available: 'boolean', cold_start: 'string', total_time_ms: 'number',
    response_time_ms: 'number', error: 'string',
  },
  research: {
    report: 'string', citations: 'array', sources: 'array', sub_queries: 'array',
    depth: 'string', total_time_ms: 'number', sampling_supported: 'boolean', brief: 'object',
    response_time_ms: 'number', error: 'string',
  },
  agent: {
    result: 'object', sources: 'array', pages_fetched: 'number', steps: 'array',
    total_time_ms: 'number', sampling_supported: 'boolean', warning: 'string',
    response_time_ms: 'number', error: 'string',
  },
  diff: {
    changed: 'boolean', unified_diff: 'string', hunks: 'array', summary: 'object',
    truncated: 'boolean',
  },
  watch: {
    job: 'object', jobs: 'array', changes_since_last: 'array', notice: 'string',
  },
};

/**
 * Implementation-name → capability-language substitutions applied to every
 * description string. User-facing text must never leak the underlying library
 * or engine names (CLAUDE.md naming rule) — the OpenAPI doc is user-facing.
 */
const CAPABILITY_SUBSTITUTIONS: [RegExp, string][] = [
  [/playwright/gi, 'browser engine'],
  [/chromium/gi, 'browser engine'],
  [/puppeteer/gi, 'browser engine'],
  [/searxng/gi, 'search sidecar'],
  [/readability/gi, 'content extractor'],
  [/defuddle/gi, 'content extractor'],
  [/turndown/gi, 'content extractor'],
  [/trafilatura/gi, 'content extractor'],
  [/fastembed/gi, 'embedding engine'],
  [/onnxruntime|onnx/gi, 'embedding engine'],
  [/sqlite-vec|sqlite/gi, 'local index'],
];

/** Replace any implementation names in a description with capability language. */
function sanitize(text: string): string {
  let out = text;
  for (const [pattern, replacement] of CAPABILITY_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Recursively sanitize every `description` string in a schema tree. */
function sanitizeSchema(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) sanitizeSchema(item);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.description === 'string') {
      obj.description = sanitize(obj.description);
    }
    for (const key of Object.keys(obj)) {
      if (key === 'description') continue;
      sanitizeSchema(obj[key]);
    }
  }
}

/**
 * Inject the serve-mode clamp bounds onto a deep-copied request-body schema.
 * Scalar clamps land as `maximum`; array clamps as `maxItems`. Handles the
 * `search.query` oneOf where the array branch carries the item bound.
 */
function injectClampBounds(tool: RestToolName, schema: Record<string, unknown>): void {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return;
  for (const spec of CLAMP_TABLE) {
    if (spec.tool !== tool) continue;
    const field = props[spec.field];
    if (!field) continue;
    if (spec.kind === 'scalar') {
      field.maximum = spec.max;
    } else {
      // Array clamp. The field may be a plain array schema or a oneOf whose
      // array branch carries the bound (search.query).
      if (field.type === 'array') {
        field.maxItems = spec.max;
      } else if (Array.isArray(field.oneOf)) {
        for (const branch of field.oneOf as Record<string, unknown>[]) {
          if (branch.type === 'array') branch.maxItems = spec.max;
        }
      }
    }
  }
}

/** Build the deep-copied, clamp-injected, sanitized request-body schema. */
function requestSchemaFor(tool: RestToolName): Record<string, unknown> {
  // Deep copy so the imported schema objects (also serving MCP ListTools) are
  // never mutated by assembly.
  const copy = JSON.parse(JSON.stringify(TOOL_SCHEMAS[tool])) as Record<string, unknown>;
  injectClampBounds(tool, copy);
  sanitizeSchema(copy);
  return copy;
}

/** Build a 200-response schema from the documented top-level fields. */
function responseSchemaFor(tool: RestToolName): object {
  const properties: Record<string, object> = {};
  for (const [field, type] of Object.entries(RESPONSE_FIELDS[tool])) {
    properties[field] = { type };
  }
  return { type: 'object', properties, additionalProperties: true };
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/daemon/rest/openapi.js in build, src/daemon/rest/openapi.ts in dev —
    // package.json is three levels up in both layouts.
    const pkgPath = join(here, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const STATUS_MAPPING_NOTE =
  'Error responses share the ErrorEnvelope shape. Status classes are coarse and ' +
  'keyed on exact reason/stage codes, never a free-text scan: 400 invalid input / ' +
  'over-cap / semantic-validation; 401 missing or invalid bearer token; 403 host or ' +
  'origin rejected; 404 no such route; 405 wrong method; 413 body over the size cap; ' +
  '429 too many in-flight requests; 500 internal error; 501 route not implemented; ' +
  '502 upstream fetch failure; 503 a subsystem (browser engine / search sidecar) is ' +
  'unavailable; 504 the route deadline elapsed. A 504 does not cancel the underlying ' +
  'work. A degraded-but-successful result stays 200 with honest fields (e.g. a ' +
  '`warning`) rather than an error status.';

const ERROR_STATUS_CODES = ['400', '401', '403', '404', '405', '413', '429', '500', '501', '502', '503', '504'];

function errorResponses(): Record<string, object> {
  const out: Record<string, object> = {};
  for (const code of ERROR_STATUS_CODES) {
    out[code] = {
      description: STATUS_MAPPING_NOTE,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
    };
  }
  return out;
}

/** Human-readable route summary; capability-sanitized. */
function summaryFor(tool: RestToolName): string {
  // First non-empty line of the tool description, trimmed to a summary.
  const firstLine = TOOL_DESCRIPTIONS[tool].split('\n')[0].trim();
  return sanitize(firstLine);
}

/** Full route description; capability-sanitized, with the search degradation note. */
function descriptionFor(tool: RestToolName): string {
  let desc = sanitize(TOOL_DESCRIPTIONS[tool]);
  if (tool === 'search') {
    desc +=
      '\n\nOver REST, `format: \'answer\'` degrades to keyless evidence synthesis: ' +
      'there is no client LLM sampling channel, so the server returns the assembled ' +
      'evidence rather than a sampled natural-language answer.';
  }
  return desc;
}

function buildPaths(): Record<string, object> {
  const paths: Record<string, object> = {};

  for (const tool of TOOL_ORDER) {
    paths[`/v1/${tool}`] = {
      post: {
        operationId: `${tool}`,
        summary: summaryFor(tool),
        description: descriptionFor(tool),
        security: [{}, { bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: requestSchemaFor(tool) } },
        },
        responses: {
          '200': {
            description: `Successful ${tool} result.`,
            content: { 'application/json': { schema: responseSchemaFor(tool) } },
          },
          ...errorResponses(),
        },
      },
    };
  }

  const openapiPath = {
    get: {
      operationId: 'getOpenApi',
      summary: 'The served OpenAPI 3.1 document.',
      description: 'Returns this document. Also available at /v1/openapi.json (identical body).',
      security: [{}, { bearerAuth: [] }],
      responses: {
        '200': {
          description: 'The OpenAPI 3.1 document.',
          content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
        },
        ...errorResponses(),
      },
    },
  };
  paths['/openapi.json'] = openapiPath;
  paths['/v1/openapi.json'] = openapiPath;

  paths['/v1/tools'] = {
    get: {
      operationId: 'listTools',
      summary: 'Discovery index of the available tools and their endpoints.',
      description: 'Returns an array of { name, description, endpoint } for every tool.',
      security: [{}, { bearerAuth: [] }],
      responses: {
        '200': {
          description: 'Tool discovery index.',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    endpoint: { type: 'string' },
                  },
                  required: ['name', 'description', 'endpoint'],
                },
              },
            },
          },
        },
        ...errorResponses(),
      },
    },
  };

  return paths;
}

let memoizedDoc: object | null = null;

/** Assemble the served OpenAPI 3.1 document. Built once per process. */
export function buildOpenApi(): object {
  if (memoizedDoc) return memoizedDoc;

  memoizedDoc = {
    openapi: '3.1.0',
    info: {
      title: 'wigolo REST API',
      version: readPackageVersion(),
      description: sanitize(
        'Local-first web intelligence over REST. Exposes the wigolo tools — search, ' +
        'fetch, crawl, cache, extract, find_similar, research, agent, diff, watch — as ' +
        'POST /v1/{tool} endpoints. Results are structured JSON. Core work (search / ' +
        'fetch / crawl / extract / cache) needs no API keys; a browser engine handles ' +
        'JS-rendered pages, a content extractor produces clean markdown, and an ML ' +
        'reranker orders search evidence.',
      ),
    },
    servers: [{ url: '/', description: 'This wigolo serve instance.' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Optional bearer token. Applies only when the operator configures ' +
            'WIGOLO_API_TOKEN (or WIGOLO_API_TOKEN_FILE). When unset on a loopback ' +
            'bind the API is open; security is therefore listed as optional per path.',
        },
      },
      schemas: {
        ErrorEnvelope: {
          type: 'object',
          description: STATUS_MAPPING_NOTE,
          properties: {
            ok: { type: 'boolean', enum: [false] },
            error: { type: 'string' },
            error_reason: { type: 'string' },
            stage: { type: 'string' },
            hint: { type: 'string' },
          },
          required: ['ok', 'error', 'error_reason'],
        },
      },
    },
    security: [{}, { bearerAuth: [] }],
    paths: buildPaths(),
  };

  return memoizedDoc;
}

/** Build the `/v1/tools` discovery payload: `[{name, description, endpoint}]`. */
export function buildToolsIndex(): object[] {
  return TOOL_ORDER.map((tool) => ({
    name: tool,
    description: summaryFor(tool),
    endpoint: `/v1/${tool}`,
  }));
}
