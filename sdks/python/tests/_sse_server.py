"""A localhost event-stream server that can hang up mid-frame.

The resume contract is a property of two connections, not of one parser, so it is pinned here
against a REAL socket: connection 1 writes some frames and closes, connection 2 sees the
``Last-Event-ID`` the client chose. Faking the transport instead would let a broken client
agree with a broken fake.

Each entry in ``script`` is one connection's worth of raw text; the server writes it and closes.
``requests`` records the headers of every connection so a test can assert what was asked for.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional


class SseTestServer:
    def __init__(self, script: list[str], *, status: int = 200) -> None:
        self.script = script
        self.status = status
        self.requests: list[dict[str, str]] = []
        self._index = 0
        self._lock = threading.Lock()
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    @property
    def base_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://127.0.0.1:{port}"

    @property
    def connection_count(self) -> int:
        with self._lock:
            return self._index

    def _next_body(self) -> str:
        with self._lock:
            body = self.script[self._index] if self._index < len(self.script) else ""
            self._index += 1
            return body

    def __enter__(self) -> "SseTestServer":
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
                with outer._lock:
                    outer.requests.append(
                        {k.lower(): v for k, v in self.headers.items()} | {"path": self.path}
                    )
                if outer.status != 200:
                    payload = b'{"ok":false,"error":"nope","error_reason":"not_found"}'
                    self.send_response(outer.status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                body = outer._next_body().encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                # No Content-Length and no chunking: the close IS the end of the body, which is
                # exactly the shape a dropped stream has.
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
                self.close_connection = True

            def log_message(self, *args: object) -> None:
                pass  # keep the suite's output clean

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
