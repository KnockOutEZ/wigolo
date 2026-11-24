"""wigolo — thin Python client for the local-first web intelligence REST API.

Exposes a synchronous ``Client``, an ``AsyncClient``, and ``local_client``
for zero-setup embedded use. This is a thin transport: no retries, no
re-ranking, no interpretation, no caching — the wigolo server does all of
that.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError as _PackageNotFoundError
from importlib.metadata import version as _dist_version

from ._aio import AsyncClient
from ._client import Client
from ._errors import WigoloAPIError, WigoloConnectionError, WigoloError
from ._local import local_client

try:
    __version__ = _dist_version("wigolo")
except _PackageNotFoundError:  # imported from a source tree, not installed
    __version__ = "0.0.0+unknown"

__all__ = [
    "Client",
    "AsyncClient",
    "local_client",
    "WigoloError",
    "WigoloAPIError",
    "WigoloConnectionError",
    "__version__",
]
