"""LangChain message helpers.

Provider responses are normally a string in ``message.content``, but
several modern models (Anthropic extended thinking, DeepSeek-Reasoner,
OpenAI o-series, Anthropic citations API) return ``content`` as a list
of typed blocks: ``[{"type": "text", "text": "..."}, {"type":
"thinking", "thinking": "..."}]``. Treating that list as a string
produces empty bubbles + breaks ``[N]`` citation parsing.

``extract_text`` walks both shapes and returns just the user-visible
text, dropping thinking/reasoning blocks. Use it everywhere the agent's
``content`` is consumed as a string (chat handler, stream handler,
draft workflow, thread history).
"""
from __future__ import annotations

from typing import Any


def extract_text(content: Any) -> str:
    """Return the user-visible text from a LangChain message ``content``.

    Accepts:
      * ``str``  — returned as-is.
      * ``list`` of blocks — each block can be a string (returned
        verbatim) or a dict. For dict blocks we keep ``type == "text"``
        (and the legacy ``"output_text"`` from older OpenAI SDKs) and
        skip everything else (thinking / reasoning / tool_use blocks).
      * ``None`` or unknown shape — returns ``""``.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
                continue
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind in ("text", "output_text"):
                t = block.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts)
    # Unknown shape — be conservative; never raise from a hot path.
    return str(content) if content else ""
