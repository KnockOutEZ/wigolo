"""Unit tests for WigoloSearchTool and WigoloFetchTool."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from langchain_wigolo.tools import WigoloSearchTool, WigoloFetchTool
from langchain_wigolo.types import SearchInput, FetchInput
from langchain_wigolo.client import WigoloMcpClient


def _make_search_output(query: str = "test", n_results: int = 1) -> dict:
    return {
        "results": [
            {
                "title": f"Result {i}",
                "url": f"https://example.com/{i}",
                "snippet": f"Snippet {i}",
                "markdown_content": f"# Result {i}\nContent.",
                "relevance_score": 0.9 - i * 0.1,
            }
            for i in range(n_results)
        ],
        "query": query,
        "engines_used": ["duckduckgo"],
        "total_time_ms": 500,
    }


def _make_fetch_output(url: str = "https://example.com") -> dict:
    return {
        "url": url,
        "title": "Example Page",
        "markdown": "# Example\nFull page content.",
        "metadata": {"description": "An example"},
        "links": ["https://example.com/other"],
        "images": [],
        "cached": False,
    }


class TestWigoloSearchToolConfig:
    """Test search tool configuration."""

    def test_name_is_wigolo_search(self):
        tool = WigoloSearchTool(client=MagicMock())
        assert tool.name == "wigolo_search"

    def test_description_is_nonempty(self):
        tool = WigoloSearchTool(client=MagicMock())
        assert len(tool.description) > 20

    def test_args_schema_is_search_input(self):
        tool = WigoloSearchTool(client=MagicMock())
        assert tool.args_schema == SearchInput


class TestWigoloSearchToolRun:
    """Test search tool execution."""

    @pytest.mark.asyncio
    async def test_arun_returns_json_string(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_output())

        tool = WigoloSearchTool(client=mock_client)
        result = await tool.ainvoke({"query": "test"})

        parsed = json.loads(result)
        assert "results" in parsed
        assert len(parsed["results"]) == 1

    @pytest.mark.asyncio
    async def test_arun_passes_all_parameters(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_output())

        tool = WigoloSearchTool(client=mock_client)
        await tool.ainvoke({
            "query": "react hooks",
            "max_results": 3,
            "include_domains": ["react.dev"],
            "category": "docs",
        })

        call_args = mock_client.call_tool.call_args[0]
        assert call_args[0] == "search"
        params = call_args[1]
        assert params["query"] == "react hooks"
        assert params["max_results"] == 3
        assert params["include_domains"] == ["react.dev"]
        assert params["category"] == "docs"

    @pytest.mark.asyncio
    async def test_arun_with_error_returns_error_json(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(
            return_value={"error": "Search failed", "results": [], "query": "test", "engines_used": [], "total_time_ms": 0}
        )

        tool = WigoloSearchTool(client=mock_client)
        result = await tool.ainvoke({"query": "test"})

        parsed = json.loads(result)
        assert "error" in parsed

    @pytest.mark.asyncio
    async def test_arun_with_client_exception_returns_error(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(side_effect=Exception("Connection lost"))

        tool = WigoloSearchTool(client=mock_client)
        result = await tool.ainvoke({"query": "test"})

        parsed = json.loads(result)
        assert "error" in parsed
        assert "Connection lost" in parsed["error"]

    @pytest.mark.asyncio
    async def test_arun_with_empty_query(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_output("", 0))

        tool = WigoloSearchTool(client=mock_client)
        result = await tool.ainvoke({"query": ""})

        parsed = json.loads(result)
        assert parsed["results"] == []


class TestWigoloFetchToolConfig:
    """Test fetch tool configuration."""

    def test_name_is_wigolo_fetch(self):
        tool = WigoloFetchTool(client=MagicMock())
        assert tool.name == "wigolo_fetch"

    def test_description_is_nonempty(self):
        tool = WigoloFetchTool(client=MagicMock())
        assert len(tool.description) > 20

    def test_args_schema_is_fetch_input(self):
        tool = WigoloFetchTool(client=MagicMock())
        assert tool.args_schema == FetchInput


class TestWigoloFetchToolRun:
    """Test fetch tool execution."""

    @pytest.mark.asyncio
    async def test_arun_returns_json_string(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_fetch_output())

        tool = WigoloFetchTool(client=mock_client)
        result = await tool.ainvoke({"url": "https://example.com"})

        parsed = json.loads(result)
        assert parsed["title"] == "Example Page"
        assert "# Example" in parsed["markdown"]

    @pytest.mark.asyncio
    async def test_arun_passes_section_parameter(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_fetch_output())

        tool = WigoloFetchTool(client=mock_client)
        await tool.ainvoke({"url": "https://example.com", "section": "API"})

        call_args = mock_client.call_tool.call_args[0]
        assert call_args[0] == "fetch"
        assert call_args[1]["section"] == "API"

    @pytest.mark.asyncio
    async def test_arun_passes_render_js_parameter(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_fetch_output())

        tool = WigoloFetchTool(client=mock_client)
        await tool.ainvoke({"url": "https://example.com", "render_js": "always"})

        call_args = mock_client.call_tool.call_args[0]
        assert call_args[1]["render_js"] == "always"

    @pytest.mark.asyncio
    async def test_arun_with_client_exception_returns_error(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(side_effect=Exception("Timeout"))

        tool = WigoloFetchTool(client=mock_client)
        result = await tool.ainvoke({"url": "https://example.com"})

        parsed = json.loads(result)
        assert "error" in parsed
        assert "Timeout" in parsed["error"]

    @pytest.mark.asyncio
    async def test_arun_with_error_response(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(
            return_value={"error": "404 Not Found", "url": "https://example.com", "title": "", "markdown": "", "metadata": {}, "links": [], "images": [], "cached": False}
        )

        tool = WigoloFetchTool(client=mock_client)
        result = await tool.ainvoke({"url": "https://example.com"})

        parsed = json.loads(result)
        assert "error" in parsed

    @pytest.mark.asyncio
    async def test_arun_with_auth_parameter(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_fetch_output())

        tool = WigoloFetchTool(client=mock_client)
        await tool.ainvoke({"url": "https://internal.com", "use_auth": True})

        call_args = mock_client.call_tool.call_args[0]
        assert call_args[1]["use_auth"] is True
