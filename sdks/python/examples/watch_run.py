"""Drive one run from the Python SDK: create it, watch it, answer it.

    node sdks/examples/runs-wire-stub.mjs &
    python sdks/python/examples/watch_run.py

Point it at a studio daemon instead with WIGOLO_BASE_URL / WIGOLO_API_TOKEN; nothing in this
file changes.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from wigolo import Client  # noqa: E402

client = Client(base_url=os.environ.get("WIGOLO_BASE_URL", "http://127.0.0.1:8787"))

run = client.runs.create(
    task="compare three 27-inch monitors",
    driver={"kind": "sdk", "client": {"name": "demo", "version": "1.0"}},
)
print(f"run {run['id']} — {run['status']} — driver {run['driver']['kind']}")

finished = threading.Event()


def on_human_message(event):
    print(f"  [human]    seq {event['seq']}: {event['payload']['text']}")


def on_approval(event):
    anchor = event["payload"].get("anchor", {})
    print(
        f"  [approval] seq {event['seq']}: {event['payload']['prompt']} "
        f"(anchored to mark {anchor.get('mark')} on {anchor.get('tabId')})"
    )


def on_takeover(event):
    print(f"  [takeover] seq {event['seq']}: {event['payload']['reason']}")


def on_event(event):
    print(f"  [event]    seq {event['seq']}: {event['type']}")
    if event["type"] == "run.completed":
        finished.set()


watch = client.runs.watch_run(
    run["id"],
    on_human_message=on_human_message,
    on_approval=on_approval,
    on_takeover=on_takeover,
    on_event=on_event,
    on_error=lambda exc, event: print(f"  [error]    {exc}"),
    reconnect_delay=0.1,
)

# A message is QUEUED, never sent. The server's own state line says so; print it verbatim.
queued = client.runs.send_message(run["id"], text="prefer 120Hz panels")
print(f"message {queued['message']['message_id']}: {queued['message']['state_line']}")

# Request-the-wheel is a gesture, never a race.
gesture = client.runs.driver_gesture(
    run["id"],
    gesture="request",
    by={"kind": "sdk", "client": {"name": "demo", "version": "1.0"}},
    reason="I can finish the comparison",
)
print(
    f"wheel requested — requestId {gesture.get('requestId')}, "
    f"events {len(gesture['events'])}"
)

finished.wait(timeout=30)
watch.stop()
watch.join(timeout=10)
print(f"watch stopped at seq {watch.last_seq}")
