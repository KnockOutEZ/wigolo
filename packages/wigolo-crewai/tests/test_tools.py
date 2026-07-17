"""CrewAI adapter tests.

Gated on crewai being installed. This is a legitimate dependency gate, NOT a
silent skip of core logic — all real behaviour is covered in test_core.py.
When crewai is absent these skip with a visible reason.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

crewai = pytest.importorskip("crewai", reason="crewai not installed")

from wigolo_crewai import tools  # noqa: E402
from wigolo_crewai.types import (  # noqa: E402
    CrawlInput,
    ExtractInput,
    FetchInput,
    ResearchInput,
    SearchInput,
)

_TOOL_CASES = [
    (tools.WigoloSearchTool, "wigolo_search", SearchInput),
    (tools.WigoloFetchTool, "wigolo_fetch", FetchInput),
    (tools.WigoloResearchTool, "wigolo_research", ResearchInput),
    (tools.WigoloCrawlTool, "wigolo_crawl", CrawlInput),
    (tools.WigoloExtractTool, "wigolo_extract", ExtractInput),
]


@pytest.mark.parametrize("cls, name, schema", _TOOL_CASES)
def test_tool_instantiates_with_expected_metadata(cls, name, schema, mock_client):
    tool = cls(client=mock_client)
    assert tool.name == name
    assert tool.description
    assert tool.args_schema is schema


def test_search_tool_delegates_to_core(mock_client):
    tool = tools.WigoloSearchTool(client=mock_client)
    out = tool._run(query="python", max_results=3)
    mock_client.search.assert_called_once()
    _, kwargs = mock_client.search.call_args
    assert kwargs["query"] == "python"
    assert kwargs["max_results"] == 3
    assert json.loads(out)["query"] == "test"


def test_fetch_tool_delegates_to_core(mock_client):
    tool = tools.WigoloFetchTool(client=mock_client)
    tool._run(url="https://example.com", render_js=True)
    _, kwargs = mock_client.fetch.call_args
    assert kwargs["url"] == "https://example.com"
    assert kwargs["render_js"] is True


def test_wigolo_tools_factory_returns_five_sharing_one_client(monkeypatch):
    sentinel = MagicMock()
    monkeypatch.setattr(tools._core, "build_client", lambda **kw: sentinel)
    built = tools.wigolo_tools(local=True)
    assert len(built) == 5
    assert {t.name for t in built} == {
        "wigolo_search",
        "wigolo_fetch",
        "wigolo_research",
        "wigolo_crawl",
        "wigolo_extract",
    }
    # WHY: all five must share the single constructed client (one daemon).
    assert all(t.client is sentinel for t in built)
