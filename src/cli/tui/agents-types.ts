export type AgentId =
  | 'claude-code'
  | 'cursor'
  | 'vscode'
  | 'zed'
  | 'gemini-cli'
  | 'windsurf'
  | 'codex'
  | 'opencode';

export type InstallType = 'cli-command' | 'config-file' | 'config-toml';

export interface AgentDescriptor {
  id: AgentId;
  displayName: string;
  installType: InstallType;
  /** Returns true when wigolo can plausibly install into this agent on this machine. */
  detect(opts: { cwd: string; home: string }): boolean;
  /**
   * Returns the path wigolo will write its MCP config to (or read from for status).
   * Returns null for cli-command agents (Claude Code).
   */
  configPath(opts: { cwd: string; home: string }): string | null;
}

export interface DetectedAgent {
  id: AgentId;
  displayName: string;
  detected: boolean;
  configPath: string | null;
  installType: InstallType;
}
