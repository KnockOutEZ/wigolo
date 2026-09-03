"""The ``runs`` namespace: request methods, the SSE iterator with resume, and watch_run fan-out.

Twin of ``sdks/typescript/tests/runs.unit.test.ts``. The streaming cases run against a real
localhost server (``_sse_server``) rather than a faked transport, because the resume contract is
a property of two connections and a faked transport would let a broken client agree with a
broken fake.
"""

from __future__ import annotations

import json
import threading

import pytest

from _sse_server import SseTestServer
from wigolo import Client, parse_run_event
from wigolo._sse import LAST_EVENT_ID_HEADER


def frame(seq: int, event_type: str, payload: dict | None = None) -> str:
    envelope = {
        "seq": seq,
        "ts": f"2026-08-22T14:03:{10 + seq:02d}.000Z",
        "actor": {"kind": "agent", "driver": "cli"},
        "type": event_type,
        "payload": payload or {},
    }
    return f"id: {seq}\nevent: {event_type}\ndata: {json.dumps(envelope)}\n\n"


def message_queued(seq: int) -> str:
    return frame(
        seq,
        "message.queued",
        {"messageId": f"m{seq}", "text": "check the second tab", "from": {"kind": "human"}},
    )


def decision_requested(seq: int) -> str:
    return frame(
        seq,
        "decision.requested",
        {
            "decisionId": f"d{seq}",
            "kind": "approval",
            "prompt": "Submit this order?",
            "anchor": {"tabId": "t1", "mark": 4},
            "requestedAt": "2026-08-22T14:03:20.000Z",
        },
    )


def driver_changed(seq: int, cause: str) -> str:
    return frame(
        seq,
        "driver.changed",
        {
            "from": {"kind": "cli"},
            "to": {"kind": "human"},
            "cause": cause,
            "reason": "human took control",
        },
    )


# ---- parse_run_event: forward compatibility ------------------------------------------------


def test_parses_a_complete_envelope():
    assert parse_run_event(
        '{"seq":7,"ts":"t","actor":{"kind":"human"},"type":"tab.attached",'
        '"payload":{"tabId":"a"}}'
    ) == {
        "seq": 7,
        "ts": "t",
        "actor": {"kind": "human"},
        "type": "tab.attached",
        "payload": {"tabId": "a"},
    }


def test_accepts_a_type_this_sdk_has_never_heard_of():
    event = parse_run_event('{"seq":1,"ts":"t","actor":{"kind":"daemon"},"type":"quantum.entangled","payload":{}}')
    assert event is not None and event["type"] == "quantum.entangled"


def test_accepts_unknown_fields_on_the_envelope():
    event = parse_run_event('{"seq":1,"ts":"t","actor":{},"type":"x.y","payload":{},"future":"d"}')
    assert event is not None and event["seq"] == 1


@pytest.mark.parametrize(
    "raw",
    [
        "not json at all",
        '{"ts":"t","type":"x.y","payload":{}}',  # no seq — ordering is built on it
        '{"seq":1,"ts":"t","payload":{}}',  # no type — dispatch is built on it
        '{"seq":true,"type":"x.y"}',  # bool is an int in Python; it is not a seq
        "[1,2,3]",
    ],
)
def test_drops_a_frame_that_is_not_an_envelope_rather_than_raising(raw):
    assert parse_run_event(raw) is None


def test_substitutes_defaults_for_a_missing_actor_and_payload():
    assert parse_run_event('{"seq":2,"type":"x.y"}') == {
        "seq": 2,
        "ts": "",
        "actor": {"kind": "system"},
        "type": "x.y",
        "payload": {},
    }


# ---- the event stream ----------------------------------------------------------------------


def collect(iterator, count):
    out = []
    for event in iterator:
        out.append(event)
        if len(out) >= count:
            break
    return out


def test_yields_envelopes_in_seq_order_from_one_connection():
    with SseTestServer([frame(1, "run.created") + frame(2, "tab.attached")]) as server:
        client = Client(base_url=server.base_url)
        events = collect(client.runs.events("7fq2", reconnect=False), 2)
    assert [e["seq"] for e in events] == [1, 2]
    assert [e["type"] for e in events] == ["run.created", "tab.attached"]


