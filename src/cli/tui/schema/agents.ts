import type { CategoryDef } from './types.js';
import { field } from './from-registry.js';

export const agentsCategory: CategoryDef = {
  id: 'agents',
  label: 'MCP Agents',
  description: 'Coding agents to install wigolo into (auto-syncs settings)',
  fields: [
    field('agents', {
      label: 'Installed agents',
      options: [
        { value: 'claude-code', label: 'Claude Code (CLI)' },
        { value: 'vscode', label: 'VS Code' },
        { value: 'zed', label: 'Zed' },
        { value: 'windsurf', label: 'Windsurf' },
        { value: 'cursor', label: 'Cursor' },
      ],
      help: 'Wigolo will be installed and its env block kept in sync with these agents.',
      // No env var resolves this list; it is read from config.json by the CLI
      // itself. The shipped catalog propagated it as WIGOLO_AGENTS into every
      // agent's env block, where nothing reads it.
      propagateToAgents: false,
    }),
  ],
};
