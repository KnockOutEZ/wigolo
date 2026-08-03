/**
 * S9 §8 — the UA / client-hints identity the browser substrate presents.
 *
 * THE LANE IS "CLAIM WHAT THE BUILD ACTUALLY IS". The engine underneath is Chromium 150, so 150 is
 * what every surface claims. Nothing here invents a version, a vendor, or a capability. The phase-1
 * spike measured that claiming 150 costs nothing on any probe surface, so there is no reason to claim
 * anything else and every reason not to: a claimed major the API surface does not match is precisely
 * the cross-property contradiction 2026 detectors are built to score.
 *
 * What it therefore removes is only what the substrate is NOT:
 *   - the `Electron/<v>` token, which no browser sends;
 *   - the embedding app's own `<name>/<version>` token, same reason;
 *   - the unreduced build number in the UA *string* — real Chrome reduces that to `<major>.0.0.0`
 *     while still reporting its true build in the high-entropy metadata, so both are honest here.
 *
 * THE ONE MECHANISM THAT WORKS. The spike measured `session.setUserAgent`,
 * `webContents.setUserAgent`, the `--user-agent` switch and a `webRequest` rewrite: all four move the
 * UA *string* only, leaving `userAgentData.brands` and `Sec-CH-UA` behind at the native value. A
 * half-moved identity is a contradiction, so only `Emulation.setUserAgentOverride` (which moves all
 * four surfaces together) is used for driven tabs.
 *
 * WHY BOTH TAB CLASSES ARE DONE TOGETHER, and this is the load-bearing part: a Studio window drives
 * agent tabs and hosts the human's own omnibox tabs out of one process, one cookie jar and one IP.
 * If only driven tabs carried the override, that window would present two identities to the same
 * sites — the agent's tabs claiming plain Chrome, the human's carrying the Electron token. A detector
 * correlating UA against a stable cookie sees an identity that changes between requests, which is a
 * far sharper signal than the token we removed. So the string is set process-wide via
 * `app.userAgentFallback` (which every session inherits) and the driven-tab override is built from
 * the SAME identity value, never a second computation.
 */

/** Brand entry as both `userAgentData.brands` and CDP's `userAgentMetadata` express it. */
export interface UaBrand {
  readonly brand: string;
  readonly version: string;
}

/**
 * The host's own high-entropy hints, read from the tab BEFORE the override is applied.
 *
 * These are passed through untouched. They describe the real machine — OS version, CPU
 * architecture, bitness — and the substrate has no business restating them from Node's own view of
 * the host when the engine has already computed them. Reading beats deriving: a derived
 * `platformVersion` that disagrees with what the engine would have said is a self-inflicted tell.
 */
export interface HostHints {
  readonly platform: string;
  readonly platformVersion: string;
  readonly architecture: string;
  readonly bitness: string;
  readonly model: string;
  readonly mobile: boolean;
}

export interface UaIdentity {
  /** The UA string every surface presents — driven tabs, human tabs and the app shell alike. */
  readonly userAgent: string;
  /** The claimed Chrome major. Always the engine's own major; there is no lane in which it is not. */
  readonly major: string;
  /** The true build (`process.versions.chrome`), reported in the high-entropy metadata. */
  readonly fullVersion: string;
  /** Exactly the brands the engine natively presents, at the engine's own major. */
  readonly brands: readonly UaBrand[];
  /** Same brand set carrying the true build, as `Sec-CH-UA-Full-Version-List` expresses it. */
  readonly fullVersionList: readonly UaBrand[];
}

export interface UaIdentityInput {
  /** Electron's native UA string (`app.userAgentFallback` / `session.getUserAgent()`). */
  readonly nativeUserAgent: string;
  /** `process.versions.chrome` — the build the engine actually is. */
  readonly chromeVersion: string;
  /** Fallback platform when the native UA carries no platform token. */
  readonly platform: NodeJS.Platform;
}

/**
 * The `Not;A=Brand` GREASE entry. Its version is deliberately taken from the engine's own native
 * brand list (Chromium 150 presents `8`) rather than invented: the GREASE brand exists to catch
 * clients that parse the list rigidly, and picking a value the engine would not emit is exactly the
 * kind of near-miss that stands out.
 */
const GREASE_BRAND = 'Not;A=Brand';
const GREASE_VERSION = '8';

