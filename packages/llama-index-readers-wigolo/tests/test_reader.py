"""Unit tests for WigoloWebReader and WigoloSearchReader."""

from __future__ import annotations

import json
from typing import Iterator
from unittest.mock import AsyncMock, MagicMock

import pytest
from llama_index.core.schema import Document

from llama_index_readers_wigolo.reader import WigoloWebReader, WigoloSearchReader
from llama_index_readers_wigolo.client import WigoloMcpClient


def _make_fetch_result(
    url: str = "https://example.com",
    title: str = "Example",
    markdown: str = "# Example\nContent here.",
    error: str | None = None,
) -> dict:
    return {
        "url": url,
        "title": title,
        "markdown": markdown,
        "metadata": {"description": "A page", "author": "Author"},
        "links": ["https://example.com/other"],
        "images": [],
        "cached": False,
        **({"error": error} if error else {}),
    }


def _make_search_result(n: int = 2, query: str = "test") -> dict:
    return {
        "results": [
            {
                "title": f"Result {i}",
                "url": f"https://example.com/r{i}",
                "snippet": f"Snippet for result {i}",
                "markdown_content": f"# Result {i}\nDetailed content.",
                "relevance_score": 0.9 - i * 0.1,
            }
            for i in range(n)
        ],
        "query": query,
        "engines_used": ["duckduckgo"],
        "total_time_ms": 500,
    }


class TestWigoloWebReaderConfig:
    """Test web reader configuration."""

    def test_creates_with_client(self):
        reader = WigoloWebReader(client=MagicMock())
        assert reader is not None

    def test_default_render_js(self):
        reader = WigoloWebReader(client=MagicMock())
        assert reader.render_js == "auto"

    def test_custom_render_js(self):
        reader = WigoloWebReader(client=MagicMock(), render_js="always")
        assert reader.render_js == "always"