def test_survives_a_dropped_stream_and_resumes_gapless():
    # Connection 1 delivers 1..3 then dies mid-frame: the bytes of seq 4 arrive without their
    # terminating blank line, exactly as a socket cut would leave them.
    dropped = frame(4, "tab.attached")[:-6]
    script = [
        frame(1, "run.created") + frame(2, "tab.attached") + frame(3, "cost.recorded") + dropped,
        frame(4, "tab.attached") + frame(5, "run.completed"),
    ]
    with SseTestServer(script) as server:
        client = Client(base_url=server.base_url)
        events = collect(client.runs.events("7fq2", reconnect_delay=0), 5)
        requests = list(server.requests)

    # No gap, no duplicate, no rewind: 1,2,3,4,5 across two connections.
    assert [e["seq"] for e in events] == [1, 2, 3, 4, 5]
    assert len(requests) == 2
    # The half-delivered seq 4 was NOT counted as delivered: the reconnect asks for >3.
    assert LAST_EVENT_ID_HEADER.lower() not in requests[0]
    assert requests[1][LAST_EVENT_ID_HEADER.lower()] == "3"


def test_drops_a_duplicate_the_server_resent():
    script = [
        frame(1, "run.created") + frame(2, "tab.attached") + frame(3, "cost.recorded"),
        frame(3, "cost.recorded") + frame(4, "run.completed"),
    ]
    with SseTestServer(script) as server:
        client = Client(base_url=server.base_url)
        events = collect(client.runs.events("7fq2", reconnect_delay=0), 4)
    assert [e["seq"] for e in events] == [1, 2, 3, 4]


def test_starts_from_an_explicit_since_sending_it_as_the_resume_header():
    with SseTestServer([frame(41, "run.completed")]) as server:
        client = Client(base_url=server.base_url)
        collect(client.runs.events("7fq2", since=40, reconnect=False), 1)
        requests = list(server.requests)
    assert requests[0][LAST_EVENT_ID_HEADER.lower()] == "40"


def test_sends_the_bearer_token_and_the_event_stream_accept():
    with SseTestServer([frame(1, "run.created")]) as server:
        client = Client(base_url=server.base_url, token="sekret")
        collect(client.runs.events("7fq2", reconnect=False), 1)
        requests = list(server.requests)
    assert requests[0]["authorization"] == "Bearer sekret"
    assert requests[0]["accept"] == "text/event-stream"
    assert requests[0]["path"] == "/v1/runs/7fq2/events"


def test_stops_reconnecting_after_max_reconnects_when_nothing_is_delivered():
    with SseTestServer(["", "", "", "", ""]) as server:
        client = Client(base_url=server.base_url)
        events = collect(client.runs.events("7fq2", reconnect_delay=0, max_reconnects=2), 99)
        count = server.connection_count
    assert events == []
    # The first connect plus two retries; the third failure ends it.
    assert count == 3


def test_does_not_reconnect_when_reconnect_is_off():
    with SseTestServer([frame(1, "run.created"), frame(2, "x.y")]) as server:
        client = Client(base_url=server.base_url)
        collect(client.runs.events("7fq2", reconnect=False), 1)
        count = server.connection_count
    assert count == 1


def test_ignores_a_frame_that_is_not_an_envelope_and_keeps_streaming():
    script = [frame(1, "run.created") + "event: junk\ndata: {oops\n\n" + frame(2, "run.completed")]
    with SseTestServer(script) as server:
        client = Client(base_url=server.base_url)
        events = collect(client.runs.events("7fq2", reconnect=False), 2)
    assert [e["seq"] for e in events] == [1, 2]


def test_a_refused_stream_raises_the_api_error():
    from wigolo import WigoloAPIError

    with SseTestServer([""], status=404) as server:
        client = Client(base_url=server.base_url)
        with pytest.raises(WigoloAPIError):
            collect(client.runs.events("nope", reconnect=False), 1)


# ---- watch_run fan-out ---------------------------------------------------------------------


