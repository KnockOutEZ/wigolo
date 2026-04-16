import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { AgentId } from '../agents.js';

interface SkillResult {
  id: AgentId;
  status: 'installed' | 'failed';
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

const WIGOLO_MARKER = '@staticn0va/wigolo';

const INSTRUCTION_SNIPPET = `
## Wigolo — Web Intelligence MCP

This environment has the **wigolo** MCP server configured for local-first web intelligence. Use wigolo tools for:
- Web search (\`search\`), page fetching (\`fetch\`), site crawling (\`crawl\`)
- Content extraction (\`extract\`), similarity search (\`find_similar\`)
- Multi-step research (\`research\`), agent-driven data gathering (\`agent\`)
- Local SQLite cache (\`cache\`) for instant access to previously fetched content

Always check the cache before searching the web. Use keyword queries, not natural language questions.
For full tool documentation, parameters, and workflow patterns, refer to the wigolo skill/rules file.
<!-- ${WIGOLO_MARKER} -->
`.trimStart();

interface AgentSkillConfig {
  skillPath: (home: string) => string;
  instructionPath?: (home: string) => string;
}

const SKILL_CONFIGS: Record<AgentId, AgentSkillConfig> = {
  'claude-code': {
    skillPath: (home) => join(home, '.claude', 'commands', 'wigolo.md'),
    instructionPath: (home) => join(home, '.claude', 'CLAUDE.md'),
  },
  cursor: {
    skillPath: (home) => join(home, '.cursor', 'rules', 'wigolo.md'),
  },
  vscode: {
    skillPath: (home) => join(home, '.vscode', 'wigolo.md'),
  },
  zed: {
    skillPath: (home) => join(home, '.config', 'zed', 'wigolo.md'),
  },
  'gemini-cli': {
    skillPath: (home) => join(home, '.gemini', 'wigolo.md'),
    instructionPath: (home) => join(home, '.gemini', 'GEMINI.md'),
  },
  windsurf: {
    skillPath: (home) => join(home, '.codeium', 'windsurf', 'wigolo.md'),
  },
  codex: {
    skillPath: (home) => join(home, '.codex', 'wigolo.md'),
    instructionPath: (home) => join(home, '.codex', 'AGENTS.md'),
  },
  opencode: {
    skillPath: (home) => join(home, '.config', 'opencode', 'wigolo.md'),
  },
};

function getSkillContent(): string | null {
  const candidates: string[] = [];

  try {
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    candidates.push(join(thisDir, '..', '..', '..', '..', 'SKILL.md'));
  } catch { /* ignore */ }

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

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
}

function addInstructionSnippet(filePath: string): void {
  ensureDir(filePath);
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    if (existing.includes(WIGOLO_MARKER)) return;
    appendFileSync(filePath, '\n' + INSTRUCTION_SNIPPET);
  } else {
    writeFileSync(filePath, INSTRUCTION_SNIPPET);
  }
}

function installForAgent(agentId: AgentId, skillContent: string, home: string): SkillResult {
  const config = SKILL_CONFIGS[agentId];
  if (!config) {
    return { id: agentId, status: 'failed', detail: 'no skill config defined' };
  }

  try {
    const skillPath = config.skillPath(home);
    ensureDir(skillPath);
    writeFileSync(skillPath, skillContent);

    if (config.instructionPath) {
      addInstructionSnippet(config.instructionPath(home));
    }

    const relativePath = skillPath.replace(home, '~');
    return { id: agentId, status: 'installed', detail: relativePath };
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

    const home = homedir();
    const all: SkillResult[] = agents.map((id) => installForAgent(id, skillContent, home));
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
            {r.status === 'failed' && <Text color="red">{'✗'}</Text>}
            {' '}{AGENT_NAMES[r.id] ?? r.id}
            {' '}<Text dimColor>{r.detail}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
