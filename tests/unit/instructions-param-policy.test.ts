import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from '../../src/server/tool-schemas.js';
import { TOOL_DESCRIPTIONS, type ToolName } from '../../src/instructions.js';

/**
 * Policy (H4): param documentation lives in the input schema. A tool description
 * carries only what the schema structurally cannot say — response fields,
 * tool-choice guidance, cross-tool routing — plus a short index of param NAMES.
 *
 * The 400-token budget gate counts; it cannot tell whether the description is
 * spending those tokens on a second copy of the schema. This test makes "the
 * schema is right there" a checked claim: every param a description names must
 * actually exist in that tool's input schema, so an agent that keys off the
 * description's index never sends a key the server does not accept.
 */

function schemaProps(schema: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const props = obj.properties as Record<string, unknown> | undefined;
    if (props) for (const [k, v] of Object.entries(props)) { out.add(k); walk(v); }
    if (obj.items) walk(obj.items);
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      const arr = obj[key];
      if (Array.isArray(arr)) arr.forEach(walk);
    }
  };
  walk(schema);
  return out;
}

/** The bullet list under a `Key parameters…:` header, up to the next blank line. */
export function paramBlock(desc: string): string | null {
  const start = desc.search(/(?:^|\n)Key parameters[^\n]*:\n/);
  if (start < 0) return null;
  const from = desc.indexOf('\n', desc.indexOf('Key parameters', start)) + 1;
  const end = desc.indexOf('\n\n', from);
  return end < 0 ? desc.slice(from) : desc.slice(from, end);
}

const IDENT = /^[a-z][a-z0-9_]*$/;

/**
 * Param names a description CLAIMS, read from name position only: the head of
 * each bullet before its first ':', or the comma list after 'Also:'. Prose after
 * the colon is deliberately not scanned — a bullet may legitimately name the
 * output fields or enum values a param produces (`stream_answer`, `logo_url`),
 * and those are not input params. Parenthesised qualifiers (`(create-only)`,
 * `(check/pause/resume/delete)`) are stripped for the same reason.
 */
export function claimedParams(block: string): string[] {
  const names: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const body = line.slice(2);
    const also = body.match(/^Also:\s*(.*)$/);
    const head = (also ? also[1] : body.split(':')[0]).replace(/\([^)]*\)/g, '');
    for (const tok of head.split(/[/,]/)) {
      const t = tok.trim().replace(/\.+$/, '').trim();
      if (IDENT.test(t)) names.push(t);
    }
  }
  return [...new Set(names)];
}

const documented = (Object.keys(TOOL_DESCRIPTIONS) as ToolName[])
  .filter((name) => TOOL_SCHEMAS[name] && paramBlock(TOOL_DESCRIPTIONS[name]) !== null)
  .map((name) => ({
    name,
    claimed: claimedParams(paramBlock(TOOL_DESCRIPTIONS[name]) as string),
    props: schemaProps(TOOL_SCHEMAS[name]),
  }));

describe('tool description ↔ input schema param policy', () => {
  it('finds a param block for every core tool (guards against a silent no-op)', () => {
    // If a description stops using the `Key parameters:` convention this suite
    // would quietly assert nothing, so pin the set it actually covers.
    expect(documented.map((d) => d.name).sort()).toEqual(
      ['agent', 'cache', 'crawl', 'diff', 'extract', 'fetch', 'find_similar', 'research', 'search', 'watch'].sort(),
    );
    for (const d of documented) expect(d.claimed.length, `${d.name} names at least one param`).toBeGreaterThan(0);
  });

  describe.each(documented)('$name', ({ name, claimed, props }) => {
    it('every param named in the description exists in the input schema', () => {
      const unknown = claimed.filter((p) => !props.has(p));
      expect(
        unknown,
        `tool '${name}' description names param(s) absent from its input schema: ${unknown.join(', ')}. ` +
          `An agent keying off the description would send a key the server does not accept.`,
      ).toEqual([]);
    });
  });

  it('reports schema params not named in the description (informational)', () => {
    for (const { name, props } of documented) {
      const desc = TOOL_DESCRIPTIONS[name];
      const missing = [...props].filter((p) => !desc.includes(p));
      // eslint-disable-next-line no-console
      console.log(`  ${name.padEnd(14)} ${missing.length} schema param(s) not named in description: ${missing.join(', ') || '—'}`);
    }
    expect(documented.length).toBeGreaterThan(0);
  });
});

describe('param-policy predicate (controls)', () => {
  it('fires when a description names a param the schema does not have', () => {
    const props = new Set(['include_cache', 'max_results']);
    const claimed = claimedParams('- include_cached: true (default) to search cache first.\n- max_results: default 5.');
    expect(claimed.filter((p) => !props.has(p))).toEqual(['include_cached']);
  });

  it('does NOT fire on output-field or enum names in prose after the colon', () => {
    const props = new Set(['format', 'category']);
    const block = [
      "- format: omit = evidence context; 'answer' | 'stream_answer' = synthesis.",
      '- category: general | news. Image results carry image_url + thumbnail_url.',
    ].join('\n');
    expect(claimedParams(block).filter((p) => !props.has(p))).toEqual([]);
  });

  it('does NOT fire on parenthesised qualifier lists in name position', () => {
    const props = new Set(['job_id', 'url']);
    const block = '- job_id (check/pause/resume/delete).\n- url (create-only): must be public http/https.';
    const claimed = claimedParams(block);
    expect(claimed).toEqual(['job_id', 'url']);
    expect(claimed.filter((p) => !props.has(p))).toEqual([]);
  });
});
