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
const INSTRUCTIONS_PATH = join(import.meta.dirname, '..', '..', 'src', 'instructions.ts');

describe('SKILL.md — v3 structure and content', () => {
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

  it('body does not exceed 500 lines', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    const lineCount = content.split('\n').length;
    expect(lineCount).toBeLessThan(500);
  });

  it('does not contain placeholder text', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    expect(content).not.toContain('TODO');
    expect(content).not.toContain('TBD');
    expect(content).not.toContain('PLACEHOLDER');
    expect(content).not.toContain('FIXME');
  });

  it('frontmatter has required top-level fields', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    frontmatter = parseYamlFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.name).toBe('wigolo');
    expect(typeof frontmatter!.description).toBe('string');
    expect((frontmatter!.description as string).length).toBeGreaterThan(20);
    expect(frontmatter!.author).toBe('KnockOutEZ');
    expect(frontmatter!.license).toBe('BUSL-1.1');
    expect(frontmatter!.repository).toContain('github.com/KnockOutEZ/wigolo');
    expect(frontmatter!.transport).toBe('stdio');
    expect(frontmatter!.install).toContain('npx @staticn0va/wigolo');
    expect(frontmatter!.runtime).toBe('node');
  });

  it('frontmatter lists all 8 v3 tools', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    frontmatter = parseYamlFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    const tools = frontmatter!.tools as unknown[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(8);
  });

  it('frontmatter tools include v3 additions: find_similar, research, agent', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    frontmatter = parseYamlFrontmatter(content);
    const tools = frontmatter!.tools as Array<Record<string, unknown>>;
    const toolNames = tools.map(t => t.name);
    for (const name of ['find_similar', 'research', 'agent']) {
      expect(toolNames).toContain(name);
    }
  });

  it('frontmatter tools include all v1/v2 tools', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    frontmatter = parseYamlFrontmatter(content);
    const tools = frontmatter!.tools as Array<Record<string, unknown>>;
    const toolNames = tools.map(t => t.name);
    for (const name of ['search', 'fetch', 'crawl', 'cache', 'extract']) {
      expect(toolNames).toContain(name);
    }
  });

  it('each tool entry has name and non-empty description', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    frontmatter = parseYamlFrontmatter(content);
    const tools = frontmatter!.tools as Array<Record<string, unknown>>;
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect((tool.description as string).length).toBeGreaterThan(10);
    }
  });

  it('body contains installation instructions for Claude Code and generic MCP', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    expect(content).toContain('npx @staticn0va/wigolo');
    expect(content).toContain('claude mcp add');
    expect(content).toContain('mcpServers');
  });

  it('body contains a workflow patterns section', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toContain('workflow');
    expect(content).toContain('search');
    expect(content).toContain('fetch');
    expect(content).toContain('crawl');
    expect(content).toContain('find_similar');
    expect(content).toContain('research');
    expect(content).toContain('agent');
  });

  it('workflow patterns describe when to use each tool type', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    const guidePatterns = [
      /when.*search/i,
      /when.*fetch/i,
      /when.*crawl/i,
    ];
    for (const pattern of guidePatterns) {
      expect(content).toMatch(pattern);
    }
  });

  it('body contains parameter optimization guidance', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toContain('parameter');
    expect(content).toContain('max_results');
    expect(content).toContain('include_domains');
  });

  it('parameter guidance includes concrete values', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    const hasNumbers = /max_results.*\d+/i.test(content) || /\d+.*max_results/i.test(content);
    expect(hasNumbers).toBe(true);
  });

  it('body contains an anti-patterns section', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    const lower = content.toLowerCase();
    const hasAntiPatterns = lower.includes('anti-pattern') ||
      lower.includes('don\'t') || lower.includes('avoid') ||
      lower.includes('never') || lower.includes('do not');
    expect(hasAntiPatterns).toBe(true);
  });

  it('anti-patterns warn against retrying same query', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    const lower = content.toLowerCase();
    const hasRetryWarning = lower.includes('retry') || lower.includes('same query') ||
      lower.includes('repeat') || lower.includes('identical');
    expect(hasRetryWarning).toBe(true);
  });

  it('anti-patterns warn against skipping cache', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    const lower = content.toLowerCase();
    const hasCacheWarning = (lower.includes('skip') && lower.includes('cache')) ||
      (lower.includes('cache') && lower.includes('first'));
    expect(hasCacheWarning).toBe(true);
  });

  it('does not copy WIGOLO_INSTRUCTIONS verbatim', () => {
    content = readFileSync(SKILL_PATH, 'utf-8');
    let instructionsSrc: string;
    try {
      instructionsSrc = readFileSync(INSTRUCTIONS_PATH, 'utf-8');
    } catch {
      return;
    }
    const instrMatch = instructionsSrc.match(/WIGOLO_INSTRUCTIONS\s*=\s*`([\s\S]*?)`/);
    if (!instrMatch) return;
    const instructions = instrMatch[1];
    const paragraphs = instructions.split('\n\n').filter(p => p.trim().length > 80);
    for (const para of paragraphs) {
      const trimmedPara = para.trim();
      expect(content).not.toContain(trimmedPara);
    }
  });
});
