import { claudeCodeHandler } from './claude-code.js';
import { cursorHandler } from './cursor.js';
import { vscodeHandler } from './vscode.js';
import { geminiCliHandler } from './gemini-cli.js';
import { antigravityHandler } from './antigravity.js';

export type AgentSkillHandler = {
  id: string;
  displayName: string;
  supportsSkills: boolean;
  supportsCommands: boolean;
  detect(): boolean;
  installMcp(cmd: { command: string; args: string[] }): Promise<void>;
  installInstructions(): Promise<void>;
  installSkills?(): Promise<void>;
  installCommand?(): Promise<void>;
  uninstall(): Promise<{ removed: string[] }>;
};

export const agentHandlers: readonly AgentSkillHandler[] = [
  claudeCodeHandler,
  cursorHandler,
  vscodeHandler,
  geminiCliHandler,
  antigravityHandler,
];

const handlerMap = new Map<string, AgentSkillHandler>(
  agentHandlers.map((h) => [h.id, h]),
);

export function getAgentHandler(id: string): AgentSkillHandler | undefined {
  return handlerMap.get(id);
}

export function detectInstalledHandlers(): AgentSkillHandler[] {
  return agentHandlers.filter((h) => h.detect());
}
