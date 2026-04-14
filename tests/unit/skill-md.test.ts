import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function parseYamlFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const yaml = match[1];
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;
  let currentObject: Record<string, unknown> | null = null;
  let inArray = false;
  let inNestedObject = false;

  for (const line of yaml.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '') continue;

    const topMatch = trimmed.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (topMatch && !trimmed.startsWith('  ')) {
      if (currentKey && currentArray) {
        result[currentKey] = currentArray;
      }
      currentKey = topMatch[1];
      const value = topMatch[2].trim();
      if (value === '') {
        currentArray = [];
        inArray = true;
      } else {
        result[currentKey] = value;
        currentKey = null;
        currentArray = null;
        inArray = false;
      }
      continue;
    }

    if (inArray && currentArray && trimmed.match(/^\s+-\s/)) {
      const itemMatch = trimmed.match(/^\s+-\s+(.*)$/);
      if (itemMatch) {
        const val = itemMatch[1].trim();
        if (val.includes(':')) {
          const obj: Record<string, unknown> = {};
          const parts = val.split(':');
          obj[parts[0].trim()] = parts.slice(1).join(':').trim();
          currentObject = obj;
          currentArray.push(obj);
          inNestedObject = true;
        } else {
          currentArray.push(val);
          inNestedObject = false;
        }
      }
      continue;
    }

    if (inNestedObject && currentObject && trimmed.match(/^\s{4,}\w/)) {
      const propMatch = trimmed.match(/^\s+(\w[\w_-]*):\s*(.*)$/);
      if (propMatch) {
        currentObject[propMatch[1]] = propMatch[2].trim();
      }
      continue;
    }
  }

  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }

  return result;
}

const SKILL_PATH = join(import.meta.dirname, '..', '..', 'SKILL.md');

describe('SKILL.md', () => {
  let content: string;
  let frontmatter: Record<string, unknown> | null;

  it('file exists and is readable', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    expect(content.length).toBeGreaterThan(100);
  });

  it('has YAML frontmatter delimiters', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content.indexOf('\n---', 4)).toBeGreaterThan(4);
  });

  it('frontmatter has required top-level fields', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    frontmatter = parseYamlFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.name).toBe('wigolo');
    expect(frontmatter!.description).toBeDefined();
    expect(typeof frontmatter!.description).toBe('string');
    expect(frontmatter!.author).toBeDefined();
    expect(frontmatter!.license).toBe('BUSL-1.1');
    expect(frontmatter!.repository).toContain('github.com/KnockOutEZ/wigolo');
  });

  it('frontmatter has transport field', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    frontmatter = parseYamlFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.transport).toBe('stdio');
  });

  it('frontmatter lists all 5 tools', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    frontmatter = parseYamlFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    const tools = frontmatter!.tools as unknown[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(5);
  });

  it('each tool entry has name and description', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    frontmatter = parseYamlFrontmatter(content);
    const tools = frontmatter!.tools as Array<Record<string, unknown>>;
    const expectedNames = ['search', 'fetch', 'crawl', 'cache', 'extract'];
    const foundNames = tools.map(t => t.name);
    for (const name of expectedNames) {
      expect(foundNames).toContain(name);
    }
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect((tool.description as string).length).toBeGreaterThan(10);
    }
  });

  it('body contains installation instructions', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    expect(content).toContain('npx @staticn0va/wigolo');
  });

  it('body contains example invocations', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    expect(content).toContain('search');
    expect(content).toContain('fetch');
  });

  it('body does not exceed 500 lines (keep it focused)', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    const lineCount = content.split('\n').length;
    expect(lineCount).toBeLessThan(500);
  });

  it('does not contain placeholder text', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    expect(content).not.toContain('TODO');
    expect(content).not.toContain('TBD');
    expect(content).not.toContain('PLACEHOLDER');
  });
});
