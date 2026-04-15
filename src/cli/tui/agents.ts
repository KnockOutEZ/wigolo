import { join } from 'node:path';
import type { AgentDescriptor, DetectedAgent } from './agents-types.js';
import { binaryInPath, dirExists, fileExists, getHome, getCwd } from './detect-helpers.js';

export type { AgentId, AgentDescriptor, DetectedAgent, InstallType } from './agents-types.js';

const claudeCode: AgentDescriptor = {
  id: 'claude-code',
  displayName: 'Claude Code',
  installType: 'cli-command',
  detect: () => binaryInPath('claude') !== null,
  configPath: () => null,
};

const cursor: AgentDescriptor = {
  id: 'cursor',
  displayName: 'Cursor',
  installType: 'config-file',
  detect: ({ cwd, home }) =>
    dirExists(join(cwd, '.cursor')) ||
    dirExists(join(home, '.cursor')) ||
    binaryInPath('cursor') !== null,
  configPath: ({ cwd, home }) => {
    if (dirExists(join(cwd, '.cursor'))) return join(cwd, '.cursor', 'mcp.json');
    return join(home, '.cursor', 'mcp.json');
  },
};

const vscode: AgentDescriptor = {
  id: 'vscode',
  displayName: 'VS Code (Copilot)',
  installType: 'config-file',
  detect: ({ cwd, home }) =>
    dirExists(join(cwd, '.vscode')) ||
    dirExists(join(home, '.vscode')) ||
    binaryInPath('code') !== null,
  configPath: ({ cwd, home }) => {
    if (dirExists(join(cwd, '.vscode'))) return join(cwd, '.vscode', 'mcp.json');
    return join(home, '.vscode', 'mcp.json');
  },
};

const zed: AgentDescriptor = {
  id: 'zed',
  displayName: 'Zed',
  installType: 'config-file',
  detect: ({ home }) =>
    dirExists(join(home, '.config', 'zed')) ||
    binaryInPath('zed') !== null,
  configPath: ({ home }) => join(home, '.config', 'zed', 'settings.json'),
};

export const AGENTS: readonly AgentDescriptor[] = [
  claudeCode,
  cursor,
  vscode,
  zed,
];

export interface DetectAgentsOptions {
  cwd?: string;
  home?: string;
}

export function detectAgents(opts: DetectAgentsOptions = {}): DetectedAgent[] {
  const env = {
    cwd: opts.cwd ?? getCwd(),
    home: opts.home ?? getHome(),
  };
  return AGENTS.map((d) => ({
    id: d.id,
    displayName: d.displayName,
    detected: d.detect(env),
    configPath: d.configPath(env),
    installType: d.installType,
  }));
}

export { fileExists };
