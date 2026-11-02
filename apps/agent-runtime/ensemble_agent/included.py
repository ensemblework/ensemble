"""Included AI: the four models the operator deploys on Azure AI Foundry and pays for.

hub-api keeps the credits ledger. Every call here reserves its worst case there before Azure sees
it and settles the reservation with the real usage after (docs/33). Each model answers on the
OpenAI v1 endpoint of the Foundry host it is documented at, on the Responses or the Chat Completions
API; Foundry's Anthropic Messages endpoint is supported too, though no model in the catalog uses it.
Responses and Chat Completions calls stream, so a call that is cancelled (hub-api's Stop, its time
limit, its request closed) closes the stream and Azure stops generating.
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
from ensemble_agent.model_timeout import runtime_seconds
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


Usage = dict[str, int]


class _StreamFailed(Exception):
    """Azure ended a stream with a failure: the error, and the usage it reported (None when it said none)."""

    def __init__(self, error: ProviderError, usage: Usage | None) -> None:
        super().__init__(str(error))
        self.error = error
        self.usage = usage


async def _settled(
    user_id: str,
    reservation: str,
    call: Callable[[], Awaitable[tuple[dict[str, Any], Usage | None]]],
) -> dict[str, Any]:
    """Run one call under its reservation and settle it exactly once.

    A request Azure refused (or never received) is not billed, so it settles at zero. Anything that
    may have been billed without a usage report (a stream cut short, a failure that says no usage)
    settles with no usage: hub-api charges the reservation. The settlement outlives a cancelled call.
    """
    try:
        turn, usage = await call()
    except asyncio.CancelledError:
        _settle_task(user_id, reservation, None)
        raise
    except _StreamFailed as exc:
        await asyncio.shield(_settle_task(user_id, reservation, exc.usage))
        raise exc.error from None
    except (ProviderError, ModelUnreachable):
        await asyncio.shield(_settle_task(user_id, reservation, dict(_NO_USAGE)))
        raise
    except Exception:
        await asyncio.shield(_settle_task(user_id, reservation, None))
        raise
    turn["credits"] = await asyncio.shield(_settle_task(user_id, reservation, usage, str(turn.get("model") or "") or None))
    return turn


# Input tokens reserved per picture, and at most per file sent whole. Mirrors hub-api's runtime/included.ts.
IMAGE_INPUT_ALLOWANCE = 8_000
FILE_INPUT_ALLOWANCE_MAX = 150_000
_DATA = re.compile(r"^data:([a-z0-9.+-]+/[a-z0-9.+-]+);base64,", re.IGNORECASE)


def file_input_allowance(base64_length: int) -> int:
    """A file sent whole: its bytes, at most FILE_INPUT_ALLOWANCE_MAX, plus room for the model's own framing."""
    return min(-(-base64_length * 3 // 4), FILE_INPUT_ALLOWANCE_MAX) + 3_000


def _without_attachments(value: Any) -> tuple[Any, int]:
    """The value with each picture's and file's base64 emptied, and the tokens reserved for them."""
    if isinstance(value, str):
        match = _DATA.match(value[:200])
        if not match:
            return value, 0
        is_image = match.group(1).lower().startswith("image/")
        return "", IMAGE_INPUT_ALLOWANCE if is_image else file_input_allowance(len(value) - len(match.group(0)))
    if isinstance(value, list):
        out, tokens = [], 0
        for item in value:
            clean, found = _without_attachments(item)
            out.append(clean)
            tokens += found
        return out, tokens
    if isinstance(value, dict):
        if value.get("type") == "base64" and isinstance(value.get("data"), str):
            is_image = str(value.get("media_type") or "").lower().startswith("image/")
            return {**value, "data": ""}, IMAGE_INPUT_ALLOWANCE if is_image else file_input_allowance(len(value["data"]))
        out_dict, tokens = {}, 0
        for key, item in value.items():
            clean, found = _without_attachments(item)
            out_dict[key] = clean
            tokens += found
        return out_dict, tokens
    return value, 0


def estimate_input_tokens(payload: dict[str, Any]) -> int:
    """The UTF-8 bytes of the request as sent: a byte-level BPE tokenizer never makes more tokens than
    bytes, so a reservation is never short on input. The same count as hub-api's JSON.stringify. A
    picture's or file's base64 is not tokenized as text, so each picture counts as
    IMAGE_INPUT_ALLOWANCE and each file as file_input_allowance."""
    clean, tokens = _without_attachments(payload)
    return len(json.dumps(clean, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + tokens


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
    """No temperature, top_p or reasoning_effort: the chat model takes no thinking level. Streamed, with the usage at the end."""
    payload = models.build_chat_payload(model, PROVIDER, messages, tools=tools, stream=True)
    payload["stream_options"] = {"include_usage": True}
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
    """Streamed: a call that is stopped closes its stream, and Azure stops generating."""
    history = responses_api.clean_items(items) if items else responses_api.items_from_chat(messages)
    payload = responses_api.build_payload(model, history, tools=responses_api.tools_for(tools) if tools else None, effort=effort, json_mode=json_mode, stream=True)
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


def _usage_of(response: dict[str, Any] | None, read: Callable[[Any], Usage]) -> Usage | None:
    usage = response.get("usage") if isinstance(response, dict) else None
    return read(usage) if isinstance(usage, dict) else None


async def _read_responses(lines: Any, model: str) -> tuple[dict[str, Any], Usage | None]:
    """A Responses stream → the turn and its usage (from ``response.completed``; none when the stream was cut)."""
    final: list[dict[str, Any]] = []
    turn: dict[str, Any] | None = None
    try:
        async for kind, data in responses_api.turn_from_stream(lines, model, final.append):
            if kind == "done":
                turn = data
    except ProviderError as exc:
        raise _StreamFailed(exc, _usage_of(final[-1] if final else None, responses_usage)) from exc
    if turn is None:
        raise ProviderError(502, "other", "The model stream ended without a completion.")
    return turn, _usage_of(final[-1] if final else None, responses_usage)


async def _read_chat(lines: Any, model: str) -> tuple[dict[str, Any], Usage | None]:
    """A Chat Completions stream → the turn and its usage (the last chunk's, with ``include_usage``)."""
    data: dict[str, Any] | None = None
    async for kind, item in models.consume_sse_lines(lines, model):
        if kind == "done":
            data = item
    if data is None:
        raise ProviderError(502, "other", "The model stream ended without a completion.")
    usage = data.get("usage")
    return models._from_openai(data, model), chat_usage(usage) if isinstance(usage, dict) and isinstance(usage.get("prompt_tokens"), int) else None


def _read_whole(data: Any, model: str) -> tuple[dict[str, Any], Usage | None]:
    if not isinstance(data, dict):
        raise ProviderError(502, "other", "The model provider returned a non-JSON response.")
    if isinstance(data.get("choices"), list):
        return models._from_openai(data, model), chat_usage(data.get("usage"))
    return responses_api.turn_from_response(data, model), responses_usage(data.get("usage"))


async def _stream(
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout: float,
    read: Callable[[Any, str], Awaitable[tuple[dict[str, Any], Usage | None]]],
) -> tuple[dict[str, Any], Usage | None]:
    """POST a streamed request, retried as ``post_with_retry`` does while Azure refuses it, and read its stream.

    Cancelling the call closes the stream, and Azure stops generating.
    """
    model = str(payload.get("model") or "")
    attempt = 0
    while True:
        failure: ProviderError | None = None
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as response:
                    if response.is_success and "application/json" in response.headers.get("content-type", ""):
                        # Not a stream (a proxy that ignores ``stream``): read whole.
                        return _read_whole(json.loads(await response.aread()), model)
                    if response.is_success:
                        return await read(response.aiter_lines(), model)
                    raw = await response.aread()
                    failure = models.parse_provider_error(response.status_code, raw.decode("utf-8", errors="replace"), response.headers)
        except (asyncio.CancelledError, ProviderError, _StreamFailed, models.ConnectionDropped, ModelUnreachable):
            raise
        except Exception as exc:
            models._reraise_transport(exc, provider=PROVIDER, model=model, url=url)
        delay = models.retry_plan(failure, attempt)
        if delay is None:
            raise failure
        await asyncio.sleep(delay)
        attempt += 1


async def complete(
    body: dict[str, Any],
    model: str,
    messages: list[dict[str, Any]],
    *,
    items: list[Any] | None = None,
    json_mode: bool = False,
    timeout: float | None = None,
) -> dict[str, Any]:
    """One turn on an included model, in the runtime's turn shape, with ``credits`` from the ledger.

    ``timeout``: seconds to wait for Azure; hub-api's limit and a margin when it is not given.
    """
    seconds = timeout if timeout is not None else runtime_seconds(body)
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

    async def claude() -> tuple[dict[str, Any], Usage | None]:
        try:
            response = await _post(url, headers, payload, seconds)
        except ProviderError as exc:
            if not _thinking_refused(exc):
                raise
            response = await _post(url, headers, without_thinking(payload), seconds)
        data = _json_object(response)
        remember_turn(user_id, data.get("content"))
        return models._anthropic_result(data, model), anthropic_usage(data.get("usage"))

    async def call() -> tuple[dict[str, Any], Usage | None]:
        if entry.api == "anthropic":
            turn, usage = await claude()
        else:
            turn, usage = await _stream(url, headers, payload, seconds, _read_chat if entry.api == "chat" else _read_responses)
        if usage is not None:
            turn["tokensIn"], turn["tokensOut"] = usage["inputTokens"], usage["outputTokens"]
        return turn, usage

    await pace(user_id, PROVIDER)
    reservation = await reserve(user_id, model, estimate_input_tokens(payload), config.max_output_tokens, purpose)
    return await _settled(user_id, reservation, call)
