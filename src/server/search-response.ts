import type { SearchInput, SearchOutput, StreamAnswerEnvelope } from '../types.js';

// Build the MCP content blocks for the search tool. Both formats emit a single
// JSON text block; the synthesis `warning` is folded into the payload as a
// structured `notice` field instead of a separate "[wigolo notice] ..." text
// block, so callers can `JSON.parse(text)` and pull it out structurally.
//
// `format=stream_answer` additionally reshapes the payload to
// `{stream, notice?, ...rest}`; the default format keeps the SearchOutput
// shape with `warning` replaced by `notice`.
export function buildSearchContentBlocks(
  input: SearchInput,
  data: SearchOutput,
): { type: 'text'; text: string }[] {
  const { warning, ...rest } = data;
  // SearchOutput can already carry a `notice` (ultra-fast cache miss); keep it
  // alongside the warning rather than overwriting it.
  if (warning) rest.notice = rest.notice ? `${rest.notice} ${warning}` : warning;

  if (input.format === 'stream_answer') {
    const { answer, ...envelopeRest } = rest;
    const envelope: StreamAnswerEnvelope = {
      stream: answer ?? '',
      ...envelopeRest,
    };
    return [{ type: 'text', text: JSON.stringify(envelope, null, 2) }];
  }

  return [{ type: 'text', text: JSON.stringify(rest, null, 2) }];
}
