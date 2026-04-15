export const KNOWN_AGENT_IDS: readonly string[] = [
  'claude-code',
  'cursor',
  'vscode',
  'zed',
  'gemini-cli',
  'windsurf',
  'codex',
  'opencode',
];

export interface InitFlags {
  nonInteractive: boolean;
  agents: readonly string[];
  skipVerify: boolean;
  plain: boolean;
  help: boolean;
}

export interface SetupMcpFlags {
  nonInteractive: boolean;
  agents: readonly string[];
  plain: boolean;
  help: boolean;
}

export class FlagParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FlagParseError';
    this.code = code;
  }
}