/**
 * Platform token of last resort, used only if the native UA string is unparseable. Chrome freezes
 * these strings by design (the UA-reduction spec), so they do not rot with OS releases.
 */
function fallbackPlatformToken(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7';
  if (platform === 'win32') return 'Windows NT 10.0; Win64; x64';
  return 'X11; Linux x86_64';
}

/** Major version component of a `150.0.7871.46`-shaped build string. */
function majorOf(version: string): string {
  const m = /^(\d+)/.exec(version);
  return m ? m[1]! : '';
}

/**
 * Build the presented identity.
 *
 * The UA string is REBUILT from the native string's platform token rather than edited in place.
 * Editing would mean enumerating every token Electron might add — the app name, the Electron token,
 * anything an embedder appends — and a missed one ships a tell. Rebuilding can only produce the
 * canonical Chrome shape, and the single value it carries over from the native string (the platform
 * token) is the one part it must not guess.
 */
export function studioUaIdentity(input: UaIdentityInput): UaIdentity {
  const major = majorOf(input.chromeVersion);
  if (!major) throw new Error(`unusable Chrome version for UA identity: ${JSON.stringify(input.chromeVersion)}`);

  const platformToken =
    /^Mozilla\/5\.0 \(([^)]*)\)/.exec(input.nativeUserAgent)?.[1] ?? fallbackPlatformToken(input.platform);

  return {
    userAgent: `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    major,
    fullVersion: input.chromeVersion,
    // TWO brands, matching what the engine natively presents. A third `Google Chrome` entry is a
    // PRODUCT claim rather than a version claim, and this substrate is not that product — adding it
    // would also break the equality this module exists to hold, since human tabs keep the native
    // two-brand list and no mechanism moves theirs.
    brands: [
      { brand: GREASE_BRAND, version: GREASE_VERSION },
      { brand: 'Chromium', version: major },
    ],
    // The TRUE build, not a synthetic `<major>.0.0`. Real Chrome reports its real build here while
    // reducing the UA string, so this is the honest field and a rounded value is a free tell.
    fullVersionList: [
      { brand: GREASE_BRAND, version: `${GREASE_VERSION}.0.0.0` },
      { brand: 'Chromium', version: input.chromeVersion },
    ],
  };
}

/** Params for `Emulation.setUserAgentOverride`. Shaped exactly as CDP expects them. */
export interface UaOverrideParams {
  readonly userAgent: string;
  readonly userAgentMetadata: {
    readonly brands: readonly UaBrand[];
    readonly fullVersionList: readonly UaBrand[];
    readonly fullVersion: string;
    readonly platform: string;
    readonly platformVersion: string;
    readonly architecture: string;
    readonly model: string;
    readonly mobile: boolean;
    readonly bitness: string;
  };
}

/**
 * Compose the CDP override from the identity plus the host's own hints.
 *
 * CDP requires `platform`, `platformVersion`, `architecture`, `model` and `mobile` — there is no
 * partial override — so when the read-through fails these fall back to the engine-independent
 * minimum: the platform name, and empty strings for the fields only the engine can know. Empty is
 * chosen over a guess on purpose: a site that requests high-entropy hints and gets `""` learns
 * nothing, whereas one that gets a fabricated OS version can compare it against anything else it
 * can see.
 */
export function uaOverrideParams(identity: UaIdentity, hints: HostHints | null, platform: NodeJS.Platform): UaOverrideParams {
  const uaPlatform = hints?.platform || uaPlatformName(platform);
  return {
    // The SAME string the process-wide fallback presents — not a second derivation.
    userAgent: identity.userAgent,
    userAgentMetadata: {
      brands: identity.brands,
      fullVersionList: identity.fullVersionList,
      fullVersion: identity.fullVersion,
      platform: uaPlatform,
      platformVersion: hints?.platformVersion ?? '',
      architecture: hints?.architecture ?? '',
      model: hints?.model ?? '',
      mobile: hints?.mobile ?? false,
      bitness: hints?.bitness ?? '',
    },
  };
}

/** Client-hint spelling of the platform (`macOS`, not `darwin`). */
export function uaPlatformName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return 'Linux';
}

/**
 * The expression that reads the host's own hints. Kept here so the shape and its reader agree.
 *
 * IT MUST BE EVALUATED IN A SECURE CONTEXT WITH A REAL ORIGIN. Measured: on `about:blank` in an
 * in-memory partition `navigator.userAgentData` is `undefined`, so reading it there always fails —
 * which is what the first version of this module did, on every tab, silently omitting the hints it
 * was written to preserve. The app shell (`file://` or the dev server) is a secure context, so the
 * read is done ONCE against the shell and shared. That is also the more correct shape: these values
 * describe the machine, not the tab.
 */
export const HOST_HINTS_EXPR = `navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(['platform','platformVersion','architecture','bitness','model']) : null`;

/**
 * Resolve the host's hints once, from a secure context. Bounded and fail-soft: hints are a quality
 * improvement to what the override sends, never a precondition for sending it.
 */
export async function resolveHostHints(
  read: () => Promise<unknown>,
  opts: { timeoutMs?: number; warn?: (line: string) => void } = {},
): Promise<HostHints | null> {
  try {
    const hints = parseHostHints(await withTimeout(read(), opts.timeoutMs ?? 5000, 'client-hint read'));
    if (!hints) opts.warn?.('[studio] this host reported no client hints; high-entropy hints will be omitted\n');
    return hints;
  } catch (err) {
    opts.warn?.(`[studio] could not read this host's client hints (${err instanceof Error ? err.message : String(err)}); high-entropy hints will be omitted\n`);
    return null;
  }
}

/**
 * Bound an await that must never wedge session creation.
 *
 * This exists because of a measured class of hang, not a hypothetical one: CDP `Emulation` commands
 * against a webContents in the wrong state do not reject, they never settle — the phase-1 spike lost a
 * whole run to one. Identity application is not a fence, so anything here that cannot finish must
 * degrade to the substrate's own identity rather than hold a session open forever.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not complete within ${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Narrow an unknown `getHighEntropyValues` result to `HostHints`, or null if it is not one. */
export function parseHostHints(raw: unknown): HostHints | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const platform = str(r.platform);
  const platformVersion = str(r.platformVersion);
  if (platform === null || platformVersion === null) return null;
  return {
    platform,
    platformVersion,
    architecture: str(r.architecture) ?? '',
    bitness: str(r.bitness) ?? '',
    model: str(r.model) ?? '',
    mobile: r.mobile === true,
  };
}

