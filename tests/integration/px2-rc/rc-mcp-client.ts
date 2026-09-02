/**
 * PX2 RC exit gate — a minimal MCP stdio client against the installed binary.
 *
 * WHY THE TEN TOOLS RUN OVER MCP AND NOT OVER THE ONE-SHOT CLI. The CLI's
 * one-shot runner is searxng-free BY CONSTRUCTION — `src/cli/tool-run.ts` says
 * so in as many words and seeds the keyless direct engines instead, so
 * `SEARXNG_URL` is not consulted on that path and `search`, `research`, `agent`
 * and `find_similar` would reach real engines on the internet. That is
 * incompatible with the gate's own claim of being deterministic and offline for
 * the measured arms, so the search family cannot be proven there. The MCP server
 * does consult it (`src/server.ts` bootstraps the sidecar from
 * `searxngConfigured`), and it is also where the activation check actually sits
 * for both transports (A-212-2) — so driving the protocol exercises the gate at
 * its primary seam AND keeps every request local. The CLI surface is still
 * covered: the refusal arm and the fetch-family smoke run through it.
 *
 * WHY THIS CLIENT IS HAND-ROLLED. The SDK's client would be the obvious import,
 * but the point of this arm is to speak to the binary a user installed the way
 * any harness would — over a pipe, with framed JSON-RPC — and a hand-rolled
 * reader is what makes a refusal observable as a RESPONSE rather than as a
 * thrown SDK error with the text buried in it.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { stopChild } from './rc-accounts-service.js';
import type { FreshInstall } from './rc-install.js';

/** The ten tools the gate has to run. Ordered so `cache` reports on the rest. */
export const TEN_TOOLS = [
  'fetch',
  'crawl',
  'extract',
  'diff',
  'watch',
  'search',
  'find_similar',
  'research',
  'agent',
  'cache',
] as const;

export type ToolName = (typeof TEN_TOOLS)[number];

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface ToolCallOutcome {
  /** The tool result's text content, joined — what a terminal user would read. */
  text: string;
  /** MCP-level tool error flag: a refusal arrives here, not as a transport error. */
  isError: boolean;
  raw: unknown;
}

export interface McpSession {
  call(tool: ToolName | string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  listTools(): Promise<string[]>;
  stderr(): string;
  stop(): Promise<void>;
}

/**
 * Start the installed binary in MCP stdio mode and complete the handshake.
 *
 * Bare `wigolo` IS the MCP server (A-212-1 classifies it as `mcp`), so no
 * subcommand is passed. The server serves the protocol even when the install is
 * unregistered and refuses per tool call — which is the behaviour the refusal arm
 * asserts, and the reason this function does not treat a successful handshake as
 * evidence of activation.
 */
export async function startMcpSession(
  install: FreshInstall,
  env: Record<string, string>,
): Promise<McpSession> {
  const child = spawn(install.bin, [], {
    cwd: install.root,
    env: {
      ...process.env,
      HOME: install.home,
      WIGOLO_ACCOUNTS_URL: undefined,
      WIGOLO_ACCOUNTS_PUBKEY: undefined,
      ...env,
    } as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    // Newline-delimited JSON: the stdio transport writes one message per line.
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.length === 0) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof message.id === 'number') {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });

  let nextId = 1;
  const request = async (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> => {
    const id = nextId++;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

    const answered = new Promise<JsonRpcResponse>((resolveResponse, reject) => {
      pending.set(id, resolveResponse);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms; stderr:\n${stderr}`));
      }, timeoutMs);
      const settle = (response: JsonRpcResponse): void => {
        clearTimeout(timer);
        resolveResponse(response);
      };
      pending.set(id, settle);
    });

    child.stdin.write(payload);
    return answered;
  };

  const initialized = await request(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'px2-rc-exit-gate', version: '1.0.0' },
    },
    120_000,
  );
  if (initialized.error !== undefined) {
    await stopChild(child);
    throw new Error(`MCP initialize failed: ${initialized.error.message}\n${stderr}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    call: async (tool, args) => {
      const response = await request('tools/call', { name: tool, arguments: args }, 240_000);
      if (response.error !== undefined) {
        // A transport-level error is not a refusal; surface it as one string so a
        // failing assertion names what actually happened.
        return { text: response.error.message, isError: true, raw: response.error };
      }
      const result = response.result as
        | { content?: { type: string; text?: string }[]; isError?: boolean }
        | undefined;
      const text = (result?.content ?? [])
        .map((part) => part.text ?? '')
        .join('\n')
        .trim();
      return { text, isError: result?.isError === true, raw: response.result };
    },
    listTools: async () => {
      const response = await request('tools/list', {}, 120_000);
      const result = response.result as { tools?: { name: string }[] } | undefined;
      return (result?.tools ?? []).map((tool) => tool.name);
    },
    stderr: () => stderr,
    stop: () => stopChild(child as ChildProcess),
  };
}
