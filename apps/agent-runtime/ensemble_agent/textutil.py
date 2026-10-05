"""Truncate text without splitting a grapheme or leaving a lone surrogate.

Python strings are Unicode code points, so a slice cannot split an emoji the
way JavaScript's UTF-16 ``slice`` can. Lone surrogates still cannot be stored
as UTF-8, and a ZWJ sequence should stay together when a length limit hits it.
"""

from __future__ import annotations

import re
import unicodedata

_LONE = re.compile(r"[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]")


def strip_lone_surrogates(value: str) -> str:
    return _LONE.sub("", value or "")


def _graphemes(text: str):
    cluster = ""
    for char in text:
        if not cluster:
            cluster = char
            continue
        category = unicodedata.category(char)
        if char == "\u200d" or cluster.endswith("\u200d") or category.startswith("M"):
            cluster += char
            continue
        yield cluster
        cluster = char
    if cluster:
        yield cluster


def truncate_text(value: str, max_length: int) -> str:
    if max_length <= 0:
        return ""
    text = strip_lone_surrogates(value)
    if len(text) <= max_length:
        return text
    out: list[str] = []
    size = 0
    for cluster in _graphemes(text):
        if size + len(cluster) > max_length:
            break
        out.append(cluster)
        size += len(cluster)
    return "".join(out)


def chunk_text(value: str, size: int = 24) -> list[str]:
    text = strip_lone_surrogates(value)
    if not text or size <= 0:
        return []
    chunks: list[str] = []
    current = ""
    for cluster in _graphemes(text):
        if not current:
            current = cluster
            continue
        if len(current) + len(cluster) > size:
            chunks.append(current)
            current = cluster
            continue
        current += cluster
    if current:
        chunks.append(current)
    return chunks
