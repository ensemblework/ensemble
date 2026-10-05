"""Provider-native web grounding, with a result shape the Hub can cite."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ensemble_agent import credentials
from ensemble_agent.models import ModelAuthError

log = logging.getLogger("ensemble.search")


async def grounded_search(user_id: str | None, provider: str, model: str, query: str) -> list[dict[str, str]]:
    provider = provider or "google"
    if provider == "google":
        return await _gemini(user_id, model, query)
    if provider == "openai":
        return await _openai(user_id, model, query)
    if provider == "anthropic":
        return await _anthropic(user_id, model, query)
    return []


async def _gemini(user_id: str | None, model: str, query: str) -> list[dict[str, str]]:
    cred = credentials.resolve(user_id, "google")
    if not cred.secret:
        raise ModelAuthError("No key for google.")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": query}]}],
        "tools": [{"google_search": {}}],
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(url, headers={"x-goog-api-key": cred.secret}, json=payload)
    except httpx.HTTPError as exc:
        log.warning("gemini grounding failed: %s", exc)
        raise
    if not response.is_success:
        log.warning("gemini grounding HTTP %s", response.status_code)
        return []
    data = response.json()
    chunks = (
        ((data.get("candidates") or [{}])[0].get("groundingMetadata") or {}).get("groundingChunks")
        or []
    )
    results = []
    for chunk in chunks:
        web = chunk.get("web") or {}
        uri = web.get("uri")
        if not uri:
            continue
        results.append({"title": web.get("title") or uri, "url": uri, "snippet": ""})
    return results[:8]


async def _openai(user_id: str | None, model: str, query: str) -> list[dict[str, str]]:
    cred = credentials.resolve(user_id, "openai")
    if not cred.secret:
        return []
    payload = {
        "model": model,
        "tools": [{"type": "web_search_preview"}],
        "input": query,
    }
    async with httpx.AsyncClient(timeout=25) as client:
        response = await client.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {cred.secret}"},
            json=payload,
        )
    if not response.is_success:
        return []
    results = []
    for item in response.json().get("output") or []:
        if item.get("type") != "message":
            continue
        for block in item.get("content") or []:
            for annotation in block.get("annotations") or []:
                url = annotation.get("url")
                if url:
                    results.append({"title": annotation.get("title") or url, "url": url, "snippet": ""})
    return results[:8]


async def _anthropic(user_id: str | None, model: str, query: str) -> list[dict[str, str]]:
    cred = credentials.resolve(user_id, "anthropic")
    if not cred.secret:
        return []
    payload: dict[str, Any] = {
        "model": model,
        "max_tokens": 800,
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],
        "messages": [{"role": "user", "content": query}],
    }
    async with httpx.AsyncClient(timeout=25) as client:
        response = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": cred.secret, "anthropic-version": "2023-06-01"},
            json=payload,
        )
    if not response.is_success:
        return []
    results = []
    for block in response.json().get("content") or []:
        if block.get("type") != "web_search_tool_result":
            continue
        for item in block.get("content") or []:
            if isinstance(item, dict) and item.get("url"):
                results.append({"title": item.get("title") or item["url"], "url": item["url"], "snippet": item.get("encrypted_content") and "" or (item.get("page_age") or "")})
    return results[:8]