def watch_all(script):
    seen = {"human": [], "approval": [], "takeover": [], "all": [], "errors": []}
    with SseTestServer(script) as server:
        client = Client(base_url=server.base_url)
        watch = client.runs.watch_run(
            "7fq2",
            on_human_message=seen["human"].append,
            on_approval=seen["approval"].append,
            on_takeover=seen["takeover"].append,
            on_event=seen["all"].append,
            on_error=lambda exc, event: seen["errors"].append(exc),
            reconnect=False,
        )
        watch.join(timeout=10)
    return seen, watch


def test_routes_message_queued_to_on_human_message():
    seen, _ = watch_all([message_queued(4)])
    assert len(seen["human"]) == 1
    assert seen["human"][0]["type"] == "message.queued"
    assert seen["human"][0]["payload"]["text"] == "check the second tab"


def test_routes_decision_requested_to_on_approval_anchor_intact():
    seen, _ = watch_all([decision_requested(6)])
    assert len(seen["approval"]) == 1
    assert seen["approval"][0]["payload"]["anchor"] == {"tabId": "t1", "mark": 4}


def test_routes_a_takeover_to_on_takeover():
    seen, _ = watch_all([driver_changed(9, "takeover")])
    assert len(seen["takeover"]) == 1
    assert seen["takeover"][0]["payload"]["reason"] == "human took control"


def test_a_grant_or_release_is_not_a_takeover():
    seen, _ = watch_all([driver_changed(1, "grant") + driver_changed(2, "release")])
    assert seen["takeover"] == []
    # Both still reached the tap, so nothing was silently swallowed.
    assert [e["payload"]["cause"] for e in seen["all"]] == ["grant", "release"]


def test_delivers_every_envelope_to_on_event():
    seen, _ = watch_all(
        [message_queued(1) + decision_requested(2) + driver_changed(3, "takeover")]
    )
    assert [e["type"] for e in seen["all"]] == [
        "message.queued",
        "decision.requested",
        "driver.changed",
    ]


def test_a_future_event_type_reaches_on_event_only_and_nothing_raises():
    seen, _ = watch_all([frame(1, "holodeck.engaged", {"deck": 3}) + message_queued(2)])
    assert [e["seq"] for e in seen["human"]] == [2]
    assert seen["approval"] == []
    assert seen["takeover"] == []
    assert [e["type"] for e in seen["all"]] == ["holodeck.engaged", "message.queued"]
    assert seen["errors"] == []


def test_a_future_type_is_ignored_entirely_when_no_on_event_is_supplied():
    errors = []
    with SseTestServer([frame(1, "holodeck.engaged")]) as server:
        client = Client(base_url=server.base_url)
        watch = client.runs.watch_run(
            "7fq2",
            on_human_message=lambda event: None,
            on_error=lambda exc, event: errors.append(exc),
            reconnect=False,
        )
        watch.join(timeout=10)
    assert errors == []


def test_keeps_watching_when_a_callback_raises():
    seen = []
    errors = []

    def explode(event):
        seen.append(event["seq"])
        raise RuntimeError(f"handler exploded on {event['seq']}")

    with SseTestServer([message_queued(1) + message_queued(2)]) as server:
        client = Client(base_url=server.base_url)
        watch = client.runs.watch_run(
            "7fq2",
            on_human_message=explode,
            on_error=lambda exc, event: errors.append(exc),
            reconnect=False,
        )
        watch.join(timeout=10)

    # The second event was still delivered: a watcher killed by its own handler would stop
    # projecting a run that is still going.
    assert seen == [1, 2]
    assert len(errors) == 2


def test_tracks_last_seq_so_a_caller_can_restart_where_it_stopped():
    _, watch = watch_all([frame(11, "run.created") + frame(12, "x.y")])
    assert watch.last_seq == 12


