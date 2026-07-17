export const KNOWN_AGENT_IDS: readonly string[] = [
  'claude-code',
  'cursor',
  'vscode',
  'zed',
  'gemini-cli',
  'windsurf',
  'codex',
  'opencode',
  'antigravity',
];

export interface InitFlags {
  nonInteractive: boolean;
  agents: readonly string[];
  skipVerify: boolean;
  plain: boolean;
  help: boolean;
  /** Opt into the Ink wizard. Default init is the plain path on TTY and non-TTY alike. */
  wizard: boolean;
  /**
   * Whether init pre-caches every component (`runWarmup(['--all'])`). Defaults
   * to TRUE: a manual init is a complete, diagnosable setup. `--no-warmup` sets
   * it false — the download-nothing escape hatch (components lazy-load on first
   * use). `--warmup` is accepted as an explicit-on alias for back-compat.
   */
  warmup: boolean;
  /** Emit a machine-readable JSON summary on stdout instead of the human report. */
  json: boolean;
  provider?: string;
  search?: string;
}

export interface SetupMcpFlags {
  nonInteractive: boolean;
  agents: readonly string[];
  plain: boolean;
  help: boolean;
  /** Emit a machine-readable JSON summary on stdout instead of the human report. */
  json: boolean;
}

export class FlagParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FlagParseError';
    this.code = code;
  }
}
