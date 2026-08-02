"""Unit tests for the crewai-free core. No crewai import here."""

from __future__ import annotations

import json

import pytest

from wigolo import WigoloAPIError

from wigolo_crewai import _core


# --- argument mapping: the SDK method is called with the mapped kwargs -------


def test_run_search_maps_args_and_returns_json(mock_client):
    out = _core.run_search(
        mock_client,
        "python asyncio",
        max_results=3,
        include_domains=["docs.python.org"],
        category="docs",
    )
    mock_client.search.assert_called_once()
    _, kwargs = mock_client.search.call_args
    assert kwargs["query"] == "python asyncio"
    assert kwargs["max_results"] == 3
    assert kwargs["include_domains"] == ["docs.python.org"]
    assert kwargs["category"] == "docs"
    # WHY: the tool contract is a JSON *string* so CrewAI can hand it to the LLM.
    parsed = json.loads(out)
    assert parsed["query"] == "test"
    assert parsed["results"][0]["url"] == "https://example.com"


def test_run_search_drops_none_so_sdk_defaults_apply(mock_client):
    _core.run_search(mock_client, "q")
    _, kwargs = mock_client.search.call_args
    # WHY: passing time_range=None would override the server default; it must be dropped.
    assert "time_range" not in kwargs
    assert "include_domains" not in kwargs


def test_run_fetch_maps_args(mock_client):
    out = _core.run_fetch(
        mock_client, "https://example.com", render_js=True, section="Install"
    )
    _, kwargs = mock_client.fetch.call_args
    assert kwargs["url"] == "https://example.com"
    assert kwargs["render_js"] is True
    assert kwargs["section"] == "Install"
    assert json.loads(out)["title"] == "Example"


def test_run_research_maps_args(mock_client):
    out = _core.run_research(
        mock_client, "compare X vs Y", depth="comprehensive", max_sources=8
    )
    _, kwargs = mock_client.research.call_args
    assert kwargs["question"] == "compare X vs Y"
    assert kwargs["depth"] == "comprehensive"
    assert kwargs["max_sources"] == 8
    assert "brief" in json.loads(out)


def test_run_crawl_maps_args(mock_client):
    out = _core.run_crawl(
        mock_client, "https://docs.site", strategy="sitemap", max_pages=50
    )
    _, kwargs = mock_client.crawl.call_args
    assert kwargs["url"] == "https://docs.site"
    assert kwargs["strategy"] == "sitemap"
    assert kwargs["max_pages"] == 50
    assert json.loads(out)["count"] == 1


def test_run_extract_maps_args(mock_client):
    out = _core.run_extract(
        mock_client, "https://example.com", mode="tables"
    )
    _, kwargs = mock_client.extract.call_args
    assert kwargs["url"] == "https://example.com"
    assert kwargs["mode"] == "tables"
    assert "tables" in json.loads(out)


# --- error mapping: WigoloError becomes a clean string, not an exception -----


@pytest.mark.parametrize(
    "runner, method, args",
    [
        (_core.run_search, "search", ("q",)),
        (_core.run_fetch, "fetch", ("https://x",)),
        (_core.run_research, "research", ("q",)),
        (_core.run_crawl, "crawl", ("https://x",)),
        (_core.run_extract, "extract", ("https://x",)),
    ],
)
def test_wigolo_error_becomes_clean_json_string(mock_client, runner, method, args):
    getattr(mock_client, method).side_effect = WigoloAPIError(
        "boom", status=500
    )
    # WHY: an LLM tool must never raise into the agent loop; it returns an error string.
    out = runner(mock_client, *args)
    parsed = json.loads(out)
    assert "error" in parsed
    assert method in parsed["error"]
    # WHY: don't leak internals/stack traces to the model.
    assert "Traceback" not in out


def test_build_client_constructs_wigolo_client(monkeypatch):
    captured = {}

    class FakeClient:
        def __init__(self, **kw):
            captured.update(kw)

    monkeypatch.setattr(_core, "Client", FakeClient)
    _core.build_client(base_url="http://127.0.0.1:9999", token="t", local=False)
    assert captured == {
        "base_url": "http://127.0.0.1:9999",
        "token": "t",
        "local": False,
    }
