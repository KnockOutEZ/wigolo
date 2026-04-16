import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId } from '../agents.js';

interface SkillResult {
  id: AgentId;
  status: 'installed' | 'not_supported' | 'failed';
  detail: string;
}

export interface SkillResultInfo {
  id: string;
  status: string;
  name: string;
  detail: string;
}

interface SkillInstallProps {
  agents: AgentId[];
  onComplete: (results: SkillResultInfo[]) => void;
}

function getSkillContent(): string | null {
  // Try several locations for SKILL.md
  const candidates: string[] = [];

  // Relative to this source file (3 levels up from src/cli/tui/components/)
  try {
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    candidates.push(join(thisDir, '..', '..', '..', '..', 'SKILL.md'));
  } catch { /* ignore */ }

  // From cwd (common in dev)
  candidates.push(join(process.cwd(), 'SKILL.md'));

  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        return readFileSync(path, 'utf-8');
      }
    } catch { /* try next */ }
  }
  return null;
}

function installForAgent(agentId: AgentId, skillContent: string): SkillResult {
  try {
    switch (agentId) {
      case 'cursor': {
        const dir = join(process.cwd(), '.cursor', 'rules');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'wigolo.md'), skillContent);
        return { id: agentId, status: 'installed', detail: '.cursor/rules/wigolo.md' };
      }
      case 'vscode': {
        const dir = join(process.cwd(), '.github');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'copilot-instructions.md');
        if (existsSync(path)) {
          const existing = readFileSync(path, 'utf-8');
          if (!existing.includes('@staticn0va/wigolo')) {
            appendFileSync(path, '\n\n' + skillContent);
          }
        } else {
          writeFileSync(path, skillContent);
        }
        return { id: agentId, status: 'installed', detail: '.github/copilot-instructions.md' };
      }
      case 'zed': {
        const dir = join(process.cwd(), '.zed');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'rules.md');
        if (existsSync(path)) {
          const existing = readFileSync(path, 'utf-8');
          if (!existing.includes('@staticn0va/wigolo')) {
            appendFileSync(path, '\n\n' + skillContent);
          }
        } else {
          writeFileSync(path, skillContent);
        }
        return { id: agentId, status: 'installed', detail: '.zed/rules.md' };
      }
      case 'claude-code':
      case 'gemini-cli':
      case 'windsurf':
      case 'codex':
      case 'opencode':
        return { id: agentId, status: 'not_supported', detail: 'MCP instructions used instead' };
      default:
        return { id: agentId, status: 'not_supported', detail: 'no skill mechanism' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: agentId, status: 'failed', detail: message };
  }
}

const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  vscode: 'VS Code',
  zed: 'Zed',
  'gemini-cli': 'Gemini CLI',
  windsurf: 'Windsurf',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export function SkillInstall({ agents, onComplete }: SkillInstallProps) {
  const [results, setResults] = useState<SkillResult[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const skillContent = getSkillContent();
    if (!skillContent || agents.length === 0) {
      setDone(true);
      return;
    }

    const all: SkillResult[] = agents.map((id) => installForAgent(id, skillContent));
    setResults(all);
    setDone(true);
  }, [agents]);

  useEffect(() => {
    if (done) {
      const mapped: SkillResultInfo[] = results.map((r) => ({
        id: r.id,
        status: r.status,
        name: AGENT_NAMES[r.id] ?? r.id,
        detail: r.detail,
      }));
      const timer = setTimeout(() => onComplete(mapped), 300);
      return () => clearTimeout(timer);
    }
  }, [done, results, onComplete]);

  if (!done) {
    return (
      <Box paddingX={2}>
        <Spinner label="Installing agent skills..." />
      </Box>
    );
  }

  if (results.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Installing agent skills...</Text>
      <Box flexDirection="column" marginTop={1}>
        {results.map((r) => (
          <Text key={r.id}>
            {'  '}
            {r.status === 'installed' && <Text color="green">{'✓'}</Text>}
            {r.status === 'not_supported' && <Text dimColor>{'⊘'}</Text>}
            {r.status === 'failed' && <Text color="red">{'✗'}</Text>}
            {' '}{AGENT_NAMES[r.id] ?? r.id}
            {' '}<Text dimColor>{r.detail}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
