"""Included AI: the four models the operator deploys on Azure AI Foundry and pays for.

hub-api keeps the credits ledger. Every call here reserves its worst case there before Azure sees
it and settles the reservation with the real usage after (docs/33). Each model answers on the
OpenAI v1 endpoint of the Foundry host it is documented at, on the Responses or the Chat Completions
API; Foundry's Anthropic Messages endpoint is supported too, though no model in the catalog uses it.
The Azure key is read from the environment here only: it is never a credential, never listed, and
never returned. apps/hub-api/src/runtime/included.ts is the same transport for the in-process runtime.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
import os
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from ensemble_agent import models, responses_api
from ensemble_agent.config import get_settings
from ensemble_agent.provider_error import INCLUDED_NOT_SET_UP as NOT_SET_UP, ProviderError
from ensemble_agent.rate_limit import pace
from ensemble_agent.reach import ModelUnreachable

PROVIDER = "ensemble"
# The reply cap when ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS is unset; must match INCLUDED_DEFAULT_MAX_OUTPUT_TOKENS
# in shared-types. Reasoning models count their reasoning tokens against it.
DEFAULT_MAX_OUTPUT_TOKENS = 16_000

CREDITS_USED = "included_credits_used"
PAUSED = "included_paused"
UNAVAILABLE = "included_unavailable"

CHECK_FAILED = "Ensemble could not check your credits just now. Try again in a moment."


@dataclass(frozen=True)
class IncludedModel:
    # "responses", "chat" (OpenAI v1 APIs) or "anthropic" (Foundry's Messages endpoint).
    api: str
    # "openai": {resource}.openai.azure.com. "services": {resource}.services.ai.azure.com.
    host: str
    label: str
    # The model version Azure lists for the deployment, where it is a dated release.
    version: str | None
    # The thinking levels the model takes. Any other level is not sent.
    efforts: tuple[str, ...]
    # Offered when ENSEMBLE_INCLUDED_MODELS is unset; the others only when it names them.
    by_default: bool = True


_LEVELS = ("low", "medium", "high")

# Must match INCLUDED_MODELS in packages/shared-types/src/included.ts. The id is also the Azure deployment name.
MODELS: dict[str, IncludedModel] = {
    "gpt-6-luna": IncludedModel("responses", "openai", "GPT-6 Luna", "2026-09-22", _LEVELS),
    "deepseek-v4-flash": IncludedModel("chat", "services", "DeepSeek V4 Flash", None, ()),
    "gpt-6.1-sol": IncludedModel("responses", "openai", "GPT-6.1 Sol", "2026-09-29", _LEVELS),
    "grok-4.7": IncludedModel("responses", "services", "Grok 4.7", None, _LEVELS),
    # For testing on an Azure free account, whose quota tier gives the four above no tokens.
    "gpt-5-mini": IncludedModel("responses", "openai", "GPT-5 mini", "2025-08-07", _LEVELS, by_default=False),
    "gpt-4.1-mini": IncludedModel("responses", "openai", "GPT-4.1 mini", "2025-04-14", (), by_default=False),
}

# How a Claude model answers without thinking, at effort high or below.
_THINKING_OFF: dict[str, dict[str, str]] = {
    "claude-haiku-5-5": {"type": "disabled"},
    "claude-sonnet-5-5": {"type": "between_tools"},
}

_RESOURCE = re.compile(r"[a-z0-9][a-z0-9-]{1,62}", re.IGNORECASE)
_NO_USAGE: dict[str, int] = {"inputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0}
_THINKING_CACHE_SIZE = 2000
# (user, first tool_use id) → the content Claude returned for that turn, thinking blocks and signatures included.
_thinking: OrderedDict[str, list[Any]] = OrderedDict()
# Settlements still running after their call was cancelled. The loop keeps only weak references to tasks.
_settling: set[asyncio.Task[Any]] = set()

log = logging.getLogger("ensemble.included")


class IncludedConfigError(ValueError):
    """The included-AI environment variables are set but wrong."""


class IncludedLimitError(Exception):
    """Why an included call did not run: credits used up, the shared budget paused, or not available."""

    def __init__(self, code: str, message: str, resets_at: str | None = None, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.resets_at = resets_at
        self.status = int(status) if status else (503 if code == UNAVAILABLE else 429)

    def to_dict(self) -> dict[str, Any]:
        return {"message": self.message, "kind": "credits", "status": self.status, "code": self.code, "resetsAt": self.resets_at}


@dataclass(frozen=True)
class IncludedConfig:
    resource: str
    api_key: str
    models: tuple[str, ...]
    # max_tokens / max_output_tokens on every included call, and what each reservation holds for the reply.
    max_output_tokens: int


def _output_cap(source: Mapping[str, str]) -> int:
    name = "ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS"
    raw = (source.get(name) or "").strip()
    if not raw:
        return DEFAULT_MAX_OUTPUT_TOKENS
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value <= 0:
        raise IncludedConfigError(f"{name} must be a positive number.")
    if not value.is_integer() or value > 128_000:
        raise IncludedConfigError(f"{name} must be a whole number up to 128000.")
    return int(value)


def included_config(env: Mapping[str, str] | None = None) -> IncludedConfig | None:
    """None when included AI is not set up or is switched off. The rules of hub-api's includedConfig()."""
    source = os.environ if env is None else env
    resource = (source.get("AZURE_FOUNDRY_RESOURCE") or "").strip()
    api_key = (source.get("AZURE_FOUNDRY_API_KEY") or "").strip()
    listed = (source.get("ENSEMBLE_INCLUDED_MODELS") or "").strip()
    if not resource or not api_key or listed.lower() == "off":
        return None
    if not _RESOURCE.fullmatch(resource):
        raise IncludedConfigError("AZURE_FOUNDRY_RESOURCE is the resource name, such as ensemble-ai, not a URL.")
    wanted = list(dict.fromkeys(part.strip() for part in listed.split(",") if part.strip())) if listed else None
    if wanted is not None:
        unknown = [name for name in wanted if name not in MODELS]
        if unknown:
            raise IncludedConfigError(f"ENSEMBLE_INCLUDED_MODELS names models Ensemble does not include: {', '.join(unknown)}.")
    chosen = tuple(name for name, entry in MODELS.items() if (entry.by_default if wanted is None else name in wanted))
    if not chosen:
        return None
    return IncludedConfig(resource=resource, api_key=api_key, models=chosen, max_output_tokens=_output_cap(source))


