"""Unit tests for the sync client transport, using a tiny local HTTP server.

We stand up a minimal http.server that records requests and returns
scripted responses. This exercises the real urllib code path (headers,
error mapping, body parsing) without touching the wigolo server.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

import pytest

from wigolo import Client, WigoloAPIError, WigoloConnectionError
from wigolo._manifest import MANIFEST


class _State:
    def __init__(self) -> None:
        self.last_headers: dict[str, str] = {}
        self.last_body: Optional[dict[str, Any]] = None
        self.last_path: Optional[str] = None
        # scripted response: (status, body_obj_or_str, extra_headers)
        self.status = 200
        self.body: Any = {"ok": True}
        self.extra_headers: dict[str, str] = {}


def _make_handler(state: _State):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def _respond(self) -> None:
            state.last_headers = {k: v for k, v in self.headers.items()}
            state.last_path = self.path
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b""
            if raw:
                try:
                    state.last_body = json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError:
                    state.last_body = None
            else:
                state.last_body = None
            payload = state.body
            if isinstance(payload, (dict, list)):
                data = json.dumps(payload).encode("utf-8")
            else:
                data = str(payload).encode("utf-8")
            self.send_response(state.status)
            self.send_header("Content-Type", "application/json")
            for k, v in state.extra_headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            self._respond()

        def do_POST(self) -> None:
            self._respond()

    return Handler


@pytest.fixture()
def server():
    state = _State()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(state))
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base_url = f"http://127.0.0.1:{port}"
    try:
        yield base_url, state
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_auth_header_present_when_token(server):
    base_url, state = server
    c = Client(base_url=base_url, token="secret-tok")
    state.body = {"results": []}
    c.search(query="x")
    assert state.last_headers.get("Authorization") == "Bearer secret-tok"


def test_auth_header_absent_when_no_token(server):
    base_url, state = server
    c = Client(base_url=base_url)
    state.body = {"results": []}
    c.search(query="x")
    assert "Authorization" not in state.last_headers


def test_none_values_omitted_from_body(server):
    base_url, state = server
    c = Client(base_url=base_url)
    state.body = {"results": []}
    c.search(query="hello", max_results=3)
    assert state.last_body == {"query": "hello", "max_results": 3}


def test_error_mapping_with_envelope(server):
    base_url, state = server
    c = Client(base_url=base_url)
    state.status = 400
    state.body = {
        "ok": False,
        "error": "bad request",
        "error_reason": "validation",
        "stage": "input",
    }
    with pytest.raises(WigoloAPIError) as ei:
        c.search(query="x")
    err = ei.value
    assert err.status == 400
    assert err.error == "bad request"
    assert err.error_reason == "validation"
    assert err.stage == "input"


def test_error_mapping_retry_after_header(server):
    base_url, state = server
    c = Client(base_url=base_url)
    state.status = 429
    state.body = {"ok": False, "error": "rate limited"}
    state.extra_headers = {"Retry-After": "5"}
    with pytest.raises(WigoloAPIError) as ei:
        c.search(query="x")
    assert ei.value.status == 429
    assert ei.value.retry_after == 5


def test_error_mapping_unparseable_body(server):
    base_url, state = server
    c = Client(base_url=base_url)
    state.status = 500
    state.body = "<html>internal error</html>"
    with pytest.raises(WigoloAPIError) as ei:
        c.search(query="x")
    assert ei.value.status == 500
    assert "internal error" in str(ei.value)
    # No envelope -> error field stays None.
    assert ei.value.error is None


def test_200_with_warning_returned_not_raised(server):
    base_url, state = server
    c = Client(base_url=base_url)
    state.status = 200
    state.body = {"results": [], "warning": "degraded", "error": "partial failure"}
    res = c.search(query="x")
    assert res["warning"] == "degraded"
    assert res["error"] == "partial failure"


def test_connection_refused_names_local_client():
    # Nothing listening on this port.
    c = Client(base_url="http://127.0.0.1:1")
    with pytest.raises(WigoloConnectionError) as ei:
        c.search(query="x", timeout=2)
    assert "local_client()" in str(ei.value)


def test_per_tool_default_timeouts(server, monkeypatch):
    base_url, state = server
    c = Client(base_url=base_url)
    captured: dict[str, float] = {}
    orig = c._request

    def spy(method, path, *, body=None, timeout=None):
        captured["timeout"] = timeout
        return orig(method, path, body=body, timeout=timeout)

    monkeypatch.setattr(c, "_request", spy)
    for tool, spec in MANIFEST.items():
        state.body = {}
        # minimal required params
        kwargs = {}
        for req in spec["required"]:
            kwargs[req] = "x"
        getattr(c, tool)(**kwargs)
        assert captured["timeout"] == float(spec["default_timeout_s"]), tool


def test_per_call_timeout_overrides_default(server, monkeypatch):
    base_url, state = server
    c = Client(base_url=base_url, timeout=99)
    captured: dict[str, float] = {}
    orig = c._request

    def spy(method, path, *, body=None, timeout=None):
        captured["timeout"] = timeout
        return orig(method, path, body=body, timeout=timeout)

    monkeypatch.setattr(c, "_request", spy)
    state.body = {}
    c.search(query="x", timeout=7)
    assert captured["timeout"] == 7


def test_client_timeout_overrides_manifest_default(server, monkeypatch):
    base_url, state = server
    c = Client(base_url=base_url, timeout=42)
    captured: dict[str, float] = {}
    orig = c._request

    def spy(method, path, *, body=None, timeout=None):
        captured["timeout"] = timeout
        return orig(method, path, body=body, timeout=timeout)

    monkeypatch.setattr(c, "_request", spy)
    state.body = {}
    c.search(query="x")
    assert captured["timeout"] == 42


def test_health_returns_verbatim(server):
    base_url, state = server
    c = Client(base_url=base_url)
    state.body = {"status": "healthy", "searxng": "not_configured"}
    res = c.health()
    assert res["status"] == "healthy"


def test_health_503_returns_report_not_raised(server):
    # The contract: a degraded daemon answers /health with 503 carrying the
    # SAME report body. health() must return it, not raise — the docstring
    # promises the report, so this pins the CR-2 special-case.
    base_url, state = server
    c = Client(base_url=base_url)
    state.status = 503
    state.body = {"status": "down", "searxng": "unavailable"}
    res = c.health()
    assert res["status"] == "down"
    assert res["searxng"] == "unavailable"


def test_health_non_503_error_still_raises(server):
    # A non-503 error on /health is a real failure and must still raise.
    base_url, state = server
    c = Client(base_url=base_url)
    state.status = 500
    state.body = {"status": "boom"}
    with pytest.raises(WigoloAPIError) as ei:
        c.health()
    assert ei.value.status == 500


def test_non_json_2xx_raises_connection_error(server):
    # The REST contract is JSON-only: a 2xx with a non-JSON body means we are
    # not talking to a wigolo daemon (CR-10). Must raise, not return raw text.
    base_url, state = server
    c = Client(base_url=base_url)
    state.status = 200
    state.body = "<html>not a daemon</html>"
    with pytest.raises(WigoloConnectionError) as ei:
        c.search(query="x")
    assert "non-JSON" in str(ei.value)


def test_crawl_map_response_verbatim(server):
    base_url, state = server
    c = Client(base_url=base_url)
    state.body = {"urls": ["a", "b"], "total_found": 2, "crawled": 0}
    res = c.crawl(url="https://example.com", strategy="map")
    assert "urls" in res and "pages" not in res


def test_loopback_bypasses_ambient_http_proxy(server, monkeypatch):
    # With http_proxy pointing at a dead address and no_proxy UNSET, the default
    # urllib opener would route loopback traffic through the (dead) proxy and
    # fail. The client MUST bypass the proxy for 127.0.0.1 targets (CR-3).
    base_url, state = server
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9")  # dead proxy
    monkeypatch.setenv("https_proxy", "http://127.0.0.1:9")
    monkeypatch.delenv("no_proxy", raising=False)
    monkeypatch.delenv("NO_PROXY", raising=False)
    c = Client(base_url=base_url)
    state.body = {"results": []}
    # Would raise a connection error if routed through the dead proxy.
    res = c.search(query="x")
    assert res == {"results": []}
