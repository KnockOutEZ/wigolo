"""CrewAI-free core logic for wigolo-crewai.

This module holds all of the real behaviour — building a wigolo client and the
per-tool run functions that map arguments onto the SDK, shape the result into a
JSON string, and turn wigolo errors into clean error strings. It deliberately
does NOT import crewai, so it is fully unit-testable without that dependency.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from wigolo import Client, WigoloError


def build_client(
    base_url: Optional[str] = None,
    token: Optional[str] = None,
    local: bool = True,
) -> Client:
    """Construct a wigolo ``Client``.

    Defaults to ``local=True`` so a zero-setup embedded daemon is spawned when
    no server is configured. Pass ``base_url``/``token`` to target a running
    server instead, or ``local=False`` to require one.
    """
    return Client(base_url=base_url, token=token, local=local)


def _drop_none(mapping: dict[str, Any]) -> dict[str, Any]:
    """Strip ``None`` values so SDK defaults apply for unset arguments."""
    return {k: v for k, v in mapping.items() if v is not None}


def _to_json(result: Any) -> str:
    """Serialize a tool result dict to a compact JSON string."""
    return json.dumps(result, default=str, ensure_ascii=False)


def _error(tool: str, exc: Exception) -> str:
    """Map a wigolo error into a clean JSON error string (no stack trace)."""
    return json.dumps({"error": f"wigolo {tool} failed: {exc}"}, ensure_ascii=False)


def run_search(
    client: Client,
    query: str,
    *,
    max_results: int = 5,
    include_content: bool = True,
    time_range: Optional[str] = None,
    include_domains: Optional[list[str]] = None,
    exclude_domains: Optional[list[str]] = None,
    category: Optional[str] = None,
    **kwargs: Any,
) -> str:
    """Search the web and return results as a JSON string."""
    params = _drop_none(
        {
            "query": query,
            "max_results": max_results,
            "include_content": include_content,
            "time_range": time_range,
            "include_domains": include_domains,
            "exclude_domains": exclude_domains,
            "category": category,
            **kwargs,
        }
    )
    try:
        return _to_json(client.search(**params))
    except WigoloError as exc:
        return _error("search", exc)


def run_fetch(
    client: Client,
    url: str,
    *,
    render_js: bool = False,
    section: Optional[str] = None,
    max_chars: Optional[int] = None,
    use_auth: bool = False,
    **kwargs: Any,
) -> str:
    """Fetch a single page and return its content as a JSON string."""
    params = _drop_none(
        {
            "url": url,
            "render_js": render_js,
            "section": section,
            "max_chars": max_chars,
            "use_auth": use_auth,
            **kwargs,
        }
    )
    try:
        return _to_json(client.fetch(**params))
    except WigoloError as exc:
        return _error("fetch", exc)


def run_research(
    client: Client,
    question: str,
    *,
    depth: str = "standard",
    max_sources: Optional[int] = None,
    include_domains: Optional[list[str]] = None,
    exclude_domains: Optional[list[str]] = None,
    **kwargs: Any,
) -> str:
    """Run multi-step research and return the brief as a JSON string."""
    params = _drop_none(
        {
            "question": question,
            "depth": depth,
            "max_sources": max_sources,
            "include_domains": include_domains,
            "exclude_domains": exclude_domains,
            **kwargs,
        }
    )
    try:
        return _to_json(client.research(**params))
    except WigoloError as exc:
        return _error("research", exc)


def run_crawl(
    client: Client,
    url: str,
    *,
    strategy: str = "bfs",
    max_depth: Optional[int] = None,
    max_pages: Optional[int] = None,
    include_patterns: Optional[list[str]] = None,
    exclude_patterns: Optional[list[str]] = None,
    **kwargs: Any,
) -> str:
    """Crawl a site and return the pages/urls as a JSON string."""
    params = _drop_none(
        {
            "url": url,
            "strategy": strategy,
            "max_depth": max_depth,
            "max_pages": max_pages,
            "include_patterns": include_patterns,
            "exclude_patterns": exclude_patterns,
            **kwargs,
        }
    )
    try:
        return _to_json(client.crawl(**params))
    except WigoloError as exc:
        return _error("crawl", exc)


def run_extract(
    client: Client,
    url: str,
    *,
    mode: str = "structured",
    schema: Optional[Any] = None,
    css_selector: Optional[str] = None,
    **kwargs: Any,
) -> str:
    """Extract structured data from a page and return it as a JSON string."""
    params = _drop_none(
        {
            "url": url,
            "mode": mode,
            "schema": schema,
            "css_selector": css_selector,
            **kwargs,
        }
    )
    try:
        return _to_json(client.extract(**params))
    except WigoloError as exc:
        return _error("extract", exc)
