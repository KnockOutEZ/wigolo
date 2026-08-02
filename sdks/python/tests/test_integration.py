"""Integration tests against a real spawned dist serve.

Matrix: open mode + token mode, parametrized over Client and AsyncClient.
Shared warmed tmp data dir, ephemeral ports.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import shutil
import tempfile
from pathlib import Path
from typing import Any

import pytest

from conftest import spawn_serve
from wigolo import AsyncClient, Client, WigoloAPIError, WigoloConnectionError


def _fresh_data_dir(seed_from: str) -> str:
    """A private data dir with its own SQLite DB but sharing the warmed ML
    model dirs (symlinked, read-only reuse) so no server re-downloads models
    and no two servers share a cache DB."""
    d = tempfile.mkdtemp(prefix="wigolo-sdk-standalone-")
    for sub in ("fastembed", "transformers"):
        src = Path(seed_from) / sub
        if src.is_dir():
            try:
                (Path(d) / sub).symlink_to(src, target_is_directory=True)
            except Exception:
                try:
                    shutil.copytree(src, Path(d) / sub, dirs_exist_ok=True)
                except Exception:
                    pass
    return d


# ---- server fixtures (module-scoped, one spawn per mode) -------------------


@pytest.fixture(scope="module")
def open_server(shared_data_dir):
    # A private data dir (seeded with the shared warmed ML models) so this
    # server never shares a SQLite DB with another live server process.
    data_dir = _fresh_data_dir(shared_data_dir)
    h = spawn_serve(data_dir)
    try:
        yield h
    finally:
        h.stop()
        shutil.rmtree(data_dir, ignore_errors=True)


@pytest.fixture(scope="module")
def token_server(shared_data_dir):
    # A private data dir so this server never contends on SQLite with the
    # open-mode server (both are module-scoped and can be alive at once).
    data_dir = _fresh_data_dir(shared_data_dir)
    h = spawn_serve(data_dir, token="test-bearer-tok")
    try:
        yield h
    finally:
        h.stop()
        shutil.rmtree(data_dir, ignore_errors=True)


# ---- an adapter so we can drive sync + async through one test body ---------


class _SyncAdapter:
    kind = "sync"

    def __init__(self, base_url: str, token: str | None):
        self.c = Client(base_url=base_url, token=token)

    def call(self, method: str, **kw: Any) -> Any:
        return getattr(self.c, method)(**kw)

    def close(self) -> None:
        self.c.close()


class _AsyncAdapter:
    kind = "async"

    def __init__(self, base_url: str, token: str | None):
        self.c = AsyncClient(base_url=base_url, token=token)

    def call(self, method: str, **kw: Any) -> Any:
        return asyncio.run(getattr(self.c, method)(**kw))

    def close(self) -> None:
        self.c.close()


ADAPTERS = [_SyncAdapter, _AsyncAdapter]
ADAPTER_IDS = ["sync", "async"]


# A client fixture that spans BOTH modes (open + token) and BOTH transports
# (sync + async) so the full 10-tool matrix runs through the bearer-gated
# server too, not just open mode (TC-1).
@pytest.fixture(
    params=[
        (adapter, mode)
        for mode in ("open", "token")
        for adapter in ADAPTERS
    ],
    ids=[
        f"{mode}-{aid}"
        for mode in ("open", "token")
        for aid in ADAPTER_IDS
    ],
)
def any_client(request, open_server, token_server):
    adapter, mode = request.param
    if mode == "open":
        a = adapter(open_server.base_url, None)
    else:
        a = adapter(token_server.base_url, token_server.token)
    yield a
    a.close()


# ---- all 10 tools succeed (open + token mode) ------------------------------


def test_search(any_client):
    res = any_client.call("search", query="wigolo test", max_results=3)
    assert isinstance(res, dict)
    assert "results" in res or "evidence" in res


def test_fetch(any_client):
    res = any_client.call("fetch", url="https://example.com")
    assert isinstance(res, dict)
    assert "markdown" in res or "error" in res


def test_crawl_map(any_client):
    res = any_client.call(
        "crawl", url="https://example.com", strategy="map", max_pages=3
    )
    assert "urls" in res
    assert "pages" not in res


def test_cache_stats(any_client):
    res = any_client.call("cache", stats=True)
    assert "stats" in res


def test_extract_tables(any_client):
    html = "<table><tr><th>a</th></tr><tr><td>1</td></tr></table>"
    res = any_client.call("extract", html=html, mode="tables")
    assert "data" in res


def test_find_similar(any_client):
    res = any_client.call("find_similar", concept="web scraping", include_web=False)
    assert isinstance(res, dict)
    assert "results" in res or "method" in res


def test_research(any_client):
    res = any_client.call(
        "research", question="what is example.com", depth="quick", max_sources=2
    )
    assert isinstance(res, dict)
    assert "report" in res or "brief" in res or "sources" in res


def test_agent(any_client):
    res = any_client.call(
        "agent",
        prompt="summarize",
        urls=["https://example.com"],
        max_pages=1,
        max_time_ms=15000,
    )
    assert isinstance(res, dict)
    assert "result" in res or "sources" in res or "warning" in res


def test_diff(any_client):
    res = any_client.call(
        "diff", old={"markdown": "a"}, new={"markdown": "b"}, output="summary"
    )
    assert "changed" in res


def test_watch_list(any_client):
    res = any_client.call("watch", action="list")
    assert "jobs" in res or "job" in res or "notice" in res


# ---- token mode ------------------------------------------------------------


def test_token_mode_without_client_token_401(token_server):
    # A client with NO token against a token-required server.
    c = Client(base_url=token_server.base_url)
    with pytest.raises(WigoloAPIError) as ei:
        c.cache(stats=True)
    assert ei.value.status == 401
    c.close()


# ---- negatives -------------------------------------------------------------


def test_429_retry_after(shared_data_dir):
    data_dir = _fresh_data_dir(shared_data_dir)
    h = spawn_serve(data_dir, extra_env={"WIGOLO_SERVE_MAX_CONCURRENCY": "1"})
    try:
        c1 = Client(base_url=h.base_url)
        c2 = Client(base_url=h.base_url)
        statuses: list[int] = []
        retry_afters: list[int | None] = []

        def do_search(c):
            try:
                # A slow-ish call so both are in flight simultaneously.
                c.research(question="what is a large language model", depth="quick")
                return None
            except WigoloAPIError as e:
                return e

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
            futs = [ex.submit(do_search, c1), ex.submit(do_search, c2)]
            errs = [f.result() for f in futs]
        got_429 = [e for e in errs if isinstance(e, WigoloAPIError) and e.status == 429]
        assert got_429, f"expected a 429, got {errs}"
        assert got_429[0].retry_after == 5
        c1.close()
        c2.close()
    finally:
        h.stop()
        shutil.rmtree(data_dir, ignore_errors=True)


def test_413_oversized_body(open_server):
    c = Client(base_url=open_server.base_url)
    # The default per-route body cap is 1 MiB (diff/extract get a larger cap,
    # so target a default-cap route like search). Overshoot the 1 MiB cap.
    big = "x" * (1024 * 1024 + 4096)  # > 1 MiB
    # 413 may surface as a typed error OR as a connection error due to the
    # documented send/receive deadlock (server pauses the stream). Small
    # timeout so the deadlock arm does not block for minutes.
    with pytest.raises((WigoloAPIError, WigoloConnectionError)) as ei:
        c.search(query=big, timeout=5)
    if isinstance(ei.value, WigoloAPIError):
        assert ei.value.status == 413
    c.close()


def test_400_query_clamp(open_server):
    c = Client(base_url=open_server.base_url)
    # A query list of 11 exceeds the allowed multi-query count.
    with pytest.raises(WigoloAPIError) as ei:
        c.search(query=[f"q{i}" for i in range(11)])
    assert ei.value.status == 400
    c.close()
