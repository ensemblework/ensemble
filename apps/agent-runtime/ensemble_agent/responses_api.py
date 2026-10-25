"""OpenAI's Responses API, for the models a provider serves only there.

GitHub Copilot answers ``model "gpt-5.4-mini" is not accessible via the /chat/completions endpoint``
for some models (gpt-5.4, gpt-5.4-mini, the gpt-5.x codex models); they take ``POST /responses``
instead. This module builds that request from the runtime's history and tools, reads the reply and
its stream, and returns the same turn shape as a chat completion, so the rest of the runtime and
hub-api see one kind of turn whichever endpoint answered.

Which endpoint a model takes: what the provider's model list said (``supported_endpoints``), else
what a refusal taught this process, else gpt-5 and o-series names go to /responses first.
"""

from __future__ import annotations

import json
import re
from typing import Any, AsyncIterator

from ensemble_agent.content_parts import has_image_parts, responses_user_content
from ensemble_agent.provider_error import ProviderError

# Providers whose models may need /responses. Other OpenAI-compatible providers stay on chat.
RESPONSES_PROVIDERS = frozenset({"copilot"})

_RESPONSES_FIRST = re.compile(r"^(gpt-5|o[1-9]\b|o[1-9]-|codex)", re.IGNORECASE)
_learned: dict[tuple[str, str], str] = {}


def api_for(provider: str, model: str) -> str:
    """``"responses"`` or ``"chat"`` for one model of one provider."""
    if provider not in RESPONSES_PROVIDERS:
        return "chat"
    known = _learned.get((provider, model))
    if known:
        return known
    return "responses" if _RESPONSES_FIRST.search(model or "") else "chat"


def learn(provider: str, model: str, api: str) -> None:
    if provider in RESPONSES_PROVIDERS and api in ("chat", "responses") and model:
        _learned[(provider, model)] = api


def learn_from_listing(provider: str, rows: list[dict[str, Any]]) -> None:
    """A model list that says which endpoints each model takes settles it for those models."""
    for row in rows:
        endpoints = row.get("supported_endpoints")
        model = row.get("id")
        if not isinstance(model, str) or not isinstance(endpoints, list):
            continue
        names = {str(item) for item in endpoints}
        if "/chat/completions" in names:
            learn(provider, model, "chat")
        elif "/responses" in names:
            learn(provider, model, "responses")


def forget_learned() -> None:
    _learned.clear()


def other_endpoint(error: ProviderError) -> str | None:
    """The endpoint to use instead, when the provider refused the model on the one we called."""
    if error.status not in (400, 404, 422):
        return None
    text = error.message.lower()
    refused = any(word in text for word in ("not accessible", "not supported", "unsupported", "does not support"))
    if not refused:
        return None
    if "/chat/completions" in text or "chat completions" in text:
        return "responses"
    if "/responses" in text or "responses api" in text:
        return "chat"
    return None


def _text(content: Any) -> str:
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict):
                parts.append(str(part.get("text") or ""))
            else:
                parts.append(str(part))
        return "".join(parts)
    return "" if content is None else str(content)


def _arguments(value: Any) -> str:
    if isinstance(value, str):
        return value or "{}"
    try:
        return json.dumps(value if value is not None else {})
    except (TypeError, ValueError):
        return "{}"


