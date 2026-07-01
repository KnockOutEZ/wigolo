import type { SearchInput, SearchOutput, StreamAnswerEnvelope } from '../types.js';

// Build the MCP content blocks for the search tool. The default shape keeps
// the legacy "[wigolo notice] ..." text prefix block + a JSON payload block,
// so existing callers keep their parsing.
//
// `format=stream_answer` used to emit the warning
// out as a raw text block alongside the JSON, leaving callers without a
// reliable way to pattern-match `notice` vs body. Now stream_answer collapses
// to a single JSON block shaped `{stream, notice?, ...rest}` so callers can
// `JSON.parse(text)` and pull either field structurally.
export function buildSearchContentBlocks(
  input: SearchInput,
  data: SearchOutput,
): { type: 'text'; text: string }[] {
  if (input.format === 'stream_answer') {
    const { warning, answer, ...rest } = data;
    const envelope: StreamAnswerEnvelope = {
      stream: answer ?? '',
      ...rest,
    };
    if (warning) envelope.notice = warning;
    return [{ type: 'text', text: JSON.stringify(envelope, null, 2) }];
  }

  const blocks: { type: 'text'; text: string }[] = [];
  if (data.warning) {
    blocks.push({ type: 'text', text: `[wigolo notice] ${data.warning}` });
  }
  blocks.push({ type: 'text', text: JSON.stringify(data, null, 2) });
  return blocks;
}