class TestWigoloWebReaderLoadData:
    """Test load_data for fetching URLs."""

    @pytest.mark.asyncio
    async def test_load_single_url_returns_document(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_fetch_result())

        reader = WigoloWebReader(client=mock_client)
        docs = await reader.aload_data(urls=["https://example.com"])

        assert len(docs) == 1
        assert isinstance(docs[0], Document)

    @pytest.mark.asyncio
    async def test_document_text_is_markdown_content(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(
            return_value=_make_fetch_result(markdown="# Hello\nWorld")
        )

        reader = WigoloWebReader(client=mock_client)
        docs = await reader.aload_data(urls=["https://example.com"])

        assert docs[0].text == "# Hello\nWorld"

    @pytest.mark.asyncio
    async def test_document_metadata_includes_url_and_title(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(
            return_value=_make_fetch_result(url="https://test.com", title="Test Page")
        )

        reader = WigoloWebReader(client=mock_client)
        docs = await reader.aload_data(urls=["https://test.com"])

        assert docs[0].metadata["url"] == "https://test.com"
        assert docs[0].metadata["title"] == "Test Page"
        assert docs[0].metadata["source"] == "wigolo"

    @pytest.mark.asyncio
    async def test_load_multiple_urls(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        results = [
            _make_fetch_result(url=f"https://example.com/{i}", title=f"Page {i}")
            for i in range(3)
        ]
        mock_client.call_tool = AsyncMock(side_effect=results)

        reader = WigoloWebReader(client=mock_client)
        docs = await reader.aload_data(urls=[f"https://example.com/{i}" for i in range(3)])

        assert len(docs) == 3
        for i, doc in enumerate(docs):
            assert doc.metadata["title"] == f"Page {i}"

    @pytest.mark.asyncio
    async def test_skips_urls_with_errors(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(side_effect=[
            _make_fetch_result(url="https://good.com", markdown="Good content"),
            _make_fetch_result(url="https://bad.com", markdown="", error="Connection refused"),
            _make_fetch_result(url="https://also-good.com", markdown="More content"),
        ])

        reader = WigoloWebReader(client=mock_client)
        docs = await reader.aload_data(urls=[
            "https://good.com", "https://bad.com", "https://also-good.com"
        ])

        assert len(docs) == 2
        assert docs[0].metadata["url"] == "https://good.com"
        assert docs[1].metadata["url"] == "https://also-good.com"

    @pytest.mark.asyncio
    async def test_skips_urls_with_empty_markdown(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(
            return_value=_make_fetch_result(markdown="")
        )

        reader = WigoloWebReader(client=mock_client)
        docs = await reader.aload_data(urls=["https://empty.com"])

        assert len(docs) == 0

    @pytest.mark.asyncio
    async def test_handles_client_exception_gracefully(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(side_effect=Exception("Network error"))

        reader = WigoloWebReader(client=mock_client)
        docs = await reader.aload_data(urls=["https://example.com"])

        assert len(docs) == 0

    @pytest.mark.asyncio
    async def test_empty_urls_returns_empty_list(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        reader = WigoloWebReader(client=mock_client)
        docs = await reader.aload_data(urls=[])

        assert docs == []
        mock_client.call_tool.assert_not_called()

    @pytest.mark.asyncio
    async def test_passes_section_parameter(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_fetch_result())

        reader = WigoloWebReader(client=mock_client, section="API Reference")
        await reader.aload_data(urls=["https://docs.example.com"])

        call_args = mock_client.call_tool.call_args[0]
        assert call_args[1]["section"] == "API Reference"

    @pytest.mark.asyncio
    async def test_passes_render_js_parameter(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_fetch_result())

        reader = WigoloWebReader(client=mock_client, render_js="always")
        await reader.aload_data(urls=["https://spa.example.com"])

        call_args = mock_client.call_tool.call_args[0]
        assert call_args[1]["render_js"] == "always"

    @pytest.mark.asyncio
    async def test_document_metadata_includes_page_metadata(self):
        result = _make_fetch_result()
        result["metadata"] = {"description": "Test desc", "author": "Jane", "date": "2025-01-01"}
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=result)

        reader = WigoloWebReader(client=mock_client)
        docs = await reader.aload_data(urls=["https://example.com"])

        assert docs[0].metadata["description"] == "Test desc"
        assert docs[0].metadata["author"] == "Jane"


class TestWigoloSearchReaderConfig:
    """Test search reader configuration."""

    def test_creates_with_client(self):
        reader = WigoloSearchReader(client=MagicMock())
        assert reader is not None

    def test_default_max_results(self):
        reader = WigoloSearchReader(client=MagicMock())
        assert reader.max_results == 5


class TestWigoloSearchReaderLoadData:
    """Test load_data for searching."""

    @pytest.mark.asyncio
    async def test_load_data_returns_documents(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_result(2))

        reader = WigoloSearchReader(client=mock_client)
        docs = await reader.aload_data(query="test query")

        assert len(docs) == 2
        for doc in docs:
            assert isinstance(doc, Document)

    @pytest.mark.asyncio
    async def test_document_text_uses_markdown_content(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_result(1))

        reader = WigoloSearchReader(client=mock_client)
        docs = await reader.aload_data(query="test")

        assert "# Result 0" in docs[0].text

    @pytest.mark.asyncio
    async def test_document_falls_back_to_snippet(self):
        result = _make_search_result(1)
        result["results"][0].pop("markdown_content")
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=result)

        reader = WigoloSearchReader(client=mock_client)
        docs = await reader.aload_data(query="test")

        assert docs[0].text == "Snippet for result 0"

    @pytest.mark.asyncio
    async def test_document_metadata_has_url_title_score(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_result(1))

        reader = WigoloSearchReader(client=mock_client)
        docs = await reader.aload_data(query="test")

        assert "url" in docs[0].metadata
        assert "title" in docs[0].metadata
        assert "relevance_score" in docs[0].metadata
        assert docs[0].metadata["source"] == "wigolo"

    @pytest.mark.asyncio
    async def test_passes_search_parameters(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_result())

        reader = WigoloSearchReader(
            client=mock_client,
            max_results=3,
            include_domains=["react.dev"],
            category="docs",
        )
        await reader.aload_data(query="react hooks")

        call_args = mock_client.call_tool.call_args[0]
        assert call_args[0] == "search"
        params = call_args[1]
        assert params["query"] == "react hooks"
        assert params["max_results"] == 3
        assert params["include_domains"] == ["react.dev"]

    @pytest.mark.asyncio
    async def test_empty_results_returns_empty_list(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_result(0))

        reader = WigoloSearchReader(client=mock_client)
        docs = await reader.aload_data(query="nothing here")

        assert docs == []

    @pytest.mark.asyncio
    async def test_error_response_returns_empty_list(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(side_effect=Exception("Search failed"))

        reader = WigoloSearchReader(client=mock_client)
        docs = await reader.aload_data(query="test")

        assert docs == []