def model_name(model: str) -> str:
    """The name people see: Grok 4.7, or GPT-6 Luna (2026-09-22) for a dated release."""
    known = MODELS.get(model)
    if not known:
        return model
    return f"{known.label} ({known.version})" if known.version else known.label


def anthropic_url(resource: str) -> str:
    return f"https://{resource}.services.ai.azure.com/anthropic/v1/messages"


def openai_base(resource: str, host: str) -> str:
    """The OpenAI v1 endpoint (no api-version) on the host a model is documented at."""
    if host == "services":
        return f"https://{resource}.services.ai.azure.com/openai/v1"
    return f"https://{resource}.openai.azure.com/openai/v1"


def _configured(model: str) -> IncludedConfig:
    try:
        config = included_config()
    except IncludedConfigError as exc:
        log.error("included AI is misconfigured: %s", exc)
        raise IncludedLimitError(UNAVAILABLE, NOT_SET_UP) from exc
    if config is None:
        raise IncludedLimitError(UNAVAILABLE, NOT_SET_UP)
    if model not in config.models:
        raise IncludedLimitError(UNAVAILABLE, f"{model_name(model)} is not offered on this server. Pick another included model in Settings → Models.")
    return config


# ── the credits ledger in hub-api ───────────────────────────────────────────


def _ledger(path: str, user_id: str) -> tuple[str, dict[str, str]]:
    settings = get_settings()
    return f"{settings.hub_api}/api/internal/included/{path}", {"x-ensemble-internal": settings.internal_token, "x-ensemble-user": user_id}


def _refusal(response: httpx.Response) -> IncludedLimitError | None:
    try:
        data = response.json()
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("code") not in (CREDITS_USED, PAUSED, UNAVAILABLE):
        return None
    message = data.get("message") or data.get("error")
    resets_at = data.get("resetsAt")
    return IncludedLimitError(
        str(data["code"]),
        str(message) if message else NOT_SET_UP,
        resets_at if isinstance(resets_at, str) else None,
        response.status_code,
    )


