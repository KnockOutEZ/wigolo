/**
 * MCP subprocess client for communicating with wigolo.
 * Spawns npx @staticn0va/wigolo, sends JSON-RPC 2.0 over stdin/stdout.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { WigoloClientOptions, JsonRpcRequest, JsonRpcNotification } from './types.js';

export class WigoloClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WigoloClientError';
  }
}

export class WigoloMcpClient {
  readonly command: string;
  readonly args: string[];
  readonly timeoutMs: number;
  readonly env: Record<string, string> | undefined;

  private process: ChildProcess | null = null;
  private requestId = 0;
  private connected = false;
  private responseResolvers = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (reason: Error) => void;
  }>();

  constructor(options?: WigoloClientOptions) {
    this.command = options?.command ?? 'npx';
    this.args = options?.args ?? ['@staticn0va/wigolo'];
    this.timeoutMs = options?.timeoutMs ?? 30000;
    this.env = options?.env;
  }

  get isConnected(): boolean {
    return this.connected && this.process !== null;
  }

  private nextId(): number {
    return ++this.requestId;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      this.process = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env ?? process.env,
      });
    } catch (err) {
      throw new WigoloClientError(
        `failed to spawn subprocess: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!this.process.stdout || !this.process.stdin) {
      throw new WigoloClientError('subprocess stdio not available');
    }

    const rl = createInterface({ input: this.process.stdout });
    rl.on('line', (line: string) => {
      this.handleLine(line);
    });

    if (this.process.stderr) {
      this.process.stderr.on('data', () => {});
    }

    this.process.on('exit', () => {
      this.connected = false;
      for (const [id, resolver] of this.responseResolvers) {
        resolver.reject(new WigoloClientError('subprocess exited unexpectedly'));
        this.responseResolvers.delete(id);
      }
    });

    try {
      await this.sendRequest('initialize', {
        protocolVersion: '2025-03-26',
        clientInfo: { name: 'wigolo-ai-sdk', version: '0.1.0' },
        capabilities: {},
      });

      this.sendNotification('notifications/initialized', {});
      this.connected = true;
    } catch (err) {
      this.killProcess();
      throw new WigoloClientError(
        `failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async disconnect(): Promise<void> {
    if (!this.process) return;

    this.connected = false;
    try {
      this.process.kill('SIGTERM');
    } catch {
      // Process may already be dead
    }
    this.process = null;
    this.responseResolvers.clear();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    if (!this.isConnected) {
      throw new WigoloClientError('not connected — call connect() first');
    }

    try {
      const response = await this.sendRequest('tools/call', {
        name,
        arguments: args,
      });

      return this.parseToolResponse(response);
    } catch (err) {
      if (err instanceof WigoloClientError) throw err;
      throw new WigoloClientError(
        `error calling tool '${name}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new WigoloClientError('stdin not available'));
        return;
      }

      const id = this.nextId();
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.responseResolvers.delete(id);
        reject(new WigoloClientError(`timeout waiting for response to ${method}`));
      }, this.timeoutMs);

      this.responseResolvers.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          this.responseResolvers.delete(id);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.responseResolvers.delete(id);
          reject(err);
        },
      });

      const msg = JSON.stringify(request) + '\n';
      this.process.stdin.write(msg);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin) return;

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!('id' in msg) || msg.id === undefined) return;

    const id = msg.id as number;
    const resolver = this.responseResolvers.get(id);
    if (!resolver) return;

    if (msg.error) {
      const err = msg.error as { code?: number; message?: string };
      resolver.reject(
        new WigoloClientError(`MCP error ${err.code ?? 'unknown'}: ${err.message ?? 'unknown'}`),
      );
    } else {
      resolver.resolve((msg.result ?? {}) as Record<string, unknown>);
    }
  }

  private parseToolResponse(result: Record<string, unknown>): Record<string, any> {
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    if (!content || content.length === 0) return {};

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        try {
          return JSON.parse(block.text);
        } catch {
          return { raw_text: block.text };
        }
      }
    }

    return {};
  }

  private killProcess(): void {
    if (this.process) {
      try {
        this.process.kill('SIGKILL');
      } catch {
        // Already dead
      }
      this.process = null;
    }
  }
}
