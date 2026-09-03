"""The ``runs`` namespace — a PROJECTION CLIENT over the daemon's existing runs routes, not a
new transport (SD8 mini-spec 9, ruling A-19-8).

A run is the unit of everything: task, transcript, tab group, action log and pending decisions,
living in the daemon as an append-only event log that outlives every UI. Everything here is a
read of that log or a write through a route that appends to it. There is deliberately no local
run state, no cache and no derived status — a second source of truth for who drives or what
happened is the one thing this shape exists to prevent.

The stream is ``GET /v1/runs/<id>/events``, whose SSE ``id`` IS the event ``seq``. That identity
is the whole resume contract: a reconnect sends ``Last-Event-ID`` and the server replays from
strictly greater, so a dropped socket costs a round trip and never an event.

Twin of ``sdks/typescript/src/runs.ts``.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING, Any, Callable, Iterator, Optional, Sequence, Union

from ._errors import WigoloConnectionError
from ._sse import LAST_EVENT_ID_HEADER, SseParser

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ._client import Client

__all__ = ["Runs", "RunWatch", "parse_run_event"]

#: Law-3 driver vocabulary, verbatim.
DRIVER_KINDS = ("cli", "sdk", "api", "studio", "human")

_DEFAULT_MAX_RECONNECTS = 10
_DEFAULT_RECONNECT_DELAY_S = 3.0
#: Read deadline on the event stream. The daemon heartbeats every 15s of silence, so silence
#: past this is a dead peer rather than a quiet run — which is the one case a reconnect fixes.
_DEFAULT_STREAM_READ_TIMEOUT_S = 60.0


def parse_run_event(data: str) -> Optional[dict]:
    """Turn one ``data:`` payload into an envelope, or ``None`` when it is not one.

    Rejecting is not the same as raising. A frame this SDK cannot read — malformed JSON, a
    shape from a future the envelope contract has not reached — is DROPPED, because the
    alternative is a client that a server-side addition can crash. ``seq`` and ``type`` are
    required because they are what ordering and dispatch are built on; everything else is
    filled in defensively.
    """
    try:
        raw = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(raw, dict):
        return None
    seq = raw.get("seq")
    # bool is an int in Python and `True` is not a sequence number.
    if not isinstance(seq, int) or isinstance(seq, bool):
        return None
    event_type = raw.get("type")
    if not isinstance(event_type, str) or not event_type:
        return None
    actor = raw.get("actor")
    payload = raw.get("payload")
    return {
        "seq": seq,
        "ts": raw["ts"] if isinstance(raw.get("ts"), str) else "",
        "actor": actor if isinstance(actor, dict) else {"kind": "system"},
        "type": event_type,
        "payload": payload if isinstance(payload, dict) else {},
    }


class RunWatch:
    """Handle on a running watch.

    The watch runs on its own daemon thread so a synchronous caller keeps its own. ``stop`` is
    idempotent and ``join`` waits for the thread to settle.
    """

    def __init__(self, stop_event: threading.Event, thread: threading.Thread) -> None:
        self._stop_event = stop_event
        self._thread = thread
        self._last_seq = 0

    @property
    def last_seq(self) -> int:
        """Highest seq delivered so far — the resume point if you restart the watch yourself."""
        return self._last_seq

    def stop(self) -> None:
        """Stop watching. Idempotent."""
        self._stop_event.set()

    def join(self, timeout: Optional[float] = None) -> None:
        """Wait for the watch thread to finish."""
        self._thread.join(timeout)

    def __enter__(self) -> "RunWatch":
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()
        self.join()


class Runs:
    """The runs surface, bound to a :class:`~wigolo._client.Client`.

    Reached as ``client.runs``; there is no reason to construct one directly.
    """

    def __init__(self, client: "Client") -> None:
        self._client = client

    # ---- request methods -------------------------------------------------

    def create(
        self,
        *,
        task: str,
        space_id: Optional[str] = None,
        driver: Optional[dict] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """``POST /v1/runs`` — creates the run and writes ``run.created`` as seq 1."""
        body: dict[str, Any] = {"task": task}
        if space_id is not None:
            body["spaceId"] = space_id
        if driver is not None:
            body["driver"] = driver
        return self._client._request("POST", "/v1/runs", body=body, timeout=timeout)["run"]

    def get(self, run_id: str, *, timeout: Optional[float] = None) -> dict:
        """``GET /v1/runs/<id>`` — the run object, itself a projection of the log."""
        path = f"/v1/runs/{urllib.parse.quote(run_id, safe='')}"
        return self._client._request("GET", path, timeout=timeout)["run"]

    def list(
        self,
        *,
        status: Optional[Union[str, Sequence[str]]] = None,
        space_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """``GET /v1/runs`` — newest first, keyset-paged through ``next_cursor``."""
        query: dict[str, str] = {}
        if status is not None:
            query["status"] = status if isinstance(status, str) else ",".join(status)
        if space_id is not None:
            query["spaceId"] = space_id
        if limit is not None:
            query["limit"] = str(limit)
        if cursor is not None:
            query["cursor"] = cursor
        suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
        body = self._client._request("GET", f"/v1/runs{suffix}", timeout=timeout)
        runs = body.get("runs")
        result: dict[str, Any] = {"runs": runs if isinstance(runs, list) else []}
        if isinstance(body.get("next_cursor"), str):
            result["next_cursor"] = body["next_cursor"]
        return result

    def send_message(
        self,
        run_id: str,
        *,
        text: str,
        urgent: Optional[bool] = None,
        message_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """``POST /v1/runs/<id>/messages`` — accept a message into the delivery queue.

        The route answers ``202``, and the returned ``state_line`` says the same thing again:
        the message is QUEUED and reaches the agent at its next tool call. Nothing here has
        been delivered.
        """
        body: dict[str, Any] = {"text": text}
        if urgent is not None:
            body["urgent"] = urgent
        if message_id is not None:
            body["message_id"] = message_id
        path = f"/v1/runs/{urllib.parse.quote(run_id, safe='')}/messages"
        return self._client._request("POST", path, body=body, timeout=timeout)

    def messages(
        self, run_id: str, *, limit: Optional[int] = None, timeout: Optional[float] = None
    ) -> list:
        """``GET /v1/runs/<id>/messages`` — the run's messages, newest first."""
        suffix = f"?limit={limit}" if limit is not None else ""
        path = f"/v1/runs/{urllib.parse.quote(run_id, safe='')}/messages{suffix}"
        body = self._client._request("GET", path, timeout=timeout)
        messages = body.get("messages")
        return messages if isinstance(messages, list) else []

    def driver_gesture(
        self,
        run_id: str,
        *,
        gesture: str,
        by: dict,
        to: Optional[dict] = None,
        request_id: Optional[str] = None,
        reason: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """``POST /v1/runs/<id>/driver`` — the baton gestures, the only way the wheel moves.

        There is deliberately no "set the driver": a transition that did not go through a
        gesture would be a second source of truth for who drives. Request-the-wheel is a
        gesture, never a race.
        """
        body: dict[str, Any] = {"gesture": gesture, "by": by}
        if to is not None:
            body["to"] = to
        if request_id is not None:
            body["requestId"] = request_id
        if reason is not None:
            body["reason"] = reason
        path = f"/v1/runs/{urllib.parse.quote(run_id, safe='')}/driver"
        result = self._client._request("POST", path, body=body, timeout=timeout)
        events = result.get("events")
        result["events"] = events if isinstance(events, list) else []
        return result

    # ---- the event stream ------------------------------------------------

    def events(
        self,
        run_id: str,
        *,
        since: int = 0,
        reconnect: bool = True,
        max_reconnects: int = _DEFAULT_MAX_RECONNECTS,
        reconnect_delay: Optional[float] = None,
        stop_event: Optional[threading.Event] = None,
        read_timeout: float = _DEFAULT_STREAM_READ_TIMEOUT_S,
    ) -> Iterator[dict]:
        """``GET /v1/runs/<id>/events`` as an iterator of envelopes — replay, then live tail.

        Resume is built in and is why this is hand-rolled: on a dropped socket the loop
        reconnects with ``Last-Event-ID`` set to the highest seq it DELIVERED, and the server
        sends strictly greater. A monotone guard runs on this side too, so a server that
        re-sent an event the client already has cannot make it appear twice — exactly-once
        delivery per seq holds without either side coordinating.

        The daemon never closes the stream on its own, not even after a terminal event. Stop by
        breaking out of the loop or by setting ``stop_event``.
        """
        stop = stop_event if stop_event is not None else threading.Event()
        parser = SseParser()
        last_seq = since
        if last_seq > 0:
            parser.set_resume_id(str(last_seq))
        attempts = 0
        path = f"/v1/runs/{urllib.parse.quote(run_id, safe='')}/events"

        while not stop.is_set():
            headers = {"Accept": "text/event-stream"}
            if self._client._token:
                headers["Authorization"] = f"Bearer {self._client._token}"
            # ``Last-Event-ID`` outranks ``?since=`` server-side, so only ONE of them is ever
            # sent — the header, which is also what carries the resume point across a
            # reconnect. An explicit ``since`` is just the starting value of that counter.
            if last_seq > 0:
                headers[LAST_EVENT_ID_HEADER] = str(last_seq)

            delivered = False
            try:
                for chunk in self._open_stream(path, headers, stop, read_timeout):
                    for message in parser.push(chunk):
                        event = parse_run_event(message.data)
                        # A frame that is not an envelope is dropped, not raised on.
                        if event is None:
                            continue
                        # The monotone guard. A replayed seq is a duplicate, never a rewind.
                        if event["seq"] <= last_seq:
                            continue
                        last_seq = event["seq"]
                        delivered = True
                        attempts = 0
                        yield event
                        if stop.is_set():
                            return
            finally:
                # Half-parsed bytes belong to a connection that is gone; the resume id survives.
                parser.reset()

            if stop.is_set() or not reconnect:
                return
            if not delivered:
                attempts += 1
                if attempts > max_reconnects:
                    return
            delay = reconnect_delay
            if delay is None:
                delay = (
                    parser.retry_ms / 1000.0
                    if parser.retry_ms is not None
                    else _DEFAULT_RECONNECT_DELAY_S
                )
            if delay > 0:
                # ``wait`` rather than ``sleep``: a stop during the backoff must not have to
                # wait out a delay the caller has already cancelled.
                stop.wait(delay)

    def _open_stream(
        self,
        path: str,
        headers: dict[str, str],
        stop: threading.Event,
        read_timeout: float,
    ) -> Iterator[str]:
        """One connection's worth of decoded text, line by line, until it ends.

        Read line by line rather than in fixed blocks: an event stream is line-oriented, and a
        blocking fixed-size read would sit on a partial event until enough unrelated bytes
        arrived behind it. A line break is also never part of a multi-byte UTF-8 sequence, so
        decoding per line cannot split a character.
        """
        url = f"{self._client._base_url}{path}"
        request = urllib.request.Request(url, method="GET", headers=headers)
        try:
            response = self._client._urlopen(request, timeout=read_timeout)
        except urllib.error.HTTPError as exc:
            raise self._client._api_error_from_http(exc) from None
        except (urllib.error.URLError, OSError) as exc:
            if stop.is_set():
                return
            raise WigoloConnectionError(
                f"could not open the run event stream at {url} ({exc})."
            ) from exc

        try:
            while not stop.is_set():
                try:
                    line = response.readline()
                except (OSError, ValueError):
                    # A read timeout past the heartbeat, or a socket closed under us by
                    # ``stop`` — either way this connection is over and the caller's loop
                    # decides whether to resume.
                    return
                if not line:
                    return
                yield line.decode("utf-8", errors="replace")
        finally:
            try:
                response.close()
            except Exception:  # pragma: no cover - defensive
                pass

    # ---- fan-out ---------------------------------------------------------

    def watch_run(
        self,
        run_id: str,
        *,
        on_human_message: Optional[Callable[[dict], Any]] = None,
        on_approval: Optional[Callable[[dict], Any]] = None,
        on_takeover: Optional[Callable[[dict], Any]] = None,
        on_event: Optional[Callable[[dict], Any]] = None,
        on_error: Optional[Callable[[BaseException, Optional[dict]], Any]] = None,
        **events_kwargs: Any,
    ) -> RunWatch:
        """Watch a run on a background thread and fan its envelopes out to callbacks.

        Mapping: ``message.queued`` -> ``on_human_message``, ``decision.requested`` ->
        ``on_approval``, ``driver.changed {cause: 'takeover'}`` -> ``on_takeover``. Every
        envelope — including one whose type this SDK has never heard of — also reaches
        ``on_event``, which is the forward-compat seam.

        A ``driver.changed`` that is a grant or a release is NOT a takeover and does not fire
        ``on_takeover``; the cause is the whole distinction between someone being handed the
        wheel and someone taking it.

        Every callback is best-effort: one that raises is reported to ``on_error`` and the
        watch continues, because a watcher killed by its own handler stops projecting a run
        that is still going.
        """
        stop = threading.Event()
        events_kwargs.setdefault("stop_event", stop)
        watch_ref: dict[str, RunWatch] = {}

        def dispatch(handler: Optional[Callable[[dict], Any]], event: dict) -> None:
            if handler is None:
                return
            try:
                handler(event)
            except BaseException as exc:  # noqa: BLE001 - never rethrown, see docstring
                if on_error is not None:
                    try:
                        on_error(exc, event)
                    except BaseException:  # noqa: BLE001 - out of options
                        pass

        def pump() -> None:
            try:
                for event in self.events(run_id, **events_kwargs):
                    watch = watch_ref.get("watch")
                    if watch is not None:
                        watch._last_seq = event["seq"]
                    event_type = event["type"]
                    if event_type == "message.queued":
                        dispatch(on_human_message, event)
                    elif event_type == "decision.requested":
                        dispatch(on_approval, event)
                    elif event_type == "driver.changed":
                        if event["payload"].get("cause") == "takeover":
                            dispatch(on_takeover, event)
                    # An unknown type has nothing to do here; ``on_event`` is its destination.
                    dispatch(on_event, event)
            except BaseException as exc:  # noqa: BLE001 - a dead thread must still report
                if not stop.is_set() and on_error is not None:
                    try:
                        on_error(exc, None)
                    except BaseException:  # noqa: BLE001
                        pass

        thread = threading.Thread(target=pump, name=f"wigolo-watch-{run_id}", daemon=True)
        watch = RunWatch(stop, thread)
        watch_ref["watch"] = watch
        thread.start()
        return watch