async def reserve(user_id: str, model: str, input_tokens: int, max_output_tokens: int, purpose: str | None = None) -> str:
    """Hold the call's worst case against the account's credits and the shared budget. Fails closed."""
    url, headers = _ledger("reserve", user_id)
    body: dict[str, Any] = {"model": model, "inputTokens": input_tokens, "maxOutputTokens": max_output_tokens}
    if purpose:
        # hub-api's reserve route refuses a longer label, which would fail the call closed.
        body["purpose"] = purpose[:80]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(url, headers=headers, json=body)
    except Exception as exc:
        log.warning("included reserve failed: %s", type(exc).__name__)
        raise IncludedLimitError(UNAVAILABLE, CHECK_FAILED, None, 503) from exc
    if response.status_code in (429, 503):
        refused = _refusal(response)
        if refused is not None:
            raise refused
    if response.status_code == 200:
        try:
            reservation = response.json().get("id")
        except (ValueError, AttributeError):
            reservation = None
        if isinstance(reservation, str) and reservation:
            return reservation
    log.warning("included reserve answered HTTP %s", response.status_code)
    raise IncludedLimitError(UNAVAILABLE, CHECK_FAILED, None, 503)


async def settle(user_id: str, reservation: str, usage: dict[str, int] | None, answered_by: str | None = None) -> float | None:
    """The credits the call cost, or None when hub-api could not be told (it charges the reservation later)."""
    url, headers = _ledger("settle", user_id)
    body: dict[str, Any] = {"id": reservation, "usage": usage}
    if answered_by:
        body["answeredBy"] = answered_by
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(url, headers=headers, json=body)
        if response.status_code == 200:
            credits = response.json().get("credits")
            if isinstance(credits, (int, float)) and not isinstance(credits, bool):
                return credits
        log.warning("included settle of %s answered HTTP %s", reservation, response.status_code)
    except Exception as exc:
        log.warning("included settle of %s failed: %s", reservation, type(exc).__name__)
    return None


def _settle_task(user_id: str, reservation: str, usage: dict[str, int] | None, answered_by: str | None = None) -> asyncio.Task[float | None]:
    task = asyncio.get_running_loop().create_task(settle(user_id, reservation, usage, answered_by))
    _settling.add(task)
    task.add_done_callback(_settling.discard)
    return task


async def _settled(
    user_id: str,
    reservation: str,
    send: Callable[[], Awaitable[httpx.Response]],
    read: Callable[[httpx.Response], tuple[dict[str, Any], dict[str, int]]],
) -> dict[str, Any]:
    """Run one call under its reservation and settle it exactly once.

    A request Azure refused (or never received) is not billed, so it settles at zero. Anything that
    may have been billed without a usage report settles with no usage: hub-api charges the reservation.
    The settlement outlives a cancelled call.
    """
    try:
        response = await send()
    except asyncio.CancelledError:
        _settle_task(user_id, reservation, None)
        raise
    except (ProviderError, ModelUnreachable):
        await asyncio.shield(_settle_task(user_id, reservation, dict(_NO_USAGE)))
        raise
    except Exception:
        await asyncio.shield(_settle_task(user_id, reservation, None))
        raise
    try:
        turn, usage = read(response)
    except Exception:
        await asyncio.shield(_settle_task(user_id, reservation, None))
        raise
    turn["credits"] = await asyncio.shield(_settle_task(user_id, reservation, usage, str(turn.get("model") or "") or None))
    return turn


def estimate_input_tokens(payload: dict[str, Any]) -> int:
    """The UTF-8 bytes of the request as sent: a byte-level BPE tokenizer never makes more tokens than
    bytes, so a reservation is never short on input. The same count as hub-api's JSON.stringify."""
    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


# ── usage ───────────────────────────────────────────────────────────────────


def _count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        return 0
    return int(value)