export interface ApplyUaIdentityDeps {
  readonly identity: UaIdentity;
  readonly platform: NodeJS.Platform;
  /** The host's hints, resolved ONCE by the caller from a secure context. Null ⇒ omitted. */
  readonly hints: HostHints | null;
  /** Load `about:blank`. MUST resolve before the override is sent — see the ordering note below. */
  readonly loadBlank: () => Promise<void>;
  /** Send a CDP command on this tab's already-attached debugger. */
  readonly sendCdp: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Loud, operator-visible warning (stderr — never stdout). */
  readonly warn: (line: string) => void;
  /** Per-step bound. Nothing here may hold a session open; 5s is generous for two local CDP round-trips. */
  readonly timeoutMs?: number;
}

/**
 * Apply the identity to one driven tab.
 *
 * ORDERING IS NOT A STYLE CHOICE. An `Emulation` command issued against a `webContents` that has
 * never navigated NEVER RESOLVES — measured in the phase-1 spike, where it hung both CDP arms and
 * cost a full run before the watchdog caught it. So `about:blank` is loaded and awaited first, and
 * this must never be folded into the tab's CDP attach step, which runs before any navigation.
 *
 * FAILS OPEN, LOUDLY. If the override cannot be applied the tab presents the substrate's native
 * identity — worse for anti-bot, but no weaker as a security posture, since nothing here is a fence.
 * Refusing the session instead would trade a legitimacy regression for an outage.
 */
export async function applyUaIdentityToTab(deps: ApplyUaIdentityDeps): Promise<boolean> {
  const ms = deps.timeoutMs ?? 5000;
  try {
    await withTimeout(deps.loadBlank(), ms, 'blank-page load');
    await withTimeout(
      deps.sendCdp('Emulation.setUserAgentOverride', {
        ...uaOverrideParams(deps.identity, deps.hints, deps.platform),
      } as unknown as Record<string, unknown>),
      ms,
      'identity override',
    );
    return true;
  } catch (err) {
    deps.warn(
      `[studio] browser identity override failed; this tab presents the substrate's own identity: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return false;
  }
}
