"""Pictures and files in model messages. Mirror of apps/hub-api/src/runtime/content-parts.ts.

hub-api writes user content as OpenAI chat parts (``{"type": "text"}``,
``{"type": "image_url", "image_url": {"url": "data:…;base64,…"}}`` and
``{"type": "file", "file": {"filename": …, "file_data": "data:…;base64,…"}}``); chat-compatible
providers take them as they are, and these helpers rewrite them for the Anthropic Messages and
OpenAI Responses APIs.
"""

from __future__ import annotations

import base64
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


_TEXT_MEDIA = re.compile(r"^(text/|application/(json|xml|x-ndjson))", re.IGNORECASE)


def _file(part: dict[str, Any]) -> tuple[str, str] | None:
    """A file part (chat ``file``, Responses ``input_file``, Anthropic ``document``) as name and data URL."""
    if part.get("type") == "file" and isinstance(part.get("file"), dict) and isinstance(part["file"].get("file_data"), str):
        return str(part["file"].get("filename") or "file"), part["file"]["file_data"]
    if part.get("type") == "input_file" and isinstance(part.get("file_data"), str):
        return str(part.get("filename") or "file"), part["file_data"]
    if part.get("type") == "document" and isinstance(part.get("source"), dict):
        source = part["source"]
        name = str(part.get("title") or "file")
        if source.get("type") == "base64" and isinstance(source.get("data"), str):
            return name, f"data:{source.get('media_type')};base64,{source['data']}"
        if source.get("type") == "text" and isinstance(source.get("data"), str):
            return name, "data:text/plain;base64," + base64.b64encode(source["data"].encode("utf-8")).decode("ascii")
    return None


def has_file_parts(content: Any) -> bool:
    return isinstance(content, list) and any(isinstance(part, dict) and _file(part) is not None for part in content)


def has_attachment_parts(content: Any) -> bool:
    """Pictures or files: content that must keep its parts on the way to a provider."""
    return has_image_parts(content) or has_file_parts(content)


def _anthropic_file_block(name: str, data_url: str) -> dict[str, Any]:
    match = _DATA_URL.match(data_url)
    mime = match.group(1).lower() if match else ""
    if match and _TEXT_MEDIA.match(mime):
        text = base64.b64decode(match.group(2)).decode("utf-8", errors="replace")
        return {"type": "document", "source": {"type": "text", "media_type": "text/plain", "data": text}, "title": name}
    if match:
        return {"type": "document", "source": {"type": "base64", "media_type": mime, "data": match.group(2)}, "title": name}
    return {"type": "text", "text": f"[{name} could not be read from its data.]"}


def text_of_parts(content: Any) -> str:
    if isinstance(content, list):
        return "".join(_text_part(part) or "" for part in content)
    return "" if content is None else str(content)


def anthropic_user_content(content: Any) -> str | list[dict[str, Any]]:
    """User content for the Anthropic Messages API: text and image blocks, or the plain string."""
    if not has_attachment_parts(content):
        return text_of_parts(content)
    blocks: list[dict[str, Any]] = []
    for part in content:
        if isinstance(part, dict) and part.get("type") in ("image", "document"):
            blocks.append(part)
            continue
        found = _file(part) if isinstance(part, dict) else None
        if found:
            blocks.append(_anthropic_file_block(*found))
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
    if not has_attachment_parts(content):
        return text_of_parts(content)
    parts: list[dict[str, Any]] = []
    for part in content:
        found = _file(part) if isinstance(part, dict) else None
        if found:
            parts.append({"type": "input_file", "filename": found[0], "file_data": found[1]})
            continue
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
