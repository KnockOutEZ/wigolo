"""Embedded local-mode integration tests against the real dist serve.

- cold: a free port spawns a real server (WIGOLO_CLI -> node dist), owned;
  close() kills it within the escalation bound.
- warm: a pre-started server is reused (owned=False); close() leaves it up.
- close-during-in-flight: close() completes within the escalation window
  even while a request is in flight, proving terminate->kill escalation.
"""

from __future__ import annotations

import json
import socket
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from conftest import DIST_INDEX, spawn_serve
from wigolo import Client, local_client


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _health_code(base_url: str, timeout: float = 1.0):
    try:
        with urllib.request.urlopen(f"{base_url}/health", timeout=timeout) as r:
            return r.getcode()
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


@pytest.fixture()
def dist_cli(monkeypatch, shared_data_dir):
    # Route the embedded spawn at the worktree dist server, with a warmed
    # private data dir so models are not re-downloaded.
    import shutil
    import tempfile
    from pathlib import Path

    d = tempfile.mkdtemp(prefix="wigolo-sdk-embed-")
    for sub in ("fastembed", "transformers"):
        src = Path(shared_data_dir) / sub
        if src.is_dir():
            try:
                (Path(d) / sub).symlink_to(src, target_is_directory=True)
            except Exception:
                pass
    monkeypatch.setenv("WIGOLO_DATA_DIR", d)
    monkeypatch.setenv("WIGOLO_CLI", json.dumps(["node", str(DIST_INDEX)]))
    yield
    shutil.rmtree(d, ignore_errors=True)


def test_cold_spawn_owned_and_close_kills(dist_cli):
    port = _free_port()
    c = local_client(port=port)
    try:
        assert c._daemon is not None and c._daemon.owned is True
        assert c._base_url == f"http://127.0.0.1:{port}"
        # It works end to end.
        res = c.cache(stats=True)
        assert "stats" in res
    finally:
        t0 = time.monotonic()
        c.close()
        elapsed = time.monotonic() - t0
    # Escalation bound is ~5s terminate then kill; a healthy idle server exits
    # on SIGTERM quickly.
    assert elapsed < 8.0
    # Port is free again.
    time.sleep(0.5)
    assert _health_code(f"http://127.0.0.1:{port}") is None


def test_warm_reuse_leaves_running(dist_cli, shared_data_dir):
    port = _free_port()
    # Pre-start a real server on the port (not via the SDK) sharing the same
    # data dir env the fixture set.
    import os

    handle = spawn_serve(os.environ["WIGOLO_DATA_DIR"], port=port)
    try:
        c = Client(local=True, port=port)
        # Reused, not owned.
        assert c._daemon is not None and c._daemon.owned is False
        res = c.cache(stats=True)
        assert "stats" in res
        # Closing a not-owned client must leave the daemon running.
        c.close()
        time.sleep(0.3)
        assert _health_code(handle.base_url) == 200
    finally:
        handle.stop()


def test_close_during_in_flight_escalates(dist_cli):
    port = _free_port()
    c = local_client(port=port)

    # Stand up a slow local HTTP target on loopback; the daemon fetching it
    # keeps a request in flight while we close(). Loopback targets are allowed
    # on a loopback bind.
    slow_started = threading.Event()

    def _make_slow():
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def do_GET(self) -> None:
                slow_started.set()
                time.sleep(20)
                body = b"<html><body>slow ok</body></html>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except Exception:
                    pass

        return H

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _make_slow())
    slow_port = httpd.server_address[1]
    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()

    # Fire a fetch of the slow loopback target on a background thread so it is
    # in flight when we close().
    def _fetch():
        try:
            c.fetch(url=f"http://127.0.0.1:{slow_port}/", timeout=30)
        except Exception:
            pass

    fetch_thread = threading.Thread(target=_fetch, daemon=True)
    fetch_thread.start()

    try:
        # Wait until the daemon has reached our slow target.
        assert slow_started.wait(timeout=15), "slow target never hit"
        time.sleep(0.5)  # ensure the daemon is mid-request
        t0 = time.monotonic()
        c.close()
        elapsed = time.monotonic() - t0
        # Graceful shutdown awaits open connections; escalation (terminate then
        # kill after ~5s) guarantees close() returns in a bounded window rather
        # than hanging for the full 20s slow response.
        assert elapsed < 12.0, f"close() took {elapsed:.1f}s — escalation failed"
        time.sleep(0.5)
        assert _health_code(f"http://127.0.0.1:{port}") is None
    finally:
        httpd.shutdown()
        httpd.server_close()
