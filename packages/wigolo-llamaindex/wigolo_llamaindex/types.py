"""Pydantic models for wigolo MCP responses."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class FetchMetadata(BaseModel):
    """Metadata from a fetched page."""

    description: Optional[str] = None
    author: Optional[str] = None
    date: Optional[str] = None
    language: Optional[str] = None
    section_matched: Optional[bool] = None


class FetchResult(BaseModel):
    """Parsed result from the wigolo fetch tool."""

    url: str = ""
    title: str = ""
    markdown: str = ""
    metadata: FetchMetadata = Field(default_factory=FetchMetadata)
    links: list[str] = Field(default_factory=list)
    images: list[str] = Field(default_factory=list)
    cached: bool = False
    error: Optional[str] = None


class SearchResultItem(BaseModel):
    """A single search result."""

    title: str = ""
    url: str = ""
    snippet: str = ""
    markdown_content: Optional[str] = None
    fetch_failed: Optional[str] = None
    content_truncated: Optional[bool] = None
    relevance_score: float = 0.0


class SearchResult(BaseModel):
    """Parsed result from the wigolo search tool."""

    results: list[SearchResultItem] = Field(default_factory=list)
    query: str = ""
    engines_used: list[str] = Field(default_factory=list)
    total_time_ms: int = 0
    error: Optional[str] = None
    warning: Optional[str] = None
