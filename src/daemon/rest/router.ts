import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Subsystems } from '../../server.js';
import { createLogger } from '../../logger.js';
import { checkAuth, isLoopbackBind, type AuthContext } from './auth.js';
import {
  invalidJson,
  methodNotAllowed,
  notFound,
  bodyTooLarge,
  tooManyRequests,
  invalidInput,
  internalError,
  routeTimeout,
  unauthorized,
  forbidden,
  errorEnvelope,
  type HttpError,
} from './errors.js';
import {
  bodyCapFor,
  deadlineFor,
  maxConcurrency,
  findClampViolation,
  readJsonBodyCapped,
  BodyTooLargeError,
  ConcurrencySlots,
} from './limits.js';
import { validateInput } from './validate.js';
import { dispatchTool, type DispatchContext } from './dispatch.js';
import { buildOpenApi, buildToolsIndex } from './openapi.js';
import type { RunsStore } from './runs-store.js';
import {
  resolveUntrustedMode,
  UNTRUSTED_MODE_HEADER,
  UNTRUSTED_MODE_HEADER_NAME,
  type UntrustedMode,
} from './untrusted-mode.js';

const log = createLogger('rest');

const TOOLS = new Set([
  'search', 'fetch', 'crawl', 'cache', 'extract',
  'find_similar', 'research', 'agent', 'diff', 'watch',
]);

const SHIM_PREFIX = '/compat/firecrawl';

/**
 * Deadline the shim shares with the mapped native tool (D7/D11). scrape→fetch,
 * search→search, map→crawl; the crawl-START POST returns immediately (the
 * background crawl self-limits via runningCrawlJobs, NOT a router slot) and the
 * crawl-STATUS GET is a cheap store lookup — both get a SHORT deadline for the
 * request work itself. Any other/unknown subpath falls back to the short
 * deadline. `sub` is the path after the `/compat/firecrawl` prefix.
 */
const SHIM_SHORT_DEADLINE_MS = 15_000;
function shimTimeoutTool(sub: string): string | null {
  const s = sub.replace(/\/+$/, '') || '/';
  if (s === '/v1/scrape') return 'fetch';
  if (s === '/v1/search') return 'search';
  if (s === '/v1/map') return 'crawl';
  return null; // crawl-start, crawl-status, unknown → SHORT deadline
}

export interface RestRouterOptions {
  subsystems: Subsystems;
  bindHost: string;
  token: string | null;
  allowUnauthenticated: boolean;
  /**
   * The bound run store, for an owner that cannot open a native handle (the Electron main — SD1 §6 /
   * A-43-5). Absent on the daemon, which resolves its own.
   */
  runStore?: RunsStore;
}

export class RestRouter {
  private readonly slots: ConcurrencySlots;
  private readonly bindIsLoopback: boolean;

  constructor(private readonly opts: RestRouterOptions) {
    this.slots = new ConcurrencySlots(maxConcurrency());
    this.bindIsLoopback = isLoopbackBind(opts.bindHost);
  }