def items_from_chat(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Chat-completion history → Responses input items."""
    items: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "tool":
            items.append({"type": "function_call_output", "call_id": str(message.get("tool_call_id") or ""), "output": _text(message.get("content"))})
            continue
        text = _text(message.get("content"))
        if role == "assistant":
            if text.strip():
                items.append({"role": "assistant", "content": text})
            for call in message.get("tool_calls") or []:
                if not isinstance(call, dict):
                    continue
                fn = call.get("function") or {}
                items.append(
                    {
                        "type": "function_call",
                        "call_id": str(call.get("id") or ""),
                        "name": str(fn.get("name") or ""),
                        "arguments": _arguments(fn.get("arguments")),
                    }
                )
            continue
        if role == "user":
            items.append({"role": role, "content": responses_user_content(message.get("content"))})
        elif role in ("system", "developer"):
            items.append({"role": role, "content": text})
    return items


def clean_items(items: list[Any]) -> list[dict[str, Any]]:
    """hub-api's Responses-shaped history, made safe to send with ``store: false``.

    Reasoning items and provider item ids point at stored responses, which are not kept, so they
    are dropped; an earlier reply's message item becomes a plain assistant message.
    """
    out: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "reasoning":
            continue
        if kind == "message":
            text = _text(item.get("content"))
            if text.strip():
                entry = {"role": str(item.get("role") or "assistant"), "content": text}
                if not out or out[-1] != entry:
                    out.append(entry)
            continue
        if kind == "function_call":
            out.append(
                {
                    "type": "function_call",
                    "call_id": str(item.get("call_id") or item.get("id") or ""),
                    "name": str(item.get("name") or ""),
                    "arguments": _arguments(item.get("arguments")),
                }
            )
            continue
        if kind == "function_call_output":
            output = item.get("output")
            out.append({"type": "function_call_output", "call_id": str(item.get("call_id") or ""), "output": output if isinstance(output, str) else _arguments(output)})
            continue
        role = item.get("role")
        if role == "user" and has_image_parts(item.get("content")):
            out.append({"role": role, "content": responses_user_content(item.get("content"))})
            continue
        if role in ("system", "developer", "user", "assistant"):
            text = _text(item.get("content"))
            if role == "assistant" and not text.strip():
                continue
            entry = {"role": role, "content": text}
            if not out or out[-1] != entry:
                out.append(entry)
    return out


def tools_for(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Chat-completion tool specs → Responses tool specs (a spec already in that shape stays)."""
    out: list[dict[str, Any]] = []
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function")
        if isinstance(fn, dict):
            spec: dict[str, Any] = {"type": "function", "name": fn.get("name") or "", "strict": False}
            if fn.get("description"):
                spec["description"] = fn["description"]
            spec["parameters"] = fn.get("parameters") or {"type": "object", "properties": {}}
            out.append(spec)
        elif tool.get("name"):
            spec = {"type": "function", "name": tool["name"], "strict": False}
            if tool.get("description"):
                spec["description"] = tool["description"]
            spec["parameters"] = tool.get("parameters") or {"type": "object", "properties": {}}
            out.append(spec)
    return out


def build_payload(
    model: str,
    items: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    effort: str | None = None,
    json_mode: bool = False,
    stream: bool = False,
) -> dict[str, Any]:
    """A Responses request. No temperature: the reasoning models that need this endpoint refuse it."""
    payload: dict[str, Any] = {"model": model, "input": items, "store": False}
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    if effort:
        payload["reasoning"] = {"effort": effort}
    if json_mode:
        payload["text"] = {"format": {"type": "json_object"}}
    if stream:
        payload["stream"] = True
    return payload


def turn_from_response(data: dict[str, Any], model: str) -> dict[str, Any]:
    """A Responses reply → the runtime's turn (text, tool calls, tokens, finish)."""
    texts: list[str] = []
    calls: list[dict[str, str]] = []
    reasoning: list[str] = []
    output = data.get("output") if isinstance(data.get("output"), list) else []
    for item in output:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "message":
            for part in item.get("content") or []:
                if isinstance(part, dict) and part.get("type") in ("output_text", "text"):
                    texts.append(str(part.get("text") or ""))
        elif kind == "function_call":
            calls.append({"id": str(item.get("call_id") or item.get("id") or ""), "name": str(item.get("name") or ""), "arguments": _arguments(item.get("arguments"))})
        elif kind == "reasoning":
            for part in item.get("summary") or []:
                if isinstance(part, dict) and part.get("text"):
                    reasoning.append(str(part["text"]))
    if not texts and isinstance(data.get("output_text"), str):
        texts.append(data["output_text"])
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    status = data.get("status")
    incomplete = data.get("incomplete_details") if isinstance(data.get("incomplete_details"), dict) else {}
    if status == "completed" or status is None:
        reason = "tool_calls" if calls else "stop"
        cut_off = False
    else:
        reason = str(incomplete.get("reason") or status)
        cut_off = True
    kept = [item for item in output if isinstance(item, dict) and item.get("type") != "reasoning"]
    return {
        "text": "".join(texts),
        "toolCalls": calls,
        "model": data.get("model") or model,
        "credits": None,
        "tokensIn": usage.get("input_tokens"),
        "tokensOut": usage.get("output_tokens"),
        "reasoning": "\n".join(reasoning),
        "finishReason": reason,
        "cutOff": cut_off,
        "raw": {"output": kept, "model": data.get("model") or model, "status": status, "api": "responses"},
    }


def _failure_message(error: Any) -> str:
    if isinstance(error, dict):
        return str(error.get("message") or error.get("code") or "The model reply failed.")
    return str(error or "The model reply failed.")


async def turn_from_stream(lines: AsyncIterator[str], model: str) -> AsyncIterator[tuple[str, Any]]:
    """SSE lines of a Responses stream → ("delta", text) … then ("done", turn).

    A stream that ends without ``response.completed`` keeps what arrived and is marked cut off.
    """
    pieces: list[str] = []
    final: dict[str, Any] | None = None
    async for raw in lines:
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "response.output_text.delta":
            delta = str(event.get("delta") or "")
            if delta:
                pieces.append(delta)
                yield ("delta", delta)
        elif kind in ("response.completed", "response.incomplete"):
            response = event.get("response")
            if isinstance(response, dict):
                final = response
        elif kind == "response.failed":
            response = event.get("response") if isinstance(event.get("response"), dict) else {}
            raise ProviderError(502, "other", _failure_message(response.get("error")))
        elif kind == "error":
            raise ProviderError(int(event.get("status") or 502), "other", _failure_message(event.get("error") or event))
    if final is None:
        yield ("done", {**turn_from_response({"output": [{"type": "message", "content": [{"type": "output_text", "text": "".join(pieces)}]}], "status": "incomplete", "incomplete_details": {"reason": "stream ended"}}, model)})
        return
    turn = turn_from_response(final, model)
    if not turn["text"] and pieces:
        turn["text"] = "".join(pieces)
    yield ("done", turn)
