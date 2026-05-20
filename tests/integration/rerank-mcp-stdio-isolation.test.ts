import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const skip = !process.env.WIGOLO_RERANKER_TEST;

const MCP_FRAME_RE = /^Content-Length: \d+\r\n\r\n\{/m;

describe.skipIf(skip)('integration: MCP stdio framing is not contaminated by rerank subprocess stderr', () => {
  it('search → rerank does not leak reranker_server.py stderr to MCP stdout', async () => {
    const cliEntry = join(process.cwd(), 'dist', 'index.js');
    const child = spawn('node', [cliEntry, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WIGOLO_RERANKER: 'onnx' },
    });

    let stdoutBuf = '';
    child.stdout.on('data', (d) => (stdoutBuf += d.toString()));

    const send = (msg: object) => {
      const json = JSON.stringify(msg);
      child.stdin.write(`Content-Length: ${json.length}\r\n\r\n${json}`);
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    } });

    await new Promise((r) => setTimeout(r, 2000));
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'search', arguments: { query: 'react server components' } } });

    await new Promise((r) => setTimeout(r, 8000));
    child.kill();

    expect(stdoutBuf).not.toMatch(/READY model=/);
    expect(stdoutBuf).not.toMatch(/^ERROR /m);
    expect(stdoutBuf).toMatch(MCP_FRAME_RE);
  }, 30_000);
});
