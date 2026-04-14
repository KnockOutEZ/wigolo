"""Shared Pydantic models for langchain-wigolo."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class SearchInput(BaseModel):
    """Input schema for the wigolo search tool."""

    query: str = Field(description="Search query")
    max_results: int = Field(default=5, ge=1, le=20, description="Max results to return")
    include_content: bool = Field(default=True, description="Fetch full content for results")
    content_max_chars: int = Field(default=30000, ge=0, description="Max chars per result content")
    max_total_chars: int = Field(default=50000, ge=0, description="Max total chars across all results")
    time_range: Optional[str] = Field(
        default=None, pattern=r"^(day|week|month|year)$", description="Time range filter"
    )
    include_domains: Optional[list[str]] = Field(default=None, description="Only return results from these domains")
    exclude_domains: Optional[list[str]] = Field(default=None, description="Never return results from these domains")
    from_date: Optional[str] = Field(default=None, description="ISO date — results after this date")
    to_date: Optional[str] = Field(default=None, description="ISO date — results before this date")
    category: Optional[str] = Field(
        default=None,
        pattern=r"^(general|news|code|docs|papers|images)$",
        description="Search category",
    )
    format: Optional[str] = Field(
        default=None, pattern=r"^(full|context)$", description="Output format"
    )


class FetchInput(BaseModel):
    """Input schema for the wigolo fetch tool."""

    url: str = Field(description="URL to fetch")
    render_js: str = Field(default="auto", pattern=r"^(auto|always|never)$", description="JS rendering mode")
    max_chars: Optional[int] = Field(default=None, ge=0, description="Maximum characters to return")
    section: Optional[str] = Field(default=None, description="Extract a specific section by heading text")
    section_index: Optional[int] = Field(default=None, ge=0, description="Index of section match")
    use_auth: bool = Field(default=False, description="Use stored auth credentials")


class SearchResultItem(BaseModel):
    """A single search result."""

    title: str = ""
    url: str = ""
    snippet: str = ""
    markdown_content: Optional[str] = None
    fetch_failed: Optional[str] = None
    content_truncated: Optional[bool] = None
    relevance_score: float = 0.0


class SearchOutput(BaseModel):
    """Output from the wigolo search tool."""

    results: list[SearchResultItem] = Field(default_factory=list)
    query: str = ""
    engines_used: list[str] = Field(default_factory=list)
    total_time_ms: int = 0
    error: Optional[str] = None
    warning: Optional[str] = None
    context_text: Optional[str] = None


class FetchMetadata(BaseModel):
    """Metadata from a fetched page."""

    description: Optional[str] = None
    author: Optional[str] = None
    date: Optional[str] = None
    language: Optional[str] = None
    section_matched: Optional[bool] = None


class FetchOutput(BaseModel):
    """Output from the wigolo fetch tool."""

    url: str = ""
    title: str = ""
    markdown: str = ""
    metadata: FetchMetadata = Field(default_factory=FetchMetadata)
    links: list[str] = Field(default_factory=list)
    images: list[str] = Field(default_factory=list)
    screenshot: Optional[str] = None
    cached: bool = False
    error: Optional[str] = None


class McpToolCallRequest(BaseModel):
    """JSON-RPC request for tools/call."""

    jsonrpc: str = "2.0"
    id: int
    method: str = "tools/call"
    params: dict


class McpResponse(BaseModel):
    """JSON-RPC response from MCP server."""

    jsonrpc: str = "2.0"
    id: int
    result: Optional[dict] = None
    error: Optional[dict] = None
