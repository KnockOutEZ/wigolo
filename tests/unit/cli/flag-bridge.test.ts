import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  toolFlagSpecs,
  coerceFlags,
  booleanFlagsFor,
} from '../../../src/cli/flag-bridge.js';

describe('toolFlagSpecs', () => {
  it('derives a kebab-case flag with a coercion kind for each schema property', () => {
    const specs = toolFlagSpecs('search');
    const byFlag = new Map(specs.map((s) => [s.flag, s]));
    // snake_case → kebab-case
    expect(byFlag.has('max-results')).toBe(true);
    expect(byFlag.get('max-results')?.key).toBe('max_results');
    expect(byFlag.get('max-results')?.kind).toBe('number');
    // boolean
    expect(byFlag.get('include-content')?.kind).toBe('boolean');
    // enum carries its allowed values
    expect(byFlag.get('category')?.kind).toBe('enum');
    expect(byFlag.get('category')?.enumValues).toContain('news');
    // array of strings
    expect(byFlag.get('include-domains')?.kind).toBe('array-string');
    // object
    expect(byFlag.get('agent-context')?.kind).toBe('object');
  });

  it('classifies fetch actions (array of objects) distinctly from array of strings', () => {
    const specs = toolFlagSpecs('fetch');
    const actions = specs.find((s) => s.flag === 'actions');
    expect(actions?.kind).toBe('array-object');
  });

  it('classifies search query oneOf[string,array] as a oneof kind', () => {
    const specs = toolFlagSpecs('search');
    const query = specs.find((s) => s.flag === 'query');
    expect(query?.kind).toBe('oneof-string-array');
  });
});

describe('coerceFlags — coercion matrix', () => {
  it('number: valid → Number, NaN → error naming flag + expected type', () => {
    const ok = coerceFlags('search', { 'max-results': '5' });
    expect(ok.errors).toEqual([]);
    expect(ok.input.max_results).toBe(5);

    const bad = coerceFlags('search', { 'max-results': 'abc' });
    expect(bad.errors.length).toBe(1);
    expect(bad.errors[0]).toContain('--max-results');
    expect(bad.errors[0]).toContain('number');
  });

  it('boolean: bare flag = true; --x=false = false', () => {
    const bare = coerceFlags('search', { 'include-content': 'true' });
    expect(bare.input.include_content).toBe(true);

    const explicitFalse = coerceFlags('search', { 'include-content': 'false' });
    expect(explicitFalse.input.include_content).toBe(false);
  });

  it('boolean: --no-<x> sets the schema boolean false', () => {
    const negated = coerceFlags('search', { 'no-include-content': 'true' });
    expect(negated.input.include_content).toBe(false);
  });

  it('enum: valid passes; invalid errors and lists allowed values', () => {
    const ok = coerceFlags('search', { category: 'news' });
    expect(ok.errors).toEqual([]);
    expect(ok.input.category).toBe('news');

    const bad = coerceFlags('search', { category: 'bogus' });
    expect(bad.errors.length).toBe(1);
    expect(bad.errors[0]).toContain('--category');
    expect(bad.errors[0]).toContain('news');
  });

  it('array of strings: comma-split and trimmed', () => {
    const r = coerceFlags('search', { 'include-domains': 'a.com, b.com' });
    expect(r.errors).toEqual([]);
    expect(r.input.include_domains).toEqual(['a.com', 'b.com']);
  });

  it('array of objects: inline JSON accepted; comma-split REJECTED', () => {
    const ok = coerceFlags('fetch', {
      actions: '[{"type":"click","selector":".btn"}]',
    });
    expect(ok.errors).toEqual([]);
    expect(ok.input.actions).toEqual([{ type: 'click', selector: '.btn' }]);

    const commaSplit = coerceFlags('fetch', { actions: 'click,type' });
    expect(commaSplit.errors.length).toBe(1);
    expect(commaSplit.errors[0]).toContain('--actions');
  });

  it('object: inline JSON accepted', () => {
    const r = coerceFlags('search', { 'agent-context': '{"text":"ctx"}' });
    expect(r.errors).toEqual([]);
    expect(r.input.agent_context).toEqual({ text: 'ctx' });
  });

  it('oneOf query: single string unless value parses as a JSON array', () => {
    const single = coerceFlags('search', { query: 'react hooks' });
    expect(single.input.query).toBe('react hooks');

    const arr = coerceFlags('search', { query: '["a","b"]' });
    expect(arr.input.query).toEqual(['a', 'b']);
  });
});

