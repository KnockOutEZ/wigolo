import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import type { AgentId } from '../agents.js';
import { getAgentHandler } from '../../agents/registry.js';

interface SkillResult {
  id: AgentId;
  status: 'installed' | 'skipped' | 'not_supported' | 'failed';
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

const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  vscode: 'VS Code',
  zed: 'Zed',
  'gemini-cli': 'Gemini CLI',
  windsurf: 'Windsurf',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
};

async function installForAgent(agentId: AgentId): Promise<SkillResult> {
  const handler = getAgentHandler(agentId);
  if (!handler) {
    return { id: agentId, status: 'not_supported', detail: 'MCP only' };
  }

  try {
    const parts: string[] = [];

    await handler.installInstructions();
    parts.push('instructions');

    if (handler.supportsSkills && handler.installSkills) {
      await handler.installSkills();
      parts.push('8 skills');
    }

    if (handler.supportsCommands && handler.installCommand) {
      await handler.installCommand();
      parts.push('command');
    }

    if (parts.length === 0) {
      return { id: agentId, status: 'not_supported', detail: 'MCP only' };
    }

    return { id: agentId, status: 'installed', detail: parts.join(' + ') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: agentId, status: 'failed', detail: message };
  }
}

export function SkillInstall({ agents, onComplete }: SkillInstallProps) {
  const [results, setResults] = useState<SkillResult[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (agents.length === 0) {
      setDone(true);
      return;
    }

    Promise.all(agents.map((id) => installForAgent(id))).then((all) => {
      setResults(all);
      setDone(true);
    }).catch(() => {
      setDone(true);
    });
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
        <Spinner label="Installing agent skills and instructions..." />
      </Box>
    );
  }

  const visible = results.filter((r) => r.status !== 'not_supported');
  if (visible.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Installing agent skills and instructions...</Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((r) => (
          <Text key={r.id}>
            {'  '}
            {r.status === 'installed' && <Text color="green">{'✓'}</Text>}
            {r.status === 'failed' && <Text color="red">{'✗'}</Text>}
            {r.status === 'skipped' && <Text color="yellow">{'–'}</Text>}
            {' '}{AGENT_NAMES[r.id] ?? r.id}
            {' '}<Text dimColor>{r.detail}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