  /** Single write helper; guards against double-write on a settled response. */
  private respond(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private sendError(res: ServerResponse, e: HttpError): void {
    this.respond(res, e.status, e.body, e.headers);
  }

  private authContext(): AuthContext {
    return {
      token: this.opts.token,
      bindIsLoopback: this.bindIsLoopback,
      allowUnauthenticated: this.opts.allowUnauthenticated,
      bindHost: this.opts.bindHost,
    };
  }

  /**
   * Resolve the untrusted-content representation for one request (R2 / A10 + A11).
   *
   * The FALLBACK is the surface's default and is the only thing the two surfaces disagree about:
   * `/v1/{tool}` fences by default, `/compat/firecrawl/*` stays byte-clean by default. An
   * unrecognized header value is a 400 on BOTH surfaces — resolving it to the surface default would
   * silently hand a typo'd caller the representation they did not ask for.
   *
   * Returns null when the request was refused (the 400 is already written).
   */
  private untrustedModeFor(
    req: IncomingMessage,
    res: ServerResponse,
    fallback: UntrustedMode,
  ): UntrustedMode | null {
    const resolved = resolveUntrustedMode(req.headers[UNTRUSTED_MODE_HEADER], fallback);
    if (resolved.ok) return resolved.mode;
    this.respond(res, 400, errorEnvelope(
      'invalid_input',
      `Unsupported ${UNTRUSTED_MODE_HEADER_NAME} value ${JSON.stringify(resolved.value)}.`,
      { stage: 'validate', hint: resolved.hint },
    ));
    return null;
  }

  /** Run the shared auth gate; returns true when the request may proceed. */
  private passesAuth(req: IncomingMessage, res: ServerResponse): boolean {
    const result = checkAuth(this.authContext(), {
      hostHeader: req.headers.host,
      originHeader: req.headers.origin as string | undefined,
      authHeader: req.headers.authorization,
    });
    if (result.allow) return true;
    if (result.status === 401) {
      this.sendError(res, unauthorized(result.hint ?? 'Provide a valid bearer token.'));
    } else {
      this.sendError(res, forbidden(result.reason, result.hint ?? 'Request forbidden.'));
    }
    return false;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // Firecrawl-compat shim prefix — flag-gated. Auth applies identically.
      if (pathname === SHIM_PREFIX || pathname.startsWith(`${SHIM_PREFIX}/`)) {
        if (!this.passesAuth(req, res)) return;
        if (process.env.WIGOLO_FIRECRAWL_COMPAT !== '1') {
          this.sendError(res, notFound());
          return;
        }
        const subPath = pathname.slice(SHIM_PREFIX.length) || '/';
        // A11-R — the shim takes the SAME safe fallback as the native routes. No surface gets a
        // weaker default; the compat surface differs only in WHAT `inline` wraps (the markdown
        // string value, never the JSON shape). See the header of firecrawl-compat.ts.
        const compatMode = this.untrustedModeFor(req, res, 'inline');
        if (compatMode === null) return;
        // The shim shares the SAME slot+deadline discipline as /v1 (D7/D11) —
        // it is NOT an escape hatch. A slot is acquired before the compat work
        // and released only when it settles; a deadline (mapped tool for the
        // synchronous routes, short otherwise) yields a 504 while the slot is
        // held until the work settles.
        const mappedTool = shimTimeoutTool(subPath);
        const deadline = mappedTool ? deadlineFor(mappedTool) : SHIM_SHORT_DEADLINE_MS;
        await this.runUnderSlotAndDeadline(res, deadline, mappedTool ?? 'compat', async () => {
          const { handleCompatRequest } = await import('./firecrawl-compat.js');
          await handleCompatRequest(req, res, {
            subsystems: this.opts.subsystems,
            bindIsLoopback: this.bindIsLoopback,
            subPath,
            untrustedMode: compatMode,
            respond: (status, body, headers) => this.respond(res, status, body, headers),
          });
        });
        return;
      }

      // OpenAPI document (+ /v1 alias) — gated by auth (version disclosure).
      if (pathname === '/openapi.json' || pathname === '/v1/openapi.json') {
        if (method !== 'GET') {
          this.sendError(res, methodNotAllowed('GET'));
          return;
        }
        if (!this.passesAuth(req, res)) return;
        this.respond(res, 200, buildOpenApi());
        return;
      }

      // Tool discovery.
      if (pathname === '/v1/tools') {
        if (method !== 'GET') {
          this.sendError(res, methodNotAllowed('GET'));
          return;
        }
        if (!this.passesAuth(req, res)) return;
        this.respond(res, 200, buildToolsIndex());
        return;
      }

      // Run routes: /v1/runs, /v1/runs/{id}, /v1/runs/{id}/events (SD1 §5). These sit BEFORE tool
      // dispatch because that branch slices a flat single-segment tool name and would read
      // `runs/abcd` as an unknown tool. Auth is the same gate.
      //
      // Create/list/fetch take the SAME slot and deadline discipline as the tool routes — they are
      // ordinary request work and must not be an unbounded-in-flight escape hatch. The SSE tail is
      // the single exemption in the whole surface: a deadline would 504 a healthy stream and the
      // slot would be pinned for the life of the tail, so it is bounded by its own connection cap
      // instead (see runs.ts).
      if (pathname === '/v1/runs' || pathname.startsWith('/v1/runs/')) {
        if (!this.passesAuth(req, res)) return;
        const { handleRunsRequest, parseRunsPath, RUNS_ROUTE_LABEL } = await import('./runs.js');
        const runsOpts = {
          pathname,
          method,
          url,
          respond: (status: number, body: unknown, headers?: Record<string, string>) =>
            this.respond(res, status, body, headers),
          sendError: (e: HttpError) => this.sendError(res, e),
          ...(this.opts.runStore ? { store: this.opts.runStore } : {}),
        };
        if (parseRunsPath(pathname)?.kind === 'events') {
          await handleRunsRequest(req, res, runsOpts);
          return;
        }
        await this.runUnderSlotAndDeadline(res, deadlineFor(RUNS_ROUTE_LABEL), RUNS_ROUTE_LABEL, async () => {
          await handleRunsRequest(req, res, runsOpts);
        });
        return;
      }

      // Tool routes: /v1/{tool}.
      if (pathname.startsWith('/v1/')) {
        const tool = pathname.slice('/v1/'.length);
        if (!TOOLS.has(tool)) {
          this.sendError(res, notFound());
          return;
        }
        if (method !== 'POST') {
          this.sendError(res, methodNotAllowed('POST'));
          return;
        }
        // Auth BEFORE any body read — a stub route unauthed must 401/403, not 501.
        if (!this.passesAuth(req, res)) return;
        // A10 — native routes fence by default; `envelope` is the opt-in.
        const mode = this.untrustedModeFor(req, res, 'inline');
        if (mode === null) return;
        await this.handleToolRequest(tool, req, res, mode);
        return;
      }

      this.sendError(res, notFound());
    } catch (err) {
      log.error('REST request failed', { error: String(err) });
      this.sendError(res, internalError());
    }
  }

