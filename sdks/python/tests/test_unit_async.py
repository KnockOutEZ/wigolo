"""Async client unit tests: dispatch and cancellation semantics."""

from __future__ import annotations

import asyncio
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from wigolo import AsyncClient


def _make_slow_handler(delay: float, started: threading.Event):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def do_POST(self) -> None:
            started.set()
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length:
                self.rfile.read(length)
            time.sleep(delay)
            body = b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


@pytest.fixture()
def slow_server():
    started = threading.Event()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _make_slow_handler(3.0, started))
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}", started
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_async_cancellation_returns_promptly(slow_server):
    base_url, started = slow_server

    async def run() -> float:
        c = AsyncClient(base_url=base_url, max_workers=2)
        task = asyncio.ensure_future(c.search(query="x", timeout=30))
        # Wait until the request is in flight.
        for _ in range(200):
            if started.is_set():
                break
            await asyncio.sleep(0.01)
        assert started.is_set()
        t0 = time.monotonic()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        elapsed = time.monotonic() - t0
        # Do not wait for the executor thread to finish (it lingers ~3s).
        return elapsed

    elapsed = asyncio.run(run())
    # Cancel should return well before the 3s server delay.
    assert elapsed < 1.0


def test_async_basic_dispatch(slow_server):
    # Use a fast path: short delay server not needed; just prove awaitable works.
    async def run():
        # point at a non-listening port to get a prompt connection error
        from wigolo import WigoloConnectionError

        c = AsyncClient(base_url="http://127.0.0.1:1")
        with pytest.raises(WigoloConnectionError):
            await c.search(query="x", timeout=2)
        await c.aclose()

    asyncio.run(run())
