"""Pydantic input schemas for the wigolo-crewai tools.

These are the ``args_schema`` models CrewAI uses to validate tool inputs.
They intentionally expose the common, high-signal parameters of each wigolo
tool; the full parameter surface remains reachable through the SDK directly.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class SearchInput(BaseModel):
    """Input schema for the wigolo search tool."""

    query: str = Field(description="Keyword-based search query")
    max_results: int = Field(
        default=5, ge=1, le=20, description="Maximum number of results to return"
    )
    include_content: bool = Field(
        default=True, description="Fetch full extracted content for the results"
    )
    time_range: Optional[str] = Field(
        default=None,
        pattern=r"^(day|week|month|year)$",
        description="Restrict results to a recent time window",
    )
    include_domains: Optional[list[str]] = Field(
        default=None, description="Only return results from these domains"
    )
    exclude_domains: Optional[list[str]] = Field(
        default=None, description="Never return results from these domains"
    )
    category: Optional[str] = Field(
        default=None,
        pattern=r"^(general|news|code|docs|papers|images)$",
        description="Search category hint",
    )


class FetchInput(BaseModel):
    """Input schema for the wigolo fetch tool."""

    url: str = Field(description="URL of the page to fetch")
    render_js: bool = Field(
        default=False, description="Render JavaScript with the browser engine"
    )
    section: Optional[str] = Field(
        default=None, description="Extract a specific section by heading text"
    )
    max_chars: Optional[int] = Field(
        default=None, ge=0, description="Maximum characters of content to return"
    )
    use_auth: bool = Field(
        default=False, description="Use stored authenticated browser session"
    )


class ResearchInput(BaseModel):
    """Input schema for the wigolo research tool."""

    question: str = Field(description="The research question to investigate")
    depth: str = Field(
        default="standard",
        pattern=r"^(quick|standard|comprehensive)$",
        description="Research depth",
    )
    max_sources: Optional[int] = Field(
        default=None, ge=1, description="Maximum number of sources to consult"
    )
    include_domains: Optional[list[str]] = Field(
        default=None, description="Only consult these domains"
    )
    exclude_domains: Optional[list[str]] = Field(
        default=None, description="Never consult these domains"
    )


class CrawlInput(BaseModel):
    """Input schema for the wigolo crawl tool."""

    url: str = Field(description="Seed URL to start crawling from")
    strategy: str = Field(
        default="bfs",
        pattern=r"^(sitemap|bfs|dfs|map)$",
        description="Crawl strategy",
    )
    max_depth: Optional[int] = Field(
        default=None, ge=0, description="Maximum link depth to follow"
    )
    max_pages: Optional[int] = Field(
        default=None, ge=1, description="Maximum number of pages to visit"
    )
    include_patterns: Optional[list[str]] = Field(
        default=None, description="Only crawl URLs matching these patterns"
    )
    exclude_patterns: Optional[list[str]] = Field(
        default=None, description="Skip URLs matching these patterns"
    )


class ExtractInput(BaseModel):
    """Input schema for the wigolo extract tool.

    The ``schema`` field intentionally uses the wigolo SDK's parameter name;
    it emits a benign Pydantic warning about shadowing ``BaseModel.schema``.
    """

    url: str = Field(description="URL to extract structured data from")
    mode: str = Field(
        default="structured",
        pattern=r"^(structured|schema|tables|metadata|selector)$",
        description="Extraction mode",
    )
    schema: Optional[Any] = Field(
        default=None, description="JSON Schema for schema-mode extraction"
    )
    css_selector: Optional[str] = Field(
        default=None, description="CSS selector for selector-mode extraction"
    )
