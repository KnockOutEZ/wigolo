"""LlamaIndex readers backed by wigolo web tools."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Iterator, Optional

from llama_index.core.readers.base import BaseReader
from llama_index.core.schema import Document

from llama_index_readers_wigolo.client import WigoloMcpClient

logger = logging.getLogger(__name__)


class WigoloWebReader(BaseReader):
    """Read web pages via wigolo fetch and convert to LlamaIndex Documents.

    Each URL is fetched through wigolo's MCP server. The extracted markdown
    content becomes the Document text; URL, title, and page metadata are
    stored in Document.metadata.
    """

    def __init__(
        self,
        client: WigoloMcpClient | Any,
        render_js: str = "auto",
        section: Optional[str] = None,
        max_chars: Optional[int] = None,
        use_auth: bool = False,
    ) -> None:
        super().__init__()
        self.client = client
        self.render_js = render_js
        self.section = section
        self.max_chars = max_chars
        self.use_auth = use_auth

    def load_data(self, urls: list[str], **kwargs: Any) -> list[Document]:
        """Synchronous load -- fetches all URLs and returns Documents."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(asyncio.run, self.aload_data(urls=urls, **kwargs))
                return future.result()
        return asyncio.run(self.aload_data(urls=urls, **kwargs))

    async def aload_data(self, urls: list[str], **kwargs: Any) -> list[Document]:
        """Async load -- fetches all URLs and returns Documents."""
        if not urls:
            return []

        documents: list[Document] = []

        for url in urls:
            try:
                doc = await self._fetch_url(url)
                if doc is not None:
                    documents.append(doc)
            except Exception as exc:
                logger.error("failed to fetch %s: %s", url, exc)

        return documents

    def lazy_load_data(self, urls: list[str], **kwargs: Any) -> Iterator[Document]:
        """Lazy load -- yields Documents one at a time."""
        for url in urls:
            try:
                doc = asyncio.run(self._fetch_url(url))
                if doc is not None:
                    yield doc
            except Exception as exc:
                logger.error("failed to fetch %s: %s", url, exc)

    async def _fetch_url(self, url: str) -> Optional[Document]:
        """Fetch a single URL and convert to Document."""
        params: dict[str, Any] = {"url": url, "render_js": self.render_js}

        if self.section:
            params["section"] = self.section
        if self.max_chars is not None:
            params["max_chars"] = self.max_chars
        if self.use_auth:
            params["use_auth"] = True

        result = await self.client.call_tool("fetch", params)

        if result.get("error"):
            logger.warning("fetch error for %s: %s", url, result["error"])
            return None

        markdown = result.get("markdown", "")
        if not markdown.strip():
            logger.debug("empty content for %s, skipping", url)
            return None

        page_metadata = result.get("metadata", {})
        metadata = {
            "url": result.get("url", url),
            "title": result.get("title", ""),
            "source": "wigolo",
            "cached": result.get("cached", False),
        }

        if isinstance(page_metadata, dict):
            for key in ("description", "author", "date", "language"):
                if page_metadata.get(key):
                    metadata[key] = page_metadata[key]

        return Document(text=markdown, metadata=metadata)


class WigoloSearchReader(BaseReader):
    """Search the web via wigolo and convert results to LlamaIndex Documents.

    Each search result becomes a Document with its markdown content (or snippet
    fallback) as text, and URL/title/score as metadata.
    """

    def __init__(
        self,
        client: WigoloMcpClient | Any,
        max_results: int = 5,
        include_content: bool = True,
        include_domains: Optional[list[str]] = None,
        exclude_domains: Optional[list[str]] = None,
        category: Optional[str] = None,
        time_range: Optional[str] = None,
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
    ) -> None:
        super().__init__()
        self.client = client
        self.max_results = max_results
        self.include_content = include_content
        self.include_domains = include_domains
        self.exclude_domains = exclude_domains
        self.category = category
        self.time_range = time_range
        self.from_date = from_date
        self.to_date = to_date

    def load_data(self, query: str, **kwargs: Any) -> list[Document]:
        """Synchronous search and return Documents."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(asyncio.run, self.aload_data(query=query, **kwargs))
                return future.result()
        return asyncio.run(self.aload_data(query=query, **kwargs))

    async def aload_data(self, query: str, **kwargs: Any) -> list[Document]:
        """Async search and return Documents."""
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
            text = result.get("markdown_content") or result.get("snippet", "")
            if not text.strip():
                continue

            metadata = {
                "url": result.get("url", ""),
                "title": result.get("title", ""),
                "relevance_score": result.get("relevance_score", 0.0),
                "source": "wigolo",
                "query": query,
            }
            if result.get("snippet"):
                metadata["snippet"] = result["snippet"]

            documents.append(Document(text=text, metadata=metadata))

        return documents

    def lazy_load_data(self, query: str, **kwargs: Any) -> Iterator[Document]:
        """Lazy search -- loads all at once since search is a single call."""
        docs = self.load_data(query=query, **kwargs)
        yield from docs
