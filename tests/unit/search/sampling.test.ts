import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkSamplingSupport,
  requestSampling,
  extractTextFromSamplingResponse,
} from '../../../src/search/sampling.js';

function createMockServer(opts: {
  samplingSupported?: boolean;
  samplingResponse?: { model: string; content: { type: string; text: string } };
  samplingError?: Error;
} = {}) {
  const server = {
    getClientCapabilities: vi.fn().mockReturnValue(
      opts.samplingSupported !== false
        ? { sampling: {} }
        : {},
    ),
    createMessage: opts.samplingError
      ? vi.fn().mockRejectedValue(opts.samplingError)
      : vi.fn().mockResolvedValue(
          opts.samplingResponse ?? {
            model: 'test-model',
            content: { type: 'text', text: 'This is a synthesized answer.' },
          },
        ),
  };
  return server;
}

describe('checkSamplingSupport', () => {
  it('returns true when client supports sampling', () => {
    const server = createMockServer({ samplingSupported: true });
    expect(checkSamplingSupport(server)).toBe(true);
  });

  it('returns false when client does not support sampling', () => {
    const server = createMockServer({ samplingSupported: false });
    expect(checkSamplingSupport(server)).toBe(false);
  });

  it('returns false when getClientCapabilities returns null', () => {
    const server = { getClientCapabilities: vi.fn().mockReturnValue(null) };
    expect(checkSamplingSupport(server)).toBe(false);
  });

  it('returns false when getClientCapabilities returns undefined', () => {
    const server = { getClientCapabilities: vi.fn().mockReturnValue(undefined) };
    expect(checkSamplingSupport(server)).toBe(false);
  });

  it('returns false when getClientCapabilities throws', () => {
    const server = {
      getClientCapabilities: vi.fn().mockImplementation(() => {
        throw new Error('not connected');
      }),
    };
    expect(checkSamplingSupport(server)).toBe(false);
  });

  it('returns false when sampling is explicitly undefined in capabilities', () => {
    const server = {
      getClientCapabilities: vi.fn().mockReturnValue({ tools: {} }),
    };
    expect(checkSamplingSupport(server)).toBe(false);
  });
});

describe('requestSampling', () => {
  it('calls server.createMessage with correct parameters', async () => {
    const server = createMockServer({ samplingSupported: true });
    const messages = [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: 'Summarize these results.' },
      },
    ];

    const response = await requestSampling(server, messages, 1500);

    expect(server.createMessage).toHaveBeenCalledWith({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'Summarize these results.' },
        },
      ],
      maxTokens: 1500,
    });
    expect(response).toBeDefined();
  });

  it('returns the sampling response on success', async () => {
    const server = createMockServer({
      samplingSupported: true,
      samplingResponse: {
        model: 'claude-3.5',
        content: { type: 'text', text: 'Here is the answer.' },
      },
    });

    const response = await requestSampling(
      server,
      [{ role: 'user', content: { type: 'text', text: 'test' } }],
      1500,
    );

    expect(response.content.text).toBe('Here is the answer.');
  });

  it('throws when sampling is not supported', async () => {
    const server = createMockServer({ samplingSupported: false });

    await expect(
      requestSampling(
        server,
        [{ role: 'user', content: { type: 'text', text: 'test' } }],
        1500,
      ),
    ).rejects.toThrow('sampling');
  });

  it('propagates server errors', async () => {
    const server = createMockServer({
      samplingSupported: true,
      samplingError: new Error('rate limited'),
    });

    await expect(
      requestSampling(
        server,
        [{ role: 'user', content: { type: 'text', text: 'test' } }],
        1500,
      ),
    ).rejects.toThrow('rate limited');
  });

  it('passes maxTokens correctly', async () => {
    const server = createMockServer({ samplingSupported: true });

    await requestSampling(
      server,
      [{ role: 'user', content: { type: 'text', text: 'test' } }],
      2000,
    );

    expect(server.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 2000 }),
    );
  });

  it('handles empty messages array', async () => {
    const server = createMockServer({ samplingSupported: true });

    await requestSampling(server, [], 1500);

    expect(server.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [] }),
    );
  });
});

describe('extractTextFromSamplingResponse', () => {
  it('extracts text from a valid response', () => {
    const response = {
      model: 'test-model',
      content: { type: 'text', text: 'The synthesized answer.' },
    };
    expect(extractTextFromSamplingResponse(response)).toBe('The synthesized answer.');
  });

  it('returns empty string for missing content', () => {
    const response = { model: 'test-model', content: null };
    expect(extractTextFromSamplingResponse(response)).toBe('');
  });

  it('returns empty string for missing text field', () => {
    const response = {
      model: 'test-model',
      content: { type: 'image', data: 'base64...' },
    };
    expect(extractTextFromSamplingResponse(response)).toBe('');
  });

  it('returns empty string for null response', () => {
    expect(extractTextFromSamplingResponse(null)).toBe('');
  });

  it('returns empty string for undefined response', () => {
    expect(extractTextFromSamplingResponse(undefined)).toBe('');
  });

  it('trims whitespace from extracted text', () => {
    const response = {
      model: 'test-model',
      content: { type: 'text', text: '  Answer with spaces  \n\n' },
    };
    expect(extractTextFromSamplingResponse(response)).toBe('Answer with spaces');
  });

  it('handles response with empty text', () => {
    const response = {
      model: 'test-model',
      content: { type: 'text', text: '' },
    };
    expect(extractTextFromSamplingResponse(response)).toBe('');
  });
});
