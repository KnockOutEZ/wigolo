/**
 * The remote-debugging-port fence (S9 spec §6).
 *
 * The Studio main process holds the user's authenticated browsing profile. An open
 * remote-debugging port on that process is a full bypass of every consent gate in the agent
 * line: whoever reaches the port drives the browser directly, with the human's identity.
 *
 * The e2e suite genuinely needs the seam, so the variable is fenced rather than removed. The
 * discriminator is `app.isPackaged`, NOT an env var — a user or an MDM policy can set an env var
 * globally, while `isPackaged` is a property of the build and cannot be talked into changing.
 * The threat is a packaged app on a user's machine, and `isPackaged` is exactly that.
 *
 * Pure by design: the decision is data, so both branches are testable without an Electron
 * runtime. `applyCdpDebugPortFence` is the thin adapter that runs it against the real `app`.
 */

export interface CdpFenceInput {
  /** Raw `WIGOLO_STUDIO_CDP_PORT`. Unset and empty are both "absent". */
  readonly port: string | undefined;
  /** `app.isPackaged`. The only thing that decides whether the switch is honoured. */
  readonly isPackaged: boolean;
  /**
   * Accepted and deliberately unused. Present so that the intent is legible at the call site
   * and in tests: NODE_ENV is not, and must never become, part of this decision.
   */
  readonly nodeEnv?: string | undefined;
}

export interface CdpSwitch {
  readonly name: string;
  readonly value: string;
}

export interface CdpFenceDecision {
  /** Chromium command-line switches to append, in order. Empty means no debug port. */
  readonly switches: readonly CdpSwitch[];
  /** Startup warnings to write to stderr. At most one. */
  readonly warnings: readonly string[];
}

/** Bare integer in 1–65535. No padding, no hex, no trailing text: the value reaches a command line. */
function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : null;
}

export function decideCdpDebugPort(input: CdpFenceInput): CdpFenceDecision {
  const raw = input.port;
  if (!raw) return { switches: [], warnings: [] };

  // Packaged is checked BEFORE validity: on a packaged build the variable is ignored because of
  // the build, whatever it contains. Reporting a parse error here would imply that a well-formed
  // port would have been honoured.
  if (input.isPackaged) {
    return {
      switches: [],
      warnings: [
        `[studio] WIGOLO_STUDIO_CDP_PORT=${raw} was IGNORED: the browser engine's remote-debugging ` +
          `port is a development seam, and packaged builds never open it. No port is open.`,
      ],
    };
  }

  const port = parsePort(raw);
  if (port === null) {
    return {
      switches: [],
      warnings: [
        `[studio] WIGOLO_STUDIO_CDP_PORT=${raw} is not a valid port number (expected a plain ` +
          `integer 1-65535); ignoring it. No port is open.`,
      ],
    };
  }

  return {
    switches: [
      { name: 'remote-debugging-port', value: String(port) },
      // Loopback is Chromium's default today, but a default is not a guarantee across versions.
      // Pinned from a literal: nothing the caller supplies can move the bind off-box.
      { name: 'remote-debugging-address', value: '127.0.0.1' },
    ],
    warnings: [
      `[studio] SECURITY: the browser engine's remote-debugging port ${port} is OPEN on ` +
        `127.0.0.1. Anything that can reach it drives this browser directly and can read the ` +
        `signed-in profile it holds — cookies, sessions and saved logins — bypassing every ` +
        `approval gate. Development builds only; unset WIGOLO_STUDIO_CDP_PORT to close it.`,
    ],
  };
}

/** Minimal shapes of the Electron `app` and the stderr sink, so the adapter is testable too. */
export interface CdpFenceHost {
  readonly isPackaged: boolean;
  appendSwitch(name: string, value?: string): void;
}

export function applyCdpDebugPortFence(
  host: CdpFenceHost,
  env: { WIGOLO_STUDIO_CDP_PORT?: string | undefined; NODE_ENV?: string | undefined },
  warn: (line: string) => void,
): CdpFenceDecision {
  const decision = decideCdpDebugPort({
    port: env.WIGOLO_STUDIO_CDP_PORT,
    isPackaged: host.isPackaged,
    nodeEnv: env.NODE_ENV,
  });
  for (const s of decision.switches) host.appendSwitch(s.name, s.value);
  for (const w of decision.warnings) warn(`${w}\n`);
  return decision;
}
