"""The hand-rolled event-stream parser.

Mirrors ``sdks/typescript/tests/sse.unit.test.ts`` case for case: the two SDKs parse the same
stream, so a divergence between them is a bug in one of them.
"""

from __future__ import annotations

from wigolo import SseMessage, SseParser


def parse_all(text: str, parser: SseParser | None = None) -> list[SseMessage]:
    return (parser or SseParser()).push(text)


def test_dispatches_on_the_blank_line_with_type_data_and_id():
    assert parse_all('id: 17\nevent: tab.attached\ndata: {"seq":17}\n\n') == [
        SseMessage(type="tab.attached", data='{"seq":17}', last_event_id="17")
    ]


def test_defaults_the_type_to_message():
    assert parse_all("data: hello\n\n")[0].type == "message"


def test_strips_exactly_one_space_after_the_colon():
    assert parse_all("data:  two spaces\n\n")[0].data == " two spaces"


def test_a_field_with_no_colon_is_that_field_with_an_empty_value():
    assert parse_all("data\n\n") == [SseMessage(type="message", data="", last_event_id=None)]


def test_joins_multi_line_data_with_a_newline():
    assert parse_all("data: one\ndata: two\ndata: three\n\n")[0].data == "one\ntwo\nthree"


def test_ignores_comment_frames_the_heartbeat_must_cost_nothing():
    messages = parse_all(": ping\n\n: ping\n\ndata: real\n\n")
    assert len(messages) == 1
    assert messages[0].data == "real"


def test_a_blank_line_with_no_data_is_not_a_message():
    assert parse_all("retry: 3000\n\n") == []


def test_records_the_retry_hint():
    parser = SseParser()
    parser.push("retry: 4500\n\n")
    assert parser.retry_ms == 4500


def test_ignores_a_non_integer_retry():
    parser = SseParser()
    parser.push("retry: soon\n\n")
    assert parser.retry_ms is None


def test_last_event_id_persists_across_messages_without_their_own_id():
    messages = parse_all("id: 5\ndata: a\n\ndata: b\n\n")
    assert [m.last_event_id for m in messages] == ["5", "5"]


def test_ignores_an_id_containing_a_nul():
    parser = SseParser()
    parser.push("id: 9\ndata: a\n\n")
    parser.push("id: 1\x002\ndata: b\n\n")
    assert parser.resume_id == "9"


def test_ignores_unknown_fields():
    assert parse_all("data: a\nfuture-field: whatever\n\n") == [
        SseMessage(type="message", data="a", last_event_id=None)
    ]


def test_holds_an_incomplete_message_until_its_blank_line():
    parser = SseParser()
    assert parser.push('id: 3\ndata: {"se') == []
    assert parser.push('q":3}\n') == []
    assert parser.push("\n") == [
        SseMessage(type="message", data='{"seq":3}', last_event_id="3")
    ]


def test_a_crlf_split_across_chunks_is_one_break_not_two():
    parser = SseParser()
    # A naive parser sees the trailing \r as a break and the next chunk's leading \n as a
    # SECOND one — which would dispatch the message a line early.
    assert parser.push("data: a\r") == []
    assert parser.push("\ndata: b\r\n\r\n") == [
        SseMessage(type="message", data="a\nb", last_event_id=None)
    ]


def test_accepts_a_bare_cr_as_a_line_break():
    assert parse_all("data: a\r\r") == [SseMessage(type="message", data="a", last_event_id=None)]


def test_emits_several_complete_messages_from_one_chunk_in_order():
    messages = parse_all("id: 1\ndata: a\n\nid: 2\ndata: b\n\nid: 3\ndata: c\n\n")
    assert [m.last_event_id for m in messages] == ["1", "2", "3"]


def test_reset_drops_half_parsed_bytes_but_keeps_the_resume_id():
    parser = SseParser()
    parser.push("id: 12\ndata: complete\n\nid: 13\ndata: half")
    parser.reset()
    # 13 was read off a message that never dispatched. Resuming past it would drop that event.
    assert parser.resume_id == "12"
    assert parser.push("id: 13\ndata: whole\n\n") == [
        SseMessage(type="message", data="whole", last_event_id="13")
    ]


def test_a_seeded_resume_id_survives_a_fresh_parser():
    parser = SseParser()
    parser.set_resume_id("41")
    assert parser.resume_id == "41"
