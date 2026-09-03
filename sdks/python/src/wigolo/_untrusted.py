"""The consumer half of the REST ``untrusted_content`` envelope.

The server has two representations for page-derived text. The DEFAULT is ``inline``: the
containment markers are woven into the returned strings, so anything that concatenates them
into a model's context is already safe. The opt-in is ``envelope``: the strings come back
BYTE-CLEAN and the trust boundary travels beside them as an ``untrusted_content`` sibling —
for consumers that hash, dedup, index or persist exactly what the site served, and that
compose the fence only at the point some of that text actually enters a model.

``envelope`` is only a control if something composes it. This module is that something: the
parts the server sends are assembled here, in the one order the server itself uses, so an SDK
consumer never hand-rolls the concatenation and never persists a fence by accident.

No crypto here: the nonce is the SERVER's. An SDK-minted one would be a second source of truth
for a boundary the server already drew.
"""

from __future__ import annotations

from typing import Any, Optional

__all__ = [
    "UNTRUSTED_CONTENT_HEADER",
    "UNTRUSTED_CONTENT_MODES",
    "fence_untrusted",
    "fence_with_envelope",
    "untrusted_content_of",
]

#: Canonical spelling of the representation header.
UNTRUSTED_CONTENT_HEADER = "X-Wigolo-Untrusted-Content"

#: The representations a client may ask for. Absent means the server default (``inline``).
UNTRUSTED_CONTENT_MODES = ("inline", "envelope")

# Stand-in for empty content, mirroring the server's own placeholder. An empty region reads to
# a model as a malformed result; this says "the field was blank" explicitly.
_EMPTY_PAYLOAD = "(empty)"

_REQUIRED_PARTS = ("notice", "nonce", "begin_marker", "end_marker")


def _non_empty_str(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def untrusted_content_of(response: Any) -> Optional[dict]:
    """Read the envelope off a response, or ``None`` when there is none.

    The load-bearing fields are validated rather than trusted: a half-formed envelope would
    compose into a fence whose markers do not match, which is worse than no fence at all
    because it LOOKS contained. ``trusted`` is not checked — the server documents it as
    ignored, and a consumer keying on it would be reading a flag the producer says means
    nothing.
    """
    if not isinstance(response, dict):
        return None
    parts = response.get("untrusted_content")
    if not isinstance(parts, dict):
        return None
    if not all(_non_empty_str(parts.get(field)) for field in _REQUIRED_PARTS):
        return None
    envelope = {
        "trusted": False,
        "notice": parts["notice"],
        "nonce": parts["nonce"],
        "begin_marker": parts["begin_marker"],
        "end_marker": parts["end_marker"],
    }
    if _non_empty_str(parts.get("origin")):
        envelope["origin"] = parts["origin"]
    return envelope


def fence_untrusted(payload: str, parts: dict) -> str:
    """Compose the fence around one payload, in the server's order.

    ``notice \\n begin_marker \\n payload \\n end_marker``.

    WRAP ONCE. The payload goes through byte-exact; passing already-fenced text nests two
    regions and the inner terminator ends the outer one early. Fence at the moment the text
    enters a model, never before it is persisted.
    """
    body = payload if payload else _EMPTY_PAYLOAD
    return f"{parts['notice']}\n{parts['begin_marker']}\n{body}\n{parts['end_marker']}"


def fence_with_envelope(response: Any, payload: str) -> str:
    """The call site that works under BOTH representations, which is the point of it.

    With ``untrusted_content="envelope"`` the response carries the parts and the text is
    byte-clean, so this composes them. Under the server default the text already carries its
    markers inline and there is nothing to add, so it is returned verbatim — fencing it again
    would nest.

    A consumer therefore writes one line at the model boundary and does not branch on which
    mode it asked for.
    """
    parts = untrusted_content_of(response)
    return fence_untrusted(payload, parts) if parts is not None else payload
