"""A hand-rolled ``text/event-stream`` parser — no dependency, because the SDK has none and
one event-stream field parser is not worth becoming the first.

The parser is PURE: text in through :meth:`SseParser.push`, complete messages out. It owns no
socket, no timer and no reconnect policy, so the resume behaviour that rides on it (``_runs``)
is testable by feeding it split chunks rather than by killing real sockets.

Twin of ``sdks/typescript/src/sse.ts`` — same rules, same edge cases, same tests. A divergence
between the two is a bug in one of them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

__all__ = ["LAST_EVENT_ID_HEADER", "SseMessage", "SseParser"]

LAST_EVENT_ID_HEADER = "Last-Event-ID"

_LINE_BREAK = re.compile(r"\r\n|\n|\r")


@dataclass(frozen=True)
class SseMessage:
    """One dispatched event-stream message."""

    #: The ``event:`` field, or ``"message"`` when the stream did not name one.
    type: str
    #: ``data:`` lines joined with a newline, in arrival order.
    data: str
    #: The last-event-id in force when this message dispatched.
    last_event_id: Optional[str]


class SseParser:
    """Incremental event-stream parser.

    Implements the WHATWG parsing rules the daemon's stream actually exercises: ``\\n`` /
    ``\\r\\n`` / ``\\r`` line breaks, comment (``:``) frames as heartbeats, the single optional
    space after a field's colon, multi-line ``data`` joined with ``\\n``, and ``id`` persisting
    across messages as the last-event-id (which the daemon sets to the run event's ``seq`` —
    that identity is the whole resume contract).
    """

    def __init__(self) -> None:
        self._pending = ""
        self._data_lines: list[str] = []
        self._event_type = ""
        # The id seen on the wire, which is NOT yet the resume point. The two are kept apart
        # deliberately and the separation is load-bearing: a connection that dies after
        # ``id: 13`` but before that message's blank line must resume from 12, or event 13 —
        # which was never delivered to anyone — is skipped by the very mechanism meant to make
        # resume gapless.
        self._id_buffer: Optional[str] = None
        # The id of the last message actually DISPATCHED. This is what ``Last-Event-ID`` carries.
        self._last_event_id: Optional[str] = None
        self._retry_ms: Optional[int] = None
        # Set when the previous chunk ended on a bare ``\r``, whose ``\n`` may open the next one.
        self._saw_trailing_cr = False

    @property
    def retry_ms(self) -> Optional[int]:
        """The ``retry:`` the server advertised, in ms, if it sent one."""
        return self._retry_ms

    @property
    def resume_id(self) -> Optional[str]:
        """The id to resume from — what goes in ``Last-Event-ID`` on the next connect."""
        return self._last_event_id

    def set_resume_id(self, value: Optional[str]) -> None:
        """Seed the resume point from a stored cursor, before the first byte arrives."""
        self._last_event_id = value
        self._id_buffer = value

    def push(self, chunk: str) -> list[SseMessage]:
        """Feed a decoded chunk; return every message that COMPLETED within it.

        A chunk boundary may fall anywhere, including mid-field and between a ``\\r`` and its
        ``\\n``, so nothing dispatches until a blank line actually arrives.
        """
        if not chunk:
            return []
        text = chunk
        # A ``\r`` that ended the previous chunk was already treated as a line break. If this
        # chunk opens with its ``\n``, that pair is ONE break, not two — dropping the ``\n``
        # here is what keeps a CRLF split across chunks from dispatching a spurious empty line.
        if self._saw_trailing_cr and text.startswith("\n"):
            text = text[1:]
        self._saw_trailing_cr = text.endswith("\r")

        self._pending += text
        lines = _LINE_BREAK.split(self._pending)
        # The final element is whatever followed the last break — incomplete unless the chunk
        # ended on one, in which case it is "" and carrying it over is a no-op.
        self._pending = lines.pop()

        messages: list[SseMessage] = []
        for line in lines:
            message = self._consume_line(line)
            if message is not None:
                messages.append(message)
        return messages

    def reset(self) -> None:
        """Drop everything half-parsed after a connection dies mid-message.

        Those bytes will be re-sent from ``resume_id``, and keeping them would splice two
        connections' fragments into one corrupt message. The resume id and the retry hint
        deliberately SURVIVE — they are what the next connection is built from.
        """
        self._pending = ""
        self._data_lines = []
        self._event_type = ""
        self._saw_trailing_cr = False
        # Roll the id buffer back to the last DISPATCHED id. An id read off the dead connection
        # belongs to a message nobody received, and resuming past it would drop that event.
        self._id_buffer = self._last_event_id

    def _consume_line(self, line: str) -> Optional[SseMessage]:
        if line == "":
            return self._dispatch()
        # A comment frame. The daemon sends ``: ping`` every 15s of silence, so this is the
        # common case on an idle stream and must cost nothing.
        if line.startswith(":"):
            return None

        field, sep, value = line.partition(":")
        if not sep:
            field, value = line, ""
        # Exactly one leading space is part of the framing, not the value.
        if value.startswith(" "):
            value = value[1:]

        if field == "event":
            self._event_type = value
        elif field == "data":
            self._data_lines.append(value)
        elif field == "id":
            # An id containing a NUL is defined to be ignored rather than to reset the id.
            if "\u0000" not in value:
                self._id_buffer = value
        elif field == "retry":
            if value.isdigit():
                self._retry_ms = int(value)
        # Any other field is ignored, which is what makes the stream extensible.
        return None

    def _dispatch(self) -> Optional[SseMessage]:
        """A blank line ends the message.

        A blank line with no ``data`` accumulated is NOT a message — that is how the
        ``retry:``-only opening frame and stray blank lines stay invisible to callers.
        """
        if not self._data_lines:
            self._event_type = ""
            return None
        # Dispatch is the moment the buffered id BECOMES the resume point.
        self._last_event_id = self._id_buffer
        message = SseMessage(
            type=self._event_type if self._event_type else "message",
            data="\n".join(self._data_lines),
            last_event_id=self._last_event_id,
        )
        self._data_lines = []
        self._event_type = ""
        return message
