import { claudeCodeHandler } from './claude-code.js';
import { cursorHandler } from './cursor.js';
import { vscodeHandler } from './vscode.js';
import { geminiCliHandler } from './gemini-cli.js';
import { zedHandler } from './zed.js';
import { windsurfHandler } from './windsurf.js';
import { codexHandler } from './codex.js';
import { antigravityHandler } from './antigravity.js';
import { opencodeHandler } from './opencode.js';
import { clineHandler } from './cline.js';

export type AgentSkillHandler = {
  id: string;
  displayName: string;
  supportsSkills: boolean;
  supportsCommands: boolean;
  supportsInstructions?: boolean;
  detect(): boolean;
  installMcp(cmd: { command: string; args: string[] }): Promise<void>;
  installInstructions(): Promise<void>;
  installSkills?(): Promise<void>;
  installCommand?(): Promise<void>;
  /**
   * Allow this agent to call wigolo's tools without a per-call prompt.
   * Only hosts with a writable allow-list implement it. Resolves true when it
   * changed something, false when the rule was already there.
   */
  installPermissions?(): Promise<boolean>;
  uninstall(): Promise<{ removed: string[] }>;
};

export const agentHandlers: readonly AgentSkillHandler[] = [
  claudeCodeHandler,
  cursorHandler,
  vscodeHandler,
  geminiCliHandler,
  zedHandler,
  windsurfHandler,
  codexHandler,
  antigravityHandler,
  opencodeHandler,
  clineHandler,
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
