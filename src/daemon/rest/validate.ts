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

/**
 * Input validation against the existing tool JSON schemas. ajv is
 * dynamic-imported on the first validation (never at boot / in stdio mode),
 * compiled once per tool, and memoized. 400 detail = instance path + constraint
 * message + a static hint — never the offending input value (verbose:false).
 */

const SCHEMAS: Record<string, object> = {
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

export type ValidateResult = { ok: true } | { ok: false; detail: string };

type ValidateFn = (data: unknown) => boolean;
interface ErrorObject {
  instancePath?: string;
  message?: string;
  keyword?: string;
  params?: Record<string, unknown>;
}

let ajvInstance: { compile: (schema: object) => ValidateFn & { errors?: ErrorObject[] | null } } | null = null;
const compiled = new Map<string, ValidateFn & { errors?: ErrorObject[] | null }>();

async function getAjv() {
  if (ajvInstance) return ajvInstance;
  const mod = await import('ajv');
  const Ajv = mod.default as unknown as new (opts: object) => typeof ajvInstance & object;
  ajvInstance = new Ajv({ strict: false, verbose: false, allErrors: false }) as unknown as typeof ajvInstance;
  return ajvInstance!;
}

/** Static, value-free description of a single ajv error. */
function describeError(e: ErrorObject): string {
  const path = e.instancePath && e.instancePath.length > 0 ? e.instancePath : '(root)';
  const missing = e.keyword === 'required' && e.params && typeof e.params.missingProperty === 'string'
    ? ` (missing property "${e.params.missingProperty}")`
    : '';
  return `${path}: ${e.message ?? 'invalid'}${missing}`;
}

export async function validateInput(tool: string, body: unknown): Promise<ValidateResult> {
  const schema = SCHEMAS[tool];
  if (!schema) {
    return { ok: false, detail: `Unknown tool "${tool}".` };
  }

  let validate = compiled.get(tool);
  if (!validate) {
    const ajv = await getAjv();
    validate = ajv.compile(schema);
    compiled.set(tool, validate);
  }

  const valid = validate(body);
  if (valid) return { ok: true };

  const first = validate.errors?.[0];
  const detail = first
    ? `Schema validation failed at ${describeError(first)}. Check the request against the tool input schema.`
    : 'Schema validation failed. Check the request against the tool input schema.';
  return { ok: false, detail };
}