def test_stop_ends_the_watch_and_is_idempotent():
    seen = []
    done = threading.Event()

    with SseTestServer([message_queued(1), message_queued(2)]) as server:
        client = Client(base_url=server.base_url)

        def handler(event):
            seen.append(event["seq"])
            watch.stop()
            watch.stop()
            done.set()

        watch = client.runs.watch_run(
            "7fq2", on_human_message=handler, reconnect_delay=0
        )
        done.wait(timeout=10)
        watch.join(timeout=10)

    assert seen == [1]


# ---- request methods -----------------------------------------------------------------------


class RecordingClient:
    """The narrowest thing ``Runs`` talks to: one request method and the base fields."""

    def __init__(self, response):
        self._response = response
        self._base_url = "http://d"
        self._token = None
        self.calls = []

    def _request(self, method, path, *, body=None, timeout=None):
        self.calls.append({"method": method, "path": path, "body": body})
        return self._response


RUN = {
    "id": "7fq2",
    "task": "find three monitors",
    "spaceId": "default",
    "createdAt": "now",
    "status": "running",
    "driver": {"kind": "api"},
    "tabIds": [],
    "pendingDecisions": [],
    "cost": {"browserActions": 0, "tokensIn": 0, "tokensOut": 0, "spendUsd": 0},
    "visibility": "hidden",
    "lastSeq": 1,
    "updatedAt": "now",
}


def bound(response):
    from wigolo._runs import Runs

    fake = RecordingClient(response)
    return Runs(fake), fake


def test_create_posts_the_task_and_unwraps_the_run():
    runs, fake = bound({"ok": True, "run": RUN})
    run = runs.create(task="find three monitors")
    assert fake.calls[0] == {
        "method": "POST",
        "path": "/v1/runs",
        "body": {"task": "find three monitors"},
    }
    assert run["id"] == "7fq2"


def test_get_encodes_the_run_id_into_the_path():
    runs, fake = bound({"ok": True, "run": RUN})
    runs.get("a/b")
    assert fake.calls[0]["path"] == "/v1/runs/a%2Fb"


def test_list_serialises_a_status_sequence_as_the_comma_list_the_route_expects():
    runs, fake = bound({"ok": True, "runs": [RUN], "next_cursor": "MjA"})
    page = runs.list(status=["running", "needs_you"], limit=10)
    assert fake.calls[0]["path"] == "/v1/runs?status=running%2Cneeds_you&limit=10"
    assert page["next_cursor"] == "MjA"
    assert len(page["runs"]) == 1


def test_list_omits_the_query_string_when_nothing_was_asked_for():
    runs, fake = bound({"ok": True, "runs": []})
    page = runs.list()
    assert fake.calls[0]["path"] == "/v1/runs"
    assert "next_cursor" not in page


def test_send_message_sends_the_wire_spelling_and_returns_state_line():
    runs, fake = bound(
        {
            "ok": True,
            "message": {
                "message_id": "m1",
                "text": "hi",
                "from": {"kind": "human"},
                "queued_at": "now",
                "queued_at_step": 12,
                "state": "queued",
                "state_line": "queued — reaches the agent at its next tool call",
            },
            "replayed": True,
        }
    )
    result = runs.send_message("7fq2", text="hi", message_id="m1")
    assert fake.calls[0]["body"] == {"text": "hi", "message_id": "m1"}
    assert fake.calls[0]["path"] == "/v1/runs/7fq2/messages"
    # Law 7 on the wire: the SDK returns the honest state line rather than composing its own.
    assert result["message"]["state_line"] == "queued — reaches the agent at its next tool call"
    assert result["replayed"] is True


def test_driver_gesture_posts_the_gesture_and_defaults_events_to_empty():
    runs, fake = bound({"ok": True, "run": RUN})
    result = runs.driver_gesture(
        "7fq2",
        gesture="request",
        by={"kind": "sdk", "client": {"name": "acme", "version": "1.0"}},
        reason="I can finish this",
    )
    assert fake.calls[0]["path"] == "/v1/runs/7fq2/driver"
    assert fake.calls[0]["body"] == {
        "gesture": "request",
        "by": {"kind": "sdk", "client": {"name": "acme", "version": "1.0"}},
        "reason": "I can finish this",
    }
    # Empty is the honest answer for a gesture that was a no-op.
    assert result["events"] == []
