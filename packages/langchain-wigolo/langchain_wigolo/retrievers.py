"""WigoloSearchRetriever — LangChain BaseRetriever backed by wigolo search."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from pydantic import ConfigDict, Field

from langchain_wigolo.client import WigoloMcpClient

logger = logging.getLogger(__name__)


class WigoloSearchRetriever(BaseRetriever):
    """Retriever that uses wigolo's search tool to find relevant documents.

    Each search result is converted to a LangChain Document with the page's
    markdown content as page_content and url/title/score as metadata.
    """

    client: Any = Field(description="WigoloMcpClient instance")
    max_results: int = Field(default=5, description="Maximum search results")
    include_content: bool = Field(default=True, description="Fetch full content")
    include_domains: Optional[list[str]] = Field(default=None, description="Domain whitelist")
    exclude_domains: Optional[list[str]] = Field(default=None, description="Domain blacklist")
    category: Optional[str] = Field(default=None, description="Search category")
    time_range: Optional[str] = Field(default=None, description="Time range filter")
    from_date: Optional[str] = Field(default=None, description="Results after this ISO date")
    to_date: Optional[str] = Field(default=None, description="Results before this ISO date")

    model_config = ConfigDict(arbitrary_types_allowed=True)

    def _get_relevant_documents(
        self,
        query: str,
        *,
        run_manager: Optional[CallbackManagerForRetrieverRun] = None,
    ) -> list[Document]:
        """Synchronous retrieval — runs the async method in an event loop."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(asyncio.run, self._aget_relevant_documents(query))
                return future.result()
        else:
            return asyncio.run(self._aget_relevant_documents(query))

    async def _aget_relevant_documents(
        self,
        query: str,
        *,
        run_manager: Optional[CallbackManagerForRetrieverRun] = None,
    ) -> list[Document]:
        """Search wigolo and convert results to LangChain Documents."""
        search_params: dict[str, Any] = {
            "query": query,
            "max_results": self.max_results,
            "include_content": self.include_content,
        }

        if self.include_domains:
            search_params["include_domains"] = self.include_domains
        if self.exclude_domains:
            search_params["exclude_domains"] = self.exclude_domains
        if self.category:
            search_params["category"] = self.category
        if self.time_range:
            search_params["time_range"] = self.time_range
        if self.from_date:
            search_params["from_date"] = self.from_date
        if self.to_date:
            search_params["to_date"] = self.to_date

        try:
            output = await self.client.call_tool("search", search_params)
        except Exception as exc:
            logger.error("wigolo search failed: %s", exc)
            return []

        results = output.get("results", [])
        if not results:
            return []

        documents: list[Document] = []
        for result in results:
            page_content = result.get("markdown_content") or result.get("snippet", "")
            metadata = {
                "title": result.get("title", ""),
                "url": result.get("url", ""),
                "relevance_score": result.get("relevance_score", 0.0),
                "source": "wigolo",
            }
            if result.get("snippet"):
                metadata["snippet"] = result["snippet"]

            documents.append(Document(page_content=page_content, metadata=metadata))

        return documents
