"""CrewAI tool adapters for wigolo.

Thin ``BaseTool`` subclasses that delegate all real work to :mod:`wigolo_crewai._core`.
Importing this module requires crewai; the core logic in ``_core`` does not.
"""

from __future__ import annotations

from typing import Any, Optional, Type

try:
    from crewai.tools import BaseTool
except ImportError as exc:  # pragma: no cover - exercised only without crewai
    raise ImportError(
        "crewai is required to use wigolo_crewai tools. Install it with "
        "`pip install wigolo-crewai[crewai]` or `pip install crewai`."
    ) from exc

from pydantic import BaseModel, ConfigDict, Field

from wigolo import Client

from wigolo_crewai import _core
from wigolo_crewai.types import (
    CrawlInput,
    ExtractInput,
    FetchInput,
    ResearchInput,
    SearchInput,
)


class _WigoloBaseTool(BaseTool):
    """Shared config: every tool carries a wigolo ``Client``."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    client: Any = Field(default=None, description="wigolo Client instance")


class WigoloSearchTool(_WigoloBaseTool):
    """Search the web for information on any topic."""

    name: str = "wigolo_search"
    description: str = (
        "Search the web for information on any topic. Returns titles, URLs, "
        "relevance scores, and extracted content as JSON. Supports domain "
        "filtering, time ranges, and content categories. Use a keyword-based "
        "'query'."
    )
    args_schema: Type[BaseModel] = SearchInput

    def _run(self, **kwargs: Any) -> str:
        return _core.run_search(self.client, **kwargs)


class WigoloFetchTool(_WigoloBaseTool):
    """Fetch a specific web page as clean markdown."""

    name: str = "wigolo_fetch"
    description: str = (
        "Fetch a specific web page and return its content as clean markdown "
        "plus metadata, as JSON. Supports JavaScript rendering via the browser "
        "engine, section extraction, and authenticated browsing. Requires a 'url'."
    )
    args_schema: Type[BaseModel] = FetchInput

    def _run(self, **kwargs: Any) -> str:
        return _core.run_fetch(self.client, **kwargs)


class WigoloResearchTool(_WigoloBaseTool):
    """Run multi-step research and return a structured brief."""

    name: str = "wigolo_research"
    description: str = (
        "Investigate a question across multiple sources and return a structured "
        "research brief as JSON, with topics, highlights, key findings, "
        "cross-references, and coverage gaps. Requires a 'question'."
    )
    args_schema: Type[BaseModel] = ResearchInput

    def _run(self, **kwargs: Any) -> str:
        return _core.run_research(self.client, **kwargs)


class WigoloCrawlTool(_WigoloBaseTool):
    """Crawl a site from a seed URL."""

    name: str = "wigolo_crawl"
    description: str = (
        "Crawl a website from a seed URL and return the visited pages (or URL "
        "map) as JSON. Supports sitemap, breadth-first, depth-first, and map "
        "strategies with depth, page, and pattern limits. Requires a 'url'."
    )
    args_schema: Type[BaseModel] = CrawlInput

    def _run(self, **kwargs: Any) -> str:
        return _core.run_crawl(self.client, **kwargs)


class WigoloExtractTool(_WigoloBaseTool):
    """Extract structured data from a page."""

    name: str = "wigolo_extract"
    description: str = (
        "Extract structured data from a web page as JSON — tables, definition "
        "lists, key-value pairs, metadata, or schema-shaped fields. Supports "
        "structured, schema, tables, metadata, and selector modes. Requires a 'url'."
    )
    args_schema: Type[BaseModel] = ExtractInput

    def _run(self, **kwargs: Any) -> str:
        return _core.run_extract(self.client, **kwargs)


def wigolo_tools(
    base_url: Optional[str] = None,
    token: Optional[str] = None,
    local: bool = True,
) -> list[BaseTool]:
    """Build all five wigolo tools sharing one wigolo ``Client``.

    By default spawns a zero-setup local daemon (``local=True``). Pass
    ``base_url``/``token`` to target a running wigolo server instead.
    """
    client: Client = _core.build_client(base_url=base_url, token=token, local=local)
    return [
        WigoloSearchTool(client=client),
        WigoloFetchTool(client=client),
        WigoloResearchTool(client=client),
        WigoloCrawlTool(client=client),
        WigoloExtractTool(client=client),
    ]
