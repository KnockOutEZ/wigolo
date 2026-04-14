"""Unit tests for WigoloSearchRetriever."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.documents import Document

from langchain_wigolo.retrievers import WigoloSearchRetriever
from langchain_wigolo.client import WigoloMcpClient


def _make_search_result(
    title: str = "Test",
    url: str = "https://example.com",
    snippet: str = "A snippet",
    markdown_content: str = "# Content",
    relevance_score: float = 0.9,
) -> dict:
    return {
        "title": title,
        "url": url,
        "snippet": snippet,
        "markdown_content": markdown_content,
        "relevance_score": relevance_score,
    }


def _make_search_output(results: list[dict] | None = None, query: str = "test") -> dict:
    return {
        "results": [_make_search_result()] if results is None else results,
        "query": query,
        "engines_used": ["duckduckgo"],
        "total_time_ms": 500,
    }


class TestWigoloSearchRetrieverConfig:
    """Test retriever configuration."""

    def test_default_max_results(self):
        retriever = WigoloSearchRetriever(client=MagicMock())
        assert retriever.max_results == 5

    def test_custom_max_results(self):
        retriever = WigoloSearchRetriever(client=MagicMock(), max_results=10)
        assert retriever.max_results == 10

    def test_domain_filtering(self):
        retriever = WigoloSearchRetriever(
            client=MagicMock(),
            include_domains=["docs.python.org"],
        )
        assert retriever.include_domains == ["docs.python.org"]

    def test_category_filter(self):
        retriever = WigoloSearchRetriever(client=MagicMock(), category="code")
        assert retriever.category == "code"


class TestWigoloSearchRetrieverDocuments:
    """Test document retrieval."""

    @pytest.mark.asyncio
    async def test_get_relevant_documents_returns_documents(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_output())

        retriever = WigoloSearchRetriever(client=mock_client)
        docs = await retriever.ainvoke("test query")

        assert len(docs) == 1
        assert isinstance(docs[0], Document)

    @pytest.mark.asyncio
    async def test_document_page_content_uses_markdown(self):
        result = _make_search_result(markdown_content="# Hello World\nContent here.")
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_output([result]))

        retriever = WigoloSearchRetriever(client=mock_client)
        docs = await retriever.ainvoke("test")

        assert docs[0].page_content == "# Hello World\nContent here."

    @pytest.mark.asyncio
    async def test_document_falls_back_to_snippet_when_no_content(self):
        result = _make_search_result(snippet="Just a snippet")
        result.pop("markdown_content")
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_output([result]))

        retriever = WigoloSearchRetriever(client=mock_client)
        docs = await retriever.ainvoke("test")

        assert docs[0].page_content == "Just a snippet"

    @pytest.mark.asyncio
    async def test_document_metadata_includes_url_title_score(self):
        result = _make_search_result(
            title="My Title", url="https://example.com/page", relevance_score=0.85
        )
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_output([result]))

        retriever = WigoloSearchRetriever(client=mock_client)
        docs = await retriever.ainvoke("test")

        assert docs[0].metadata["title"] == "My Title"
        assert docs[0].metadata["url"] == "https://example.com/page"
        assert docs[0].metadata["relevance_score"] == 0.85
        assert docs[0].metadata["source"] == "wigolo"

    @pytest.mark.asyncio
    async def test_passes_search_parameters_to_client(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_output())

        retriever = WigoloSearchRetriever(
            client=mock_client,
            max_results=3,
            include_domains=["react.dev"],
            category="docs",
        )
        await retriever.ainvoke("react hooks")

        call_args = mock_client.call_tool.call_args
        assert call_args[0][0] == "search"
        params = call_args[0][1]
        assert params["query"] == "react hooks"
        assert params["max_results"] == 3
        assert params["include_domains"] == ["react.dev"]
        assert params["category"] == "docs"

    @pytest.mark.asyncio
    async def test_empty_results_returns_empty_list(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_output([]))

        retriever = WigoloSearchRetriever(client=mock_client)
        docs = await retriever.ainvoke("empty query")

        assert docs == []

    @pytest.mark.asyncio
    async def test_error_response_returns_empty_list(self):
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(
            return_value={"error": "No results", "results": [], "query": "test", "engines_used": [], "total_time_ms": 0}
        )

        retriever = WigoloSearchRetriever(client=mock_client)
        docs = await retriever.ainvoke("test")

        assert docs == []

    @pytest.mark.asyncio
    async def test_multiple_results_all_converted(self):
        results = [
            _make_search_result(title=f"Result {i}", url=f"https://example.com/{i}")
            for i in range(5)
        ]
        mock_client = AsyncMock(spec=WigoloMcpClient)
        mock_client.call_tool = AsyncMock(return_value=_make_search_output(results))

        retriever = WigoloSearchRetriever(client=mock_client)
        docs = await retriever.ainvoke("test")

        assert len(docs) == 5
        for i, doc in enumerate(docs):
            assert doc.metadata["title"] == f"Result {i}"
