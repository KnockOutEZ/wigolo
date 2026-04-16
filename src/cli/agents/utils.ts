import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

function getPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli/agents/utils.js → ../../.. = package root
  return join(here, '..', '..', '..');
}

export function getVersion(): string {
  try {
    const raw = readFileSync(join(getPackageRoot(), 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function readAsset(relPath: string): string {
  const full = join(getPackageRoot(), 'assets', relPath);
  return readFileSync(full, 'utf-8').replace(/\{version\}/g, getVersion());
}

/** Returns { 'SKILL.md': content, 'rules/cache-first.md': content, ... } */
export function readSkillDir(name: string): Record<string, string> {
  const dir = join(getPackageRoot(), 'assets', 'skills', name);
  const result: Record<string, string> = {};

  const mainPath = join(dir, 'SKILL.md');
  if (existsSync(mainPath)) {
    result['SKILL.md'] = readFileSync(mainPath, 'utf-8');
  }

  const rulesDir = join(dir, 'rules');
  if (existsSync(rulesDir)) {
    for (const file of readdirSync(rulesDir)) {
      if (file.endsWith('.md')) {
        result[`rules/${file}`] = readFileSync(join(rulesDir, file), 'utf-8');
      }
    }
  }

  return result;
}

/**
 * Merge a block (delimited by wigolo:start/wigolo:end markers) into a file.
 * Creates the file if it doesn't exist.
 * Replaces an existing block, or appends if no block present.
 */
export function mergeBlock(filePath: string, block: string): void {
  mkdirSync(dirname(filePath), { recursive: true });

  const START = '<!-- wigolo:start';
  const END = '<!-- wigolo:end -->';

  if (!existsSync(filePath)) {
    writeFileSync(filePath, block.trimEnd() + '\n', 'utf-8');
    return;
  }

  const content = readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(START);
  const endIdx = content.indexOf(END);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = content.slice(0, startIdx).trimEnd();
    const after = content.slice(endIdx + END.length).trimStart();
    const parts = [before, block.trimEnd(), after].filter(Boolean);
    writeFileSync(filePath, parts.join('\n\n') + '\n', 'utf-8');
  } else {
    const trimmed = content.trimEnd();
    writeFileSync(filePath, trimmed + '\n\n' + block.trimEnd() + '\n', 'utf-8');
  }
}

/** Remove the wigolo block from a file. Returns true if a block was removed. */
export function removeBlock(filePath: string): boolean {
  if (!existsSync(filePath)) return false;

  const START = '<!-- wigolo:start';
  const END = '<!-- wigolo:end -->';
  const content = readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(START);
  const endIdx = content.indexOf(END);

  if (startIdx === -1 || endIdx === -1) return false;

  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + END.length).trimStart();
  const parts = [before, after].filter(Boolean);
  const newContent = parts.join('\n\n');
  writeFileSync(filePath, newContent ? newContent + '\n' : '', 'utf-8');
  return true;
}

/**
 * Create or merge an MCP server entry into a JSON config file.
 * keyPath like ['mcpServers', 'wigolo'] navigates/creates nested keys.
 * Other servers in the file are preserved.
 */
export function mergeMcpJson(
  configPath: string,
  entry: Record<string, unknown>,
  keyPath: string[],
): void {
  mkdirSync(dirname(configPath), { recursive: true });

  let root: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      root = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      root = {};
    }
  }

  let obj = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (typeof obj[key] !== 'object' || obj[key] === null) {
      obj[key] = {};
    }
    obj = obj[key] as Record<string, unknown>;
  }
  obj[keyPath[keyPath.length - 1]] = entry;

  writeFileSync(configPath, JSON.stringify(root, null, 2) + '\n', 'utf-8');
}

/** Remove the wigolo entry from a JSON MCP config, preserving other servers. */
export function removeMcpJson(configPath: string, keyPath: string[]): void {
  if (!existsSync(configPath)) return;

  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }

  let obj = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (typeof obj[key] !== 'object' || obj[key] === null) return;
    obj = obj[key] as Record<string, unknown>;
  }
  delete obj[keyPath[keyPath.length - 1]];

  writeFileSync(configPath, JSON.stringify(root, null, 2) + '\n', 'utf-8');
}

/** Detect whether wigolo is installed globally and return the appropriate command. */
export function getMcpCommand(): { command: string; args: string[] } {
  try {
    const path = execSync('which wigolo', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (path) {
      return { command: 'wigolo', args: [] };
    }
  } catch {
    // not found globally
  }
  return { command: 'npx', args: ['-y', '@staticn0va/wigolo'] };
}
