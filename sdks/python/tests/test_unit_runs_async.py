"""The async twin of the ``runs`` namespace.

The point of these is parity, not coverage of the same logic twice: ``AsyncRuns`` dispatches to
the SAME synchronous implementation, so what needs pinning is that the async surface exists,
awaits, resumes identically, and awaits coroutine callbacks.
"""

from __future__ import annotations

import asyncio
import json

from _sse_server import SseTestServer
from wigolo import AsyncClient
from wigolo._sse import LAST_EVENT_ID_HEADER


def frame(seq: int, event_type: str, payload: dict | None = None) -> str:
    envelope = {
        "seq": seq,
        "ts": "2026-08-22T14:03:11.000Z",
        "actor": {"kind": "agent", "driver": "cli"},
        "type": event_type,
        "payload": payload or {},
    }
    return f"id: {seq}\nevent: {event_type}\ndata: {json.dumps(envelope)}\n\n"


def run(coro):
    return asyncio.run(coro)


def test_async_events_yields_envelopes_in_seq_order():
    async def main():
        with SseTestServer([frame(1, "run.created") + frame(2, "tab.attached")]) as server:
            client = AsyncClient(base_url=server.base_url)
            try:
                seen = []
                async for event in client.runs.events("7fq2", reconnect=False):
                    seen.append(event["seq"])
                return seen
            finally:
                await client.aclose()

    assert run(main()) == [1, 2]


def test_async_events_resumes_gapless_across_a_dropped_stream():
    dropped = frame(4, "tab.attached")[:-6]
    script = [
        frame(1, "run.created") + frame(2, "tab.attached") + frame(3, "cost.recorded") + dropped,
        frame(4, "tab.attached") + frame(5, "run.completed"),
    ]

    async def main():
        with SseTestServer(script) as server:
            client = AsyncClient(base_url=server.base_url)
            try:
                seen = []
                async for event in client.runs.events("7fq2", reconnect_delay=0):
                    seen.append(event["seq"])
                    if len(seen) >= 5:
                        break
                return seen, list(server.requests)
            finally:
                await client.aclose()

    seen, requests = run(main())
    assert seen == [1, 2, 3, 4, 5]
    assert requests[1][LAST_EVENT_ID_HEADER.lower()] == "3"


def test_async_watch_run_fans_out_and_awaits_coroutine_callbacks():
    script = [
        frame(1, "message.queued", {"text": "hi"})
        + frame(2, "decision.requested", {"decisionId": "d2", "prompt": "ok?"})
        + frame(3, "driver.changed", {"cause": "takeover"})
        + frame(4, "driver.changed", {"cause": "grant"})
        + frame(5, "holodeck.engaged", {"deck": 3})
    ]

    async def main():
        with SseTestServer(script) as server:
            client = AsyncClient(base_url=server.base_url)
            try:
                human, approvals, takeovers, every, order = [], [], [], [], []

                async def on_human(event):
                    order.append(f"start {event['seq']}")
                    await asyncio.sleep(0)
                    order.append(f"end {event['seq']}")
                    human.append(event)

                watch = client.runs.watch_run(
                    "7fq2",
                    on_human_message=on_human,
                    on_approval=approvals.append,
                    on_takeover=takeovers.append,
                    on_event=every.append,
                    reconnect=False,
                )
                await asyncio.wait_for(watch.join(), timeout=15)
                return human, approvals, takeovers, every, order, watch.last_seq
            finally:
                await client.aclose()

    human, approvals, takeovers, every, order, last_seq = run(main())
    assert [e["seq"] for e in human] == [1]
    assert [e["seq"] for e in approvals] == [2]
    # Only the takeover, never the grant — the cause is the whole distinction.
    assert [e["seq"] for e in takeovers] == [3]
    # Every envelope reaches the tap, the future type included.
    assert [e["type"] for e in every] == [
        "message.queued",
        "decision.requested",
        "driver.changed",
        "driver.changed",
        "holodeck.engaged",
    ]
    assert order == ["start 1", "end 1"]
    assert last_seq == 5


def test_async_watch_survives_a_raising_callback():
    script = [frame(1, "message.queued", {"text": "a"}) + frame(2, "message.queued", {"text": "b"})]

    async def main():
        with SseTestServer(script) as server:
            client = AsyncClient(base_url=server.base_url)
            try:
                seen, errors = [], []

                async def explode(event):
                    seen.append(event["seq"])
                    raise RuntimeError("boom")

                watch = client.runs.watch_run(
                    "7fq2",
                    on_human_message=explode,
                    on_error=lambda exc, event: errors.append(exc),
                    reconnect=False,
                )
                await asyncio.wait_for(watch.join(), timeout=15)
                return seen, errors
            finally:
                await client.aclose()

    seen, errors = run(main())
    assert seen == [1, 2]
    assert len(errors) == 2


def test_async_watch_stop_ends_it():
    script = [frame(1, "message.queued", {"text": "a"}), frame(2, "message.queued", {"text": "b"})]

    async def main():
        with SseTestServer(script) as server:
            client = AsyncClient(base_url=server.base_url)
            try:
                seen = []

                def handler(event):
                    seen.append(event["seq"])
                    watch.stop()

                watch = client.runs.watch_run(
                    "7fq2", on_human_message=handler, reconnect_delay=0
                )
                await asyncio.wait_for(watch.join(), timeout=15)
                return seen
            finally:
                await client.aclose()

    assert run(main()) == [1]


def test_async_request_methods_reach_the_same_transport():
    calls = []

    async def main():
        client = AsyncClient(base_url="http://127.0.0.1:1")
        try:
            def fake_request(method, path, *, body=None, timeout=None):
                calls.append({"method": method, "path": path, "body": body})
                return {"ok": True, "run": {"id": "7fq2"}}

            client._client._request = fake_request
            run_obj = await client.runs.create(task="find three monitors")
            await client.runs.get("7fq2")
            return run_obj
        finally:
            await client.aclose()

    run_obj = run(main())
    assert run_obj["id"] == "7fq2"
    assert [c["path"] for c in calls] == ["/v1/runs", "/v1/runs/7fq2"]
    assert calls[0]["body"] == {"task": "find three monitors"}
