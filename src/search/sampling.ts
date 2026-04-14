import { createLogger } from '../logger.js';

const log = createLogger('search');

export interface SamplingMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface SamplingResponse {
  model: string;
  content: { type: string; text: string };
}

export interface SamplingCapableServer {
  getClientCapabilities: () => Record<string, unknown> | null | undefined;
  createMessage: (params: {
    messages: SamplingMessage[];
    maxTokens: number;
  }) => Promise<SamplingResponse>;
}

export function checkSamplingSupport(server: SamplingCapableServer): boolean {
  try {
    const capabilities = server.getClientCapabilities();
    if (!capabilities) return false;
    return capabilities.sampling !== undefined;
  } catch (err) {
    log.debug('sampling support check failed', { error: String(err) });
    return false;
  }
}

export async function requestSampling(
  server: SamplingCapableServer,
  messages: SamplingMessage[],
  maxTokens: number,
): Promise<SamplingResponse> {
  if (!checkSamplingSupport(server)) {
    throw new Error('Client does not support MCP sampling');
  }

  log.debug('sending sampling request', {
    messageCount: messages.length,
    maxTokens,
  });

  const response = await server.createMessage({
    messages,
    maxTokens,
  });

  log.debug('sampling response received', {
    model: response?.model,
    contentType: response?.content?.type,
    textLength: response?.content?.text?.length ?? 0,
  });

  return response;
}

export function extractTextFromSamplingResponse(
  response: unknown,
): string {
  try {
    if (!response || typeof response !== 'object') return '';

    const resp = response as Record<string, unknown>;
    const content = resp.content as Record<string, unknown> | null | undefined;
    if (!content) return '';

    if (content.type === 'text' && typeof content.text === 'string') {
      return content.text.trim();
    }

    return '';
  } catch (err) {
    log.debug('failed to extract text from sampling response', { error: String(err) });
    return '';
  }
}
