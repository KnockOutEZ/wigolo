"""A tiny fake wigolo server for local-mode unit tests.

Usage mirrors the real CLI shape so the SDK's spawn path exercises the
same argv handling:

    python _fake_serve.py serve --port N --host 127.0.0.1

Behavior is controlled by env vars:
    FAKE_TOOLS_STATUS   HTTP status for /v1/tools (default 200)
    FAKE_HEALTH_STATUS  HTTP status for /health (default 200)
    FAKE_STARTUP_DELAY  seconds to wait before binding (default 0)
    FAKE_EXIT_IMMEDIATELY  if "1", print to stderr and exit 3 without binding
"""

from __future__ import annotations

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _parse_port(argv: list[str]) -> int:
    for i, a in enumerate(argv):
        if a == "--port" and i + 1 < len(argv):
            return int(argv[i + 1])
    return 3333


def main() -> int:
    argv = sys.argv[1:]
    if os.environ.get("FAKE_EXIT_IMMEDIATELY") == "1":
        # Echo the token to stderr so the SDK's redaction path is exercised:
        # the surfaced error tail must NOT leak this value.
        tok = os.environ.get("WIGOLO_API_TOKEN", "")
        sys.stderr.write(
            f"fake serve: refusing to start (test-configured exit) token={tok}\n"
        )
        sys.stderr.flush()
        return 3

    delay = float(os.environ.get("FAKE_STARTUP_DELAY", "0"))
    if delay:
        time.sleep(delay)

    port = _parse_port(argv)
    health_status = int(os.environ.get("FAKE_HEALTH_STATUS", "200"))
    tools_status = int(os.environ.get("FAKE_TOOLS_STATUS", "200"))
    token = os.environ.get("WIGOLO_API_TOKEN")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status: int, obj) -> None:
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self._send(health_status, {"status": "healthy" if health_status == 200 else "down"})
                return
            if self.path == "/v1/tools":
                # Emulate bearer gate: if server has a token, require a match.
                if token:
                    auth = self.headers.get("Authorization", "")
                    if auth != f"Bearer {token}":
                        self._send(401, {"ok": False, "error": "unauthorized"})
                        return
                if tools_status != 200:
                    self._send(tools_status, {"ok": False, "error": "n/a"})
                    return
                self._send(200, [{"name": "search"}])
                return
            self._send(404, {"ok": False, "error": "not found"})

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        sys.stderr.write(f"fake serve: bind failed on {port}: {exc}\n")
        sys.stderr.flush()
        return 4
    sys.stderr.write(f"fake serve: listening on {port}\n")
    sys.stderr.flush()
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