def anthropic_usage(usage: Any) -> dict[str, int]:
    """Anthropic counts cache reads and writes outside ``input_tokens``; the ledger wants every input token."""
    row = usage if isinstance(usage, dict) else {}
    read = _count(row.get("cache_read_input_tokens"))
    write = _count(row.get("cache_creation_input_tokens"))
    return {
        "inputTokens": _count(row.get("input_tokens")) + read + write,
        "cacheReadTokens": read,
        "cacheWriteTokens": write,
        "outputTokens": _count(row.get("output_tokens")),
    }


def chat_usage(usage: Any) -> dict[str, int]:
    """Chat Completions counts cache reads in ``prompt_tokens_details``; DeepSeek's own field is ``prompt_cache_hit_tokens``."""
    row = usage if isinstance(usage, dict) else {}
    details = row.get("prompt_tokens_details") if isinstance(row.get("prompt_tokens_details"), dict) else {}
    cached = details.get("cached_tokens") if details.get("cached_tokens") is not None else row.get("prompt_cache_hit_tokens")
    return {
        "inputTokens": _count(row.get("prompt_tokens")),
        "cacheReadTokens": _count(cached),
        "cacheWriteTokens": 0,
        "outputTokens": _count(row.get("completion_tokens")),
    }


def responses_usage(usage: Any) -> dict[str, int]:
    row = usage if isinstance(usage, dict) else {}
    details = row.get("input_tokens_details") if isinstance(row.get("input_tokens_details"), dict) else {}
    return {
        "inputTokens": _count(row.get("input_tokens")),
        "cacheReadTokens": _count(details.get("cached_tokens")),
        "cacheWriteTokens": _count(details.get("cache_write_tokens")),
        "outputTokens": _count(row.get("output_tokens")),
    }


# ── Claude: thinking blocks across tool rounds ──────────────────────────────


def _first_tool_use(content: Any) -> str | None:
    if not isinstance(content, list):
        return None
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id"):
            return str(block["id"])
    return None


def remember_turn(user_id: str, content: Any) -> None:
    """Keep a tool-calling turn as Claude returned it. The history hub-api sends back has no thinking blocks."""
    first = _first_tool_use(content)
    if not first:
        return
    key = f"{user_id}\0{first}"
    _thinking[key] = copy.deepcopy(content)
    _thinking.move_to_end(key)
    while len(_thinking) > _THINKING_CACHE_SIZE:
        _thinking.popitem(last=False)


