"""wigolo — thin Python client for the local-first web intelligence REST API.

Exposes a synchronous ``Client``, an ``AsyncClient``, and ``local_client``
for zero-setup embedded use. This is a thin transport: no retries, no
re-ranking, no interpretation, no caching — the wigolo server does all of
that.
"""

from __future__ import annotations

from ._aio import AsyncClient
from ._aio_runs import AsyncRunWatch, AsyncRuns
from ._client import Client
from ._errors import WigoloAPIError, WigoloConnectionError, WigoloError
from ._local import local_client
from ._runs import RunWatch, Runs, parse_run_event
from ._sse import LAST_EVENT_ID_HEADER, SseMessage, SseParser
from ._untrusted import (
    UNTRUSTED_CONTENT_HEADER,
    UNTRUSTED_CONTENT_MODES,
    fence_untrusted,
    fence_with_envelope,
    untrusted_content_of,
)

__version__ = "0.1.0"

__all__ = [
    "Client",
    "AsyncClient",
    "local_client",
    "Runs",
    "RunWatch",
    "AsyncRuns",
    "AsyncRunWatch",
    "parse_run_event",
    "SseParser",
    "SseMessage",
    "LAST_EVENT_ID_HEADER",
    "WigoloError",
    "WigoloAPIError",
    "WigoloConnectionError",
    "UNTRUSTED_CONTENT_HEADER",
    "UNTRUSTED_CONTENT_MODES",
    "fence_untrusted",
    "fence_with_envelope",
    "untrusted_content_of",
    "__version__",
]
