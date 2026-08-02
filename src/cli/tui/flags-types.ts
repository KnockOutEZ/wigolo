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
  /**
   * Accepted but a NO-OP: unattended is the default now. Kept so existing
   * scripts and the published `--non-interactive --agents=X` command keep
   * working unchanged. Never gates prompting — the default never prompts.
   */
  nonInteractive: boolean;
  agents: readonly string[];
  skipVerify: boolean;
  plain: boolean;
  help: boolean;
  /**
   * Opt into the plain-text prompt flow (the agent-picker prompt + optional
   * onboarding questions). One of the two interactive modes; distinct from the
   * rich Ink wizard. Default init is unattended (no prompts); --interactive
   * needs a real terminal and errors on a non-TTY rather than silently
   * falling back.
   */
  interactive: boolean;
  /**
   * Opt into the rich guided Ink TUI wizard. The other interactive mode,
   * distinct from --interactive's plain-text prompts. Needs a real terminal
   * and errors on a non-TTY rather than silently falling back.
   */
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
