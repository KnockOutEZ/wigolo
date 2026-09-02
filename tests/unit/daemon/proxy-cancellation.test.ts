import { describe, expect, it } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DaemonProxy } from '../../../src/daemon/proxy.js';

class DelayedCancellationTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  closed = false;
  toolCallStarted = false;
  cancellationStarted = false;
  cancellationCompleted = false;
  private finishCancellation?: () => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if ('method' in message && message.method === 'initialize' && 'id' in message) {
      queueMicrotask(() => this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'delayed-cancel-host', version: '1.0.0' },
        },
      }));
      return;
    }
    if ('method' in message && message.method === 'tools/call') {
      this.toolCallStarted = true;
      return;
    }
    if ('method' in message && message.method === 'notifications/cancelled') {
      this.cancellationStarted = true;
      await new Promise<void>((resolve) => {
        this.finishCancellation = () => {
          this.cancellationCompleted = true;
          resolve();
        };
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }

  releaseCancellation(): void {
    this.finishCancellation?.();
  }
}

describe('DaemonProxy cancellation delivery', () => {
  it('keeps the transport open until an aborted call cancellation reaches the host', async () => {
    const transport = new DelayedCancellationTransport();
    const proxy = new DaemonProxy('http://unused.invalid', undefined, () => transport);
    const controller = new AbortController();

    const call = proxy.callTool('studio_act', { action: 'wait_for_human' }, { signal: controller.signal });
    await expect.poll(() => transport.toolCallStarted).toBe(true);

    controller.abort('client disconnected');
    await expect.poll(() => transport.cancellationStarted).toBe(true);
    expect(transport.closed).toBe(false);

    transport.releaseCancellation();
    await expect(call).rejects.toThrow();
    expect(transport.cancellationCompleted).toBe(true);
    expect(transport.closed).toBe(true);
  });
});