  /**
   * Run one unit of request work under the shared slot + deadline discipline
   * (D7). Acquires a concurrency slot BEFORE `work()` runs (→ 429 if the cap is
   * exhausted) and runs `work()` under a per-route `deadline` (→ 504
   * `route_timeout`). The slot is released ONLY when `work()` settles — never
   * when the 504 is written — so stranded work cannot accumulate past the cap.
   * A late settle/rejection after a 504 releases the slot and logs; the shared
   * `respond()` guards the double-write. `work(releaseSlot)` writes its own
   * success/failure response, and may call `releaseSlot` early to free the slot
   * on a pre-dispatch reject (e.g. a body-cap 413) before it resolves. Used by
   * both `/v1/{tool}` dispatch and the Firecrawl-compat shim so the two share
   * identical bounds (D11 — the shim is not an escape hatch).
   */
  private async runUnderSlotAndDeadline(
    res: ServerResponse,
    deadline: number,
    label: string,
    work: (releaseSlot: () => void) => Promise<void>,
  ): Promise<void> {
    if (!this.slots.tryAcquire()) {
      this.sendError(res, tooManyRequests());
      return;
    }
    let slotReleased = false;
    const releaseSlot = () => {
      if (!slotReleased) {
        slotReleased = true;
        this.slots.release();
      }
    };

    const workPromise = work(releaseSlot)
      .then(() => {
        releaseSlot();
      })
      .catch((err) => {
        releaseSlot();
        log.error('REST request work threw', { tool: label, error: String(err) });
        this.sendError(res, internalError());
      });

    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        // Deadline hit: respond 504 but keep the slot until the work settles.
        this.sendError(res, routeTimeout(label));
        resolve();
      }, deadline);
    });

    await Promise.race([workPromise.finally(() => clearTimeout(timer)), timeoutPromise]);
    // Detach so a late rejection cannot become an unhandled rejection.
    workPromise.catch(() => { /* already handled above */ });
  }

  private async handleToolRequest(
    tool: string,
    req: IncomingMessage,
    res: ServerResponse,
    untrustedMode: UntrustedMode,
  ): Promise<void> {
    await this.runUnderSlotAndDeadline(res, deadlineFor(tool), tool, async (releaseSlot) => {
      // Body cap read.
      let body: unknown;
      try {
        body = await readJsonBodyCapped(req, bodyCapFor(tool));
      } catch (err) {
        releaseSlot();
        if (err instanceof BodyTooLargeError) {
          this.sendError(res, bodyTooLarge(bodyCapFor(tool)));
        } else {
          this.sendError(res, invalidJson());
        }
        return;
      }

      // Schema validation.
      const valid = await validateInput(tool, body);
      if (!valid.ok) {
        releaseSlot();
        this.sendError(res, invalidInput(valid.detail));
        return;
      }

      // Param clamp enforcement (generic table comparison).
      const violation = findClampViolation(tool, body as Record<string, unknown>);
      if (violation) {
        releaseSlot();
        const unit = violation.kind === 'array' ? 'item count' : 'value';
        this.respond(res, 400, errorEnvelope(
          'invalid_input',
          `Field "${violation.field}" exceeds the serve-mode maximum ${unit}.`,
          {
            stage: 'validate',
            hint: `The "${violation.field}" ${unit} is capped at ${violation.max} in serve mode.`,
          },
        ));
        return;
      }

      // Dispatch — the slot is released when this settles (see helper).
      const ctx: DispatchContext = {
        subsystems: this.opts.subsystems,
        bindIsLoopback: this.bindIsLoopback,
        untrustedMode,
      };
      const result = await dispatchTool(tool, body, ctx);
      this.respond(res, result.status, result.body, result.headers ?? {});
    });
  }
}
