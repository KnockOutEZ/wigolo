"""Exception types raised by the wigolo client.

- ``WigoloError`` is the base for everything this SDK raises.
- ``WigoloAPIError`` carries a non-2xx HTTP response (status + parsed
  error envelope fields).
- ``WigoloConnectionError`` wraps transport-level failures (connection
  refused, DNS, socket timeout) that never produced an HTTP response.
"""

from __future__ import annotations

from typing import Optional


class WigoloError(Exception):
    """Base class for all errors raised by this SDK."""


class WigoloAPIError(WigoloError):
    """A non-2xx HTTP response from the wigolo REST API.

    ``error``/``error_reason``/``stage`` come from the server's error
    envelope when present. ``retry_after`` is parsed from the
    ``Retry-After`` header (seconds) when the server sends one — set on
    429 responses.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int,
        error: Optional[str] = None,
        error_reason: Optional[str] = None,
        stage: Optional[str] = None,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.error = error
        self.error_reason = error_reason
        self.stage = stage
        self.retry_after = retry_after


class WigoloConnectionError(WigoloError):
    """A transport-level failure that produced no HTTP response.

    Most commonly a refused connection. For zero-setup local use, route
    through ``wigolo.local_client()`` which starts a local daemon for you.
    """
