import { describe, it, expect } from 'vitest';
import { SseParser } from '../src/sse.js';

/** Feed a whole stream as one chunk and collect everything it dispatched. */
function parseAll(text: string, parser = new SseParser()) {
  return parser.push(text);
}

describe('SseParser framing', () => {
  it('dispatches a message on the blank line, with type, data and id', () => {
    const messages = parseAll('id: 17\nevent: tab.attached\ndata: {"seq":17}\n\n');
    expect(messages).toEqual([
      { type: 'tab.attached', data: '{"seq":17}', lastEventId: '17' },
    ]);
  });

  it('defaults the type to "message" when the stream did not name one', () => {
    expect(parseAll('data: hello\n\n')[0].type).toBe('message');
  });

  it('strips exactly one space after the colon, and no more', () => {
    expect(parseAll('data:  two spaces\n\n')[0].data).toBe(' two spaces');
  });

  it('treats a field with no colon as that field with an empty value', () => {
    // `data` alone is a data line whose value is empty — it must still make the message dispatch.
    expect(parseAll('data\n\n')).toEqual([{ type: 'message', data: '', lastEventId: undefined }]);
  });

  it('joins multi-line data with a newline, in arrival order', () => {
    expect(parseAll('data: one\ndata: two\ndata: three\n\n')[0].data).toBe('one\ntwo\nthree');
  });

  it('ignores comment frames — the heartbeat must cost nothing', () => {
    const messages = parseAll(': ping\n\n: ping\n\ndata: real\n\n');
    expect(messages).toHaveLength(1);
    expect(messages[0].data).toBe('real');
  });

  it('does not dispatch a blank line that accumulated no data (the retry: opener)', () => {
    expect(parseAll('retry: 3000\n\n')).toEqual([]);
  });

  it('records the retry hint the server advertised', () => {
    const parser = new SseParser();
    parser.push('retry: 4500\n\n');
    expect(parser.retryMs).toBe(4500);
  });

  it('ignores a non-integer retry rather than adopting NaN as a delay', () => {
    const parser = new SseParser();
    parser.push('retry: soon\n\n');
    expect(parser.retryMs).toBeUndefined();
  });

  it('persists the last-event-id across messages that carry no id of their own', () => {
    const messages = parseAll('id: 5\ndata: a\n\ndata: b\n\n');
    expect(messages.map((m) => m.lastEventId)).toEqual(['5', '5']);
  });

  it('ignores an id containing a NUL rather than clearing the resume point', () => {
    const parser = new SseParser();
    parser.push('id: 9\ndata: a\n\n');
    parser.push(`id: 1${String.fromCharCode(0)}2\ndata: b\n\n`);
    expect(parser.resumeId).toBe('9');
  });

  it('ignores unknown fields, which is what makes the stream extensible', () => {
    const messages = parseAll('data: a\nfuture-field: whatever\n\n');
    expect(messages).toEqual([{ type: 'message', data: 'a', lastEventId: undefined }]);
  });
});

describe('SseParser chunk boundaries', () => {
  it('holds an incomplete message until its blank line arrives', () => {
    const parser = new SseParser();
    expect(parser.push('id: 3\ndata: {"se')).toEqual([]);
    expect(parser.push('q":3}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([
      { type: 'message', data: '{"seq":3}', lastEventId: '3' },
    ]);
  });

  it('handles a CRLF split across two chunks as one break, not two', () => {
    const parser = new SseParser();
    // The chunk ends mid-CRLF; a naive parser sees the trailing \r as a break and the leading \n
    // of the next chunk as a SECOND one — which would dispatch the message a line early.
    expect(parser.push('data: a\r')).toEqual([]);
    expect(parser.push('\ndata: b\r\n\r\n')).toEqual([
      { type: 'message', data: 'a\nb', lastEventId: undefined },
    ]);
  });

  it('accepts bare \\r as a line break', () => {
    expect(parseAll('data: a\r\r')).toEqual([{ type: 'message', data: 'a', lastEventId: undefined }]);
  });

  it('emits several complete messages from one chunk, in order', () => {
    const messages = parseAll('id: 1\ndata: a\n\nid: 2\ndata: b\n\nid: 3\ndata: c\n\n');
    expect(messages.map((m) => m.lastEventId)).toEqual(['1', '2', '3']);
  });
});

describe('SseParser reset', () => {
  it('drops half-parsed bytes but keeps the resume id — the next connection is built from it', () => {
    const parser = new SseParser();
    parser.push('id: 12\ndata: complete\n\nid: 13\ndata: half');
    parser.reset();
    expect(parser.resumeId).toBe('12');
    // The truncated message's bytes are gone: what follows is parsed as a fresh message rather
    // than spliced onto the fragment from the dead connection.
    expect(parser.push('id: 13\ndata: whole\n\n')).toEqual([
      { type: 'message', data: 'whole', lastEventId: '13' },
    ]);
  });

  it('carries a seeded resume id so a stored cursor survives a fresh parser', () => {
    const parser = new SseParser();
    parser.setResumeId('41');
    expect(parser.resumeId).toBe('41');
  });
});