describe('coerceFlags — @file reader', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads inline JSON from a regular file under 1 MiB', () => {
    dir = mkdtempSync(join(tmpdir(), 'flagbridge-'));
    const p = join(dir, 'schema.json');
    writeFileSync(p, '{"text":"from-file"}');
    const r = coerceFlags('search', { 'agent-context': `@${p}` });
    expect(r.errors).toEqual([]);
    expect(r.input.agent_context).toEqual({ text: 'from-file' });
  });

  it('rejects an @file over 1 MiB with a size error naming flag + path + limit, never echoing content', () => {
    dir = mkdtempSync(join(tmpdir(), 'flagbridge-'));
    const p = join(dir, 'big.json');
    const secret = 'TOPSECRET_PAYLOAD_MARKER';
    // > 1 MiB of content that also contains a secret marker.
    writeFileSync(p, `{"junk":"${secret}${'x'.repeat(1024 * 1024 + 16)}"}`);
    const r = coerceFlags('search', { 'agent-context': `@${p}` });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain('--agent-context');
    expect(r.errors[0]).toContain(p);
    expect(r.errors[0]).toContain('1 MiB');
    expect(r.errors[0]).not.toContain(secret);
  });

  it('rejects a non-regular @file (directory) without echoing anything readable', () => {
    dir = mkdtempSync(join(tmpdir(), 'flagbridge-'));
    const sub = join(dir, 'adir');
    mkdirSync(sub);
    const r = coerceFlags('search', { 'agent-context': `@${sub}` });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain('--agent-context');
    expect(r.errors[0]).toContain(sub);
  });
});

describe('coerceFlags — unknown flag + levenshtein suggestion', () => {
  it('errors on an unknown flag naming the tool', () => {
    const r = coerceFlags('search', { nonsense: 'x' });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain('unknown flag --nonsense for search');
  });

  it('suggests the nearest flag/alias when levenshtein distance ≤2', () => {
    // "limt" → "limit" (distance 1)
    const r = coerceFlags('search', { limt: '5' });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain('--limt');
    expect(r.errors[0]).toContain('--limit');
  });

  it('offers no suggestion when nothing is within distance 2', () => {
    const r = coerceFlags('search', { zzzzzzzzz: 'x' });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain('--zzzzzzzzz');
    expect(r.errors[0]).not.toContain('did you mean');
  });
});

describe('coerceFlags — curated aliases win', () => {
  it('--limit maps to max_results (curated over schema-derived)', () => {
    const r = coerceFlags('search', { limit: '7' });
    expect(r.errors).toEqual([]);
    expect(r.input.max_results).toBe(7);
  });

  it('--domains maps to include_domains, comma-split', () => {
    const r = coerceFlags('search', { domains: 'a.com,b.com' });
    expect(r.input.include_domains).toEqual(['a.com', 'b.com']);
  });

  it('--no-cache / --no-web / --no-content are boolean-false curated aliases', () => {
    const nc = coerceFlags('find-similar', { 'no-cache': 'true' });
    expect(nc.input.include_cache).toBe(false);
    const nw = coerceFlags('find-similar', { 'no-web': 'true' });
    expect(nw.input.include_web).toBe(false);
    const ncontent = coerceFlags('search', { 'no-content': 'true' });
    expect(ncontent.input.include_content).toBe(false);
  });
});

describe('booleanFlagsFor', () => {
  it('includes schema booleans, their no- variants, and curated boolean aliases', () => {
    const set = booleanFlagsFor('search');
    expect(set.has('include-content')).toBe(true);
    expect(set.has('no-include-content')).toBe(true);
    expect(set.has('no-content')).toBe(true);
  });

  it('MANDATED: search --no-content keeps the following query positional (no-value flag)', () => {
    const set = booleanFlagsFor('search');
    // The bare boolean must be in the set so the parser does not swallow the query.
    expect(set.has('no-content')).toBe(true);
  });

  it('does NOT include value-taking flags like max-results', () => {
    const set = booleanFlagsFor('search');
    expect(set.has('max-results')).toBe(false);
  });
});
