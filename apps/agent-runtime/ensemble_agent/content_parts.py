"""Image input in model messages. Mirror of apps/hub-api/src/runtime/content-parts.ts.

hub-api writes user content as OpenAI chat parts (``{"type": "text"}`` and
``{"type": "image_url", "image_url": {"url": "data:…;base64,…"}}``); chat-compatible providers
take them as they are, and these helpers rewrite them for the Anthropic Messages and OpenAI
Responses APIs.
"""

from __future__ import annotations

import re
from typing import Any

_DATA_URL = re.compile(r"^data:([a-z0-9.+-]+/[a-z0-9.+-]+);base64,(.*)$", re.IGNORECASE | re.DOTALL)


def _image_url(part: dict[str, Any]) -> str | None:
    if part.get("type") == "image_url":
        inner = part.get("image_url")
        if isinstance(inner, str):
            return inner
        if isinstance(inner, dict) and isinstance(inner.get("url"), str):
            return inner["url"]
    if part.get("type") == "input_image" and isinstance(part.get("image_url"), str):
        return part["image_url"]
    return None


def _detail(part: dict[str, Any]) -> str | None:
    inner = part.get("image_url")
    detail = inner.get("detail") if isinstance(inner, dict) else part.get("detail")
    return detail if isinstance(detail, str) else None


def _text_part(part: Any) -> str | None:
    if isinstance(part, str):
        return part
    if isinstance(part, dict) and isinstance(part.get("text"), str):
        return part["text"]
    return None


def has_image_parts(content: Any) -> bool:
    return isinstance(content, list) and any(
        isinstance(part, dict) and (_image_url(part) is not None or part.get("type") == "image") for part in content
    )


def text_of_parts(content: Any) -> str:
    if isinstance(content, list):
        return "".join(_text_part(part) or "" for part in content)
    return "" if content is None else str(content)


def anthropic_user_content(content: Any) -> str | list[dict[str, Any]]:
    """User content for the Anthropic Messages API: text and image blocks, or the plain string."""
    if not has_image_parts(content):
        return text_of_parts(content)
    blocks: list[dict[str, Any]] = []
    for part in content:
        if isinstance(part, dict) and part.get("type") == "image":
            blocks.append(part)
            continue
        url = _image_url(part) if isinstance(part, dict) else None
        if url:
            match = _DATA_URL.match(url)
            if match:
                blocks.append({"type": "image", "source": {"type": "base64", "media_type": match.group(1).lower(), "data": match.group(2)}})
            else:
                blocks.append({"type": "image", "source": {"type": "url", "url": url}})
            continue
        text = _text_part(part)
        if text:
            blocks.append({"type": "text", "text": text})
    return blocks


def responses_user_content(content: Any) -> str | list[dict[str, Any]]:
    """User content for the Responses API: input_text and input_image parts, or the plain string."""
    if not has_image_parts(content):
        return text_of_parts(content)
    parts: list[dict[str, Any]] = []
    for part in content:
        if isinstance(part, dict) and part.get("type") == "image":
            source = part.get("source") or {}
            if source.get("type") == "base64":
                parts.append({"type": "input_image", "image_url": f"data:{source.get('media_type')};base64,{source.get('data')}"})
            elif isinstance(source.get("url"), str):
                parts.append({"type": "input_image", "image_url": source["url"]})
            continue
        url = _image_url(part) if isinstance(part, dict) else None
        if url:
            detail = _detail(part)
            parts.append({"type": "input_image", "image_url": url, **({"detail": detail} if detail else {})})
            continue
        text = _text_part(part)
        if text:
            parts.append({"type": "input_text", "text": text})
    return parts