def replay_thinking(user_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Anthropic-shaped history with each remembered tool-calling turn sent back exactly as Claude wrote it."""
    out: list[dict[str, Any]] = []
    for message in messages:
        first = _first_tool_use(message.get("content")) if message.get("role") == "assistant" else None
        key = f"{user_id}\0{first}" if first else ""
        cached = _thinking.get(key) if key else None
        if cached is None:
            out.append(message)
            continue
        _thinking.move_to_end(key)
        out.append({"role": "assistant", "content": copy.deepcopy(cached)})
    return out


def _thinking_refused(error: ProviderError) -> bool:
    text = error.message.lower()
    return error.status == 400 and ("thinking" in text or "signature" in text)


def without_thinking(payload: dict[str, Any]) -> dict[str, Any]:
    """The same request with no thinking blocks in its history and thinking off for this reply."""
    messages: list[dict[str, Any]] = []
    for message in payload.get("messages") or []:
        content = message.get("content")
        if message.get("role") == "assistant" and isinstance(content, list):
            kept = [block for block in content if not (isinstance(block, dict) and block.get("type") in ("thinking", "redacted_thinking"))]
            message = {**message, "content": kept or [{"type": "text", "text": ""}]}
        messages.append(message)
    model = str(payload.get("model") or "")
    return {**payload, "messages": messages, "thinking": dict(_THINKING_OFF.get(model, {"type": "disabled"}))}


def claude_payload(
    user_id: str, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]], effort: str | None, max_tokens: int
) -> dict[str, Any]:
    """No temperature or top_p (these models refuse them) and no ``thinking``: adaptive thinking is their default."""
    system, converted = models._to_anthropic(messages)
    payload: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": replay_thinking(user_id, converted)}
    if system:
        payload["system"] = system
    if tools:
        payload["tools"] = tools
    if effort:
        payload["output_config"] = {"effort": effort}
    return payload


def chat_payload(model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None, json_mode: bool, max_tokens: int) -> dict[str, Any]:
    """No temperature, top_p or reasoning_effort: the chat model takes no thinking level."""
    payload = models.build_chat_payload(model, PROVIDER, messages, tools=tools)
    payload["max_completion_tokens"] = max_tokens
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    return payload


def responses_payload(
    model: str,
    messages: list[dict[str, Any]],
    items: list[Any] | None,
    tools: list[dict[str, Any]] | None,
    effort: str | None,
    json_mode: bool,
    max_tokens: int,
) -> dict[str, Any]:
    history = responses_api.clean_items(items) if items else responses_api.items_from_chat(messages)
    payload = responses_api.build_payload(model, history, tools=responses_api.tools_for(tools) if tools else None, effort=effort, json_mode=json_mode)
    payload["max_output_tokens"] = max_tokens
    return payload


# ── the call ────────────────────────────────────────────────────────────────


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
    except ValueError as exc:
        raise ProviderError(502, "other", "The model provider returned a non-JSON response.") from exc
    if not isinstance(data, dict):
        raise ProviderError(502, "other", "The model provider returned a non-JSON response.")
    return data


async def _post(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float) -> httpx.Response:
    async def send(current: dict[str, Any]) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                return await client.post(url, headers=headers, json=current)
        except Exception as exc:
            models._reraise_transport(exc, provider=PROVIDER, model=str(current.get("model") or ""), url=url)

    return await models.post_with_retry(send, payload)


async def complete(
    body: dict[str, Any],
    model: str,
    messages: list[dict[str, Any]],
    *,
    items: list[Any] | None = None,
    json_mode: bool = False,
    timeout: float = 300.0,
) -> dict[str, Any]:
    """One turn on an included model, in the runtime's turn shape, with ``credits`` from the ledger."""
    config = _configured(model)
    user_id = body.get("userId")
    if not isinstance(user_id, str) or not user_id:
        raise IncludedLimitError(UNAVAILABLE, "A signed-in account is required to use included models.")
    purpose = body.get("purpose") if isinstance(body.get("purpose"), str) else None
    entry = MODELS[model]
    level = models._effort(PROVIDER, body.get("reasoningEffort"), model)
    effort = level if level in entry.efforts else None
    if entry.api == "anthropic":
        payload = claude_payload(user_id, model, messages, models._anthropic_tools(body), effort, config.max_output_tokens)
        url = anthropic_url(config.resource)
        headers = {"api-key": config.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    elif entry.api == "chat":
        payload = chat_payload(model, messages, body.get("chatTools") or None, json_mode, config.max_output_tokens)
        url = f"{openai_base(config.resource, entry.host)}/chat/completions"
        headers = {"api-key": config.api_key}
    else:
        tools = body.get("responsesTools") or body.get("chatTools") or None
        payload = responses_payload(model, messages, items, tools, effort, json_mode, config.max_output_tokens)
        url = f"{openai_base(config.resource, entry.host)}/responses"
        headers = {"api-key": config.api_key}

    async def send() -> httpx.Response:
        try:
            return await _post(url, headers, payload, timeout)
        except ProviderError as exc:
            if entry.api != "anthropic" or not _thinking_refused(exc):
                raise
            return await _post(url, headers, without_thinking(payload), timeout)

    def read(response: httpx.Response) -> tuple[dict[str, Any], dict[str, int]]:
        data = _json_object(response)
        if entry.api == "anthropic":
            remember_turn(user_id, data.get("content"))
            turn, usage = models._anthropic_result(data, model), anthropic_usage(data.get("usage"))
        elif entry.api == "chat":
            turn, usage = models._from_openai(data, model), chat_usage(data.get("usage"))
        else:
            turn, usage = responses_api.turn_from_response(data, model), responses_usage(data.get("usage"))
        turn["tokensIn"], turn["tokensOut"] = usage["inputTokens"], usage["outputTokens"]
        return turn, usage

    await pace(user_id, PROVIDER)
    reservation = await reserve(user_id, model, estimate_input_tokens(payload), config.max_output_tokens, purpose)
    return await _settled(user_id, reservation, send, read)
