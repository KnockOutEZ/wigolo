"""LangChain tool wrappers for wigolo search and fetch."""

from __future__ import annotations

import json
import logging
from typing import Any, Optional, Type

from langchain_core.callbacks import (
    AsyncCallbackManagerForToolRun,
    CallbackManagerForToolRun,
)
from langchain_core.tools import BaseTool
from pydantic import ConfigDict, Field

from langchain_wigolo.client import WigoloMcpClient
from langchain_wigolo.types import FetchInput, SearchInput

logger = logging.getLogger(__name__)


class WigoloSearchTool(BaseTool):
    """Search the web using wigolo and return results as JSON.

    Wraps wigolo's search MCP tool. Returns a JSON string with search results
    including titles, URLs, snippets, and optionally full markdown content.
    """

    name: str = "wigolo_search"
    description: str = (
        "Search the web for information on any topic. Returns titles, URLs, "
        "relevance scores, and full extracted markdown content. Supports domain "
        "filtering, date ranges, and content categories. Input should include "
        "a 'query' string with keyword-based search terms."
    )
    args_schema: Type[SearchInput] = SearchInput
    client: Any = Field(description="WigoloMcpClient instance")

    model_config = ConfigDict(arbitrary_types_allowed=True)

    def _run(
        self,
        query: str = "",
        max_results: int = 5,
        include_content: bool = True,
        content_max_chars: int = 30000,
        max_total_chars: int = 50000,
        time_range: Optional[str] = None,
        include_domains: Optional[list[str]] = None,
        exclude_domains: Optional[list[str]] = None,
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
        category: Optional[str] = None,
        format: Optional[str] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
        **kwargs: Any,
    ) -> str:
        """Synchronous search — wraps async version."""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        params = self._build_params(
            query=query, max_results=max_results, include_content=include_content,
            content_max_chars=content_max_chars, max_total_chars=max_total_chars,
            time_range=time_range, include_domains=include_domains,
            exclude_domains=exclude_domains, from_date=from_date, to_date=to_date,
            category=category, format=format,
        )

        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(asyncio.run, self._call_tool(params))
                return future.result()
        return asyncio.run(self._call_tool(params))

    async def _arun(
        self,
        query: str = "",
        max_results: int = 5,
        include_content: bool = True,
        content_max_chars: int = 30000,
        max_total_chars: int = 50000,
        time_range: Optional[str] = None,
        include_domains: Optional[list[str]] = None,
        exclude_domains: Optional[list[str]] = None,
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
        category: Optional[str] = None,
        format: Optional[str] = None,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
        **kwargs: Any,
    ) -> str:
        """Async search execution."""
        params = self._build_params(
            query=query, max_results=max_results, include_content=include_content,
            content_max_chars=content_max_chars, max_total_chars=max_total_chars,
            time_range=time_range, include_domains=include_domains,
            exclude_domains=exclude_domains, from_date=from_date, to_date=to_date,
            category=category, format=format,
        )
        return await self._call_tool(params)

    @staticmethod
    def _build_params(**kwargs: Any) -> dict[str, Any]:
        """Build the tool call parameters, stripping None values."""
        return {k: v for k, v in kwargs.items() if v is not None}

    async def _call_tool(self, params: dict[str, Any]) -> str:
        """Call the wigolo search tool and return JSON string."""
        try:
            result = await self.client.call_tool("search", params)
            return json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            logger.error("wigolo search tool error: %s", exc)
            return json.dumps({"error": str(exc)})


class WigoloFetchTool(BaseTool):
    """Fetch a web page using wigolo and return the result as JSON.

    Wraps wigolo's fetch MCP tool. Returns a JSON string with the page title,
    clean markdown content, links, images, and metadata.
    """

    name: str = "wigolo_fetch"
    description: str = (
        "Fetch a specific web page and return its content as clean markdown. "
        "Supports JavaScript rendering, section extraction, and authenticated "
        "browsing. Input must include a 'url' string."
    )
    args_schema: Type[FetchInput] = FetchInput
    client: Any = Field(description="WigoloMcpClient instance")

    model_config = ConfigDict(arbitrary_types_allowed=True)

    def _run(
        self,
        url: str = "",
        render_js: str = "auto",
        max_chars: Optional[int] = None,
        section: Optional[str] = None,
        section_index: Optional[int] = None,
        use_auth: bool = False,
        run_manager: Optional[CallbackManagerForToolRun] = None,
        **kwargs: Any,
    ) -> str:
        """Synchronous fetch — wraps async version."""
        import asyncio

        params = self._build_params(
            url=url, render_js=render_js, max_chars=max_chars,
            section=section, section_index=section_index, use_auth=use_auth,
        )

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(asyncio.run, self._call_tool(params))
                return future.result()
        return asyncio.run(self._call_tool(params))

    async def _arun(
        self,
        url: str = "",
        render_js: str = "auto",
        max_chars: Optional[int] = None,
        section: Optional[str] = None,
        section_index: Optional[int] = None,
        use_auth: bool = False,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
        **kwargs: Any,
    ) -> str:
        """Async fetch execution."""
        params = self._build_params(
            url=url, render_js=render_js, max_chars=max_chars,
            section=section, section_index=section_index, use_auth=use_auth,
        )
        return await self._call_tool(params)

    @staticmethod
    def _build_params(**kwargs: Any) -> dict[str, Any]:
        """Build the tool call parameters, stripping None values."""
        params = {}
        for k, v in kwargs.items():
            if v is not None:
                if k == "render_js" and v == "auto":
                    continue
                if k == "use_auth" and v is False:
                    continue
                params[k] = v
        if "url" not in params and "url" in kwargs:
            params["url"] = kwargs["url"]
        return params

    async def _call_tool(self, params: dict[str, Any]) -> str:
        """Call the wigolo fetch tool and return JSON string."""
        try:
            result = await self.client.call_tool("fetch", params)
            return json.dumps(result, ensure_ascii=False)
        except Exception as exc:
            logger.error("wigolo fetch tool error: %s", exc)
            return json.dumps({"error": str(exc)})
