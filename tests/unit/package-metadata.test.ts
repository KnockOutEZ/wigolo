import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PKG_PATH = join(import.meta.dirname, '..', '..', 'package.json');

describe('package.json — MCP registry metadata', () => {
  let pkg: Record<string, unknown>;

  it('package.json exists and is valid JSON', () => {
    const raw = readFileSync(PKG_PATH, 'utf-8');
    pkg = JSON.parse(raw);
    expect(pkg).toBeDefined();
  });

  it('has required top-level fields for registry publishing', () => {
    pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    expect(pkg.name).toBe('@staticn0va/wigolo');
    expect(typeof pkg.version).toBe('string');
    expect(typeof pkg.description).toBe('string');
    expect((pkg.description as string).length).toBeGreaterThan(10);
    expect(pkg.license).toBeDefined();
    expect(pkg.repository).toBeDefined();
  });

  it('has publishConfig.access set to public', () => {
    pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    const publishConfig = pkg.publishConfig as Record<string, unknown>;
    expect(publishConfig).toBeDefined();
    expect(publishConfig.access).toBe('public');
  });

  it('keywords include all required MCP registry terms', () => {
    pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    const keywords = pkg.keywords as string[];
    expect(Array.isArray(keywords)).toBe(true);
    const required = ['mcp', 'mcp-server', 'ai-agent', 'web-search', 'web-scraping', 'local-first'];
    for (const kw of required) {
      expect(keywords).toContain(kw);
    }
  });

  it('keywords include tool-specific terms for discoverability', () => {
    pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    const keywords = pkg.keywords as string[];
    const toolTerms = ['search', 'scraping', 'crawler', 'content-extraction'];
    let matchCount = 0;
    for (const term of toolTerms) {
      if (keywords.some(kw => kw.includes(term))) matchCount++;
    }
    expect(matchCount).toBeGreaterThanOrEqual(3);
  });

  it('files array includes SKILL.md', () => {
    pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    const files = pkg.files as string[];
    expect(Array.isArray(files)).toBe(true);
    expect(files).toContain('SKILL.md');
  });

  it('has mcp configuration field', () => {
    pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    const mcp = pkg.mcp as Record<string, unknown>;
    expect(mcp).toBeDefined();
    expect(mcp.transport).toBe('stdio');
    expect(mcp.command).toBeDefined();
  });

  it('repository field is a valid GitHub URL', () => {
    pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    const repo = pkg.repository as Record<string, unknown>;
    expect(repo.type).toBe('git');
    expect(repo.url).toContain('github.com');
    expect(repo.url).toContain('wigolo');
  });

  it('bin field defines the wigolo command', () => {
    pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    const bin = pkg.bin as Record<string, unknown>;
    expect(bin).toBeDefined();
    expect(bin.wigolo).toBeDefined();
  });

  it('SKILL.md file actually exists in repo root', () => {
    const skillPath = join(import.meta.dirname, '..', '..', 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
  });
});
