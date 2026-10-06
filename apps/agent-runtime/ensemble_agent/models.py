"""Pluggable model adapters.

Complexity maps to a {provider, model, effort?} profile chosen in Settings.
hub-api sends the provider it wants; this module resolves the credential
(credentials.py) and speaks that vendor's API. A provider with no key is a
clear error, never a silent fallback to another vendor.

Chat-with-tools providers speak an OpenAI-compatible API: Gemini, OpenAI,
OpenRouter, Ollama, Copilot, Mistral, Kimi (Moonshot) and Qwen (DashScope).
Anthropic uses the native Messages API.
Cursor is an agent runtime, not a chat endpoint: its key is validated and its
agent models listed here. Delegated runs use it; the Hub chat does not.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import random
import re
import time
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Iterator, Literal

import httpx
from ensemble_agent.hosted_access import HostedAccessError, HostedAccessUnavailable, can_use_host_credentials, require_host_access, require_verified_user

from ensemble_agent import credentials
from ensemble_agent.provider_error import ProviderError, parse_provider_error
from ensemble_agent.rate_limit import pace, take_token
from ensemble_agent.reach import ModelUnreachable, classify_connect, is_unreachable_notice, transport_failure
from ensemble_agent.textutil import chunk_text, truncate_text

ModelRole = Literal["planner", "drafter", "classifier", "coder", "embedder"]

_ROLE_TEMPERATURE: dict[ModelRole, float] = {
    "planner": 0.0,
    "classifier": 0.0,
    "drafter": 0.4,
    "coder": 0.1,
    "embedder": 0.0,
}

CHEAPEST: dict[str, str] = {
    "google": "gemini-3.5-flash-lite",
    "openai": "gpt-4.1-mini",
    "anthropic": "claude-haiku-4-5-20251001",
    "cursor": "composer-2.5",
    "openrouter": "openrouter/auto",
    "copilot": "gpt-4.1",
    "mistral": "mistral-small-latest",
    "kimi": "moonshot-v1-8k",
    "qwen": "qwen-flash",
}

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
BASES: dict[str, str] = {
    "google": GEMINI_BASE,
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "mistral": "https://api.mistral.ai/v1",
    "kimi": "https://api.moonshot.ai/v1",
    "qwen": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
}

_JSON_PROVIDERS = ("google", "openai", "openrouter", "mistral", "kimi", "qwen")
_BACKOFF_SECONDS = (0.4, 1.2, 3.0)
_RETRY_STATUSES = (429, 500, 502, 503, 504)
_FIXTURE_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
_FIXTURE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")
_FIXTURE_TAG = re.compile(r"\[\[fixture:([A-Za-z0-9][A-Za-z0-9_.-]{0,80})\]\]")
_DONE = object()

profile: ContextVar[dict[str, Any]] = ContextVar("model_profile", default={})


class ModelAuthError(RuntimeError):
    pass


class ModelProfileError(RuntimeError):
    pass


@contextmanager
def model_profile_context(payload: dict[str, Any]) -> Iterator[None]:
    if any(payload.get(key) is not None for key in ("reasoningEffort",)) and not payload.get("model"):
        raise ModelProfileError("A queued reasoning/context profile requires an explicit resolved model.")
    token = profile.set({key: payload[key] for key in ("model", "reasoningEffort", "provider", "userId") if key in payload})
    try:
        yield
    finally:
        profile.reset(token)


def _resolve(user_id: str | None, provider: str) -> credentials.Credential:
    try:
        return credentials.resolve(user_id, provider)
    except credentials.DecryptError as exc:
        raise ModelAuthError(str(exc)) from exc


def resolve_copilot_token() -> str:
    cred = _resolve(None, "copilot")
    if not cred.secret:
        raise ModelAuthError("No Copilot credential found. Run `gh auth login`, or paste a GitHub token in Settings → Models.")
    return cred.secret


def infer_provider(model: str) -> str:
    name = model.lower()
    if name.startswith(("gemini", "gemma")):
        return "google"
    if name.startswith("claude"):
        return "anthropic"
    if name.startswith(("mistral", "ministral", "codestral", "pixtral", "open-mistral")):
        return "mistral"
    if name.startswith(("moonshot", "kimi")):
        return "kimi"
    if name.startswith("qwen"):
        return "qwen"
    if "/" in name:
        return "openrouter"
    if name.startswith(("gpt", "o1", "o3", "o4")):
        return "openai"
    return os.environ.get("ENSEMBLE_LLM_PROVIDER", "google")


def spec_for(role: ModelRole, model: str | None = None) -> dict[str, Any]:
    env_key = {
        "planner": "ENSEMBLE_MODEL_PLANNER",
        "drafter": "ENSEMBLE_MODEL_DRAFTER",
        "classifier": "ENSEMBLE_MODEL_CLASSIFIER",
        "coder": "ENSEMBLE_MODEL_CODER",
        "embedder": "ENSEMBLE_EMBEDDING_MODEL",
    }[role]
    chosen = model or profile.get().get("model") or os.environ.get(env_key) or CHEAPEST["google"]
    return {
        "role": role,
        "model": chosen,
        "temperature": _ROLE_TEMPERATURE[role],
        "provider": profile.get().get("provider") or infer_provider(chosen),
    }


# ── OpenAI-compatible transport ─────────────────────────────────────────────

_copilot_cache: dict[str, tuple[str, str, float]] = {}


async def _copilot_session(github_token: str, *, allow_host_config: bool = False) -> tuple[str, str]:
    cache_key = f"{'host' if allow_host_config else 'byok'}:{github_token}"
    cached = _copilot_cache.get(cache_key)
    if cached and cached[2] > time.time() + 60:
        return cached[0], cached[1]
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(
            "https://api.github.com/copilot_internal/v2/token",
            headers={"Authorization": f"token {github_token}", "Accept": "application/json", "User-Agent": "Ensemble"},
        )
    if not response.is_success:
        raise ModelAuthError(f"GitHub did not issue a Copilot token ({response.status_code}). Is Copilot enabled on this account?")
    body = response.json()
    base = (body.get("endpoints") or {}).get("api") or (os.environ.get("COPILOT_API_BASE") if allow_host_config else None) or "https://api.githubcopilot.com"
    _copilot_cache[cache_key] = (body["token"], base.rstrip("/"), float(body.get("expires_at") or time.time() + 600))
    return body["token"], base.rstrip("/")


async def _endpoint(provider: str, user_id: str | None, ollama_url: str | None) -> tuple[str, dict[str, str], str]:
    """Return (base URL, headers, credential source) for an OpenAI-compatible provider."""
    if provider == "mock":
        return "mock://local", {}, "you"
    cred = _resolve(user_id, provider)
    if provider == "ollama":
        require_host_access(user_id, "Host Ollama and custom model proxies")
        base = (cred.base_url or ollama_url or os.environ.get("OLLAMA_URL") or "http://127.0.0.1:11434").rstrip("/")
        return f"{base}/v1", {}, "local"
    if not cred.secret:
        raise ModelAuthError(
            f"No key for {provider}. Paste one in Settings → Models, or pick a provider that has a key."
        )
    if provider == "copilot":
        token, base = await _copilot_session(cred.secret, allow_host_config=can_use_host_credentials(user_id))
        return base, {
            "Authorization": f"Bearer {token}",
            "Editor-Version": "Ensemble/0.1",
            "Copilot-Integration-Id": "vscode-chat",
        }, cred.source
    if provider not in BASES:
        raise ModelAuthError(f"{provider} is not a chat provider.")
    base = (cred.base_url or BASES[provider]).rstrip("/")
    headers = {"Authorization": f"Bearer {cred.secret}"}
    if provider == "openrouter":
        headers["X-Title"] = "Ensemble"
    return base, headers, cred.source


def _effort(provider: str, effort: str | None, model: str | None = None) -> str | None:
    if not effort or effort == "default":
        return None
    if provider == "google" and effort == "minimal" and not str(model or "").startswith("gemini-3"):
        return "low"
    return effort


def retry_plan(error: ProviderError, attempt: int) -> float | None:
    """Seconds to wait before another try, or None when the call should surface.

    ``attempt`` is how many backoff retries have already been scheduled.
    503 gets three extra attempts; other 5xx get two. Quota and a bare 429
    (no retry hint) are never retried. RESOURCE_EXHAUSTED is quota.
    """
    if error.kind == "quota" or error.status not in _RETRY_STATUSES:
        return None
    if error.status == 429 and error.retry_after_seconds is None:
        return None
    extra = 3 if error.status in (429, 503) else 2
    if attempt >= extra:
        return None
    if error.retry_after_seconds is not None:
        return min(60.0, max(0.0, float(error.retry_after_seconds)))
    base = _BACKOFF_SECONDS[min(max(attempt, 0), len(_BACKOFF_SECONDS) - 1)]
    return base + random.random() * 0.25


def _thought_signature(call: dict[str, Any]) -> str | None:
    extra = call.get("extra_content")
    if not isinstance(extra, dict):
        return None
    google = extra.get("google")
    if not isinstance(google, dict):
        return None
    signature = google.get("thought_signature")
    return signature if isinstance(signature, str) and signature else None


def sanitize_chat_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A Gemini function-response turn: no empty parts, every call has a response, signatures kept.

    An empty assistant ``content`` beside tool calls is an empty part and Google
    answers 400 INVALID_ARGUMENT. A tool message with no matching call does the same.
    """
    prepared: list[dict[str, Any]] = []
    index = 0
    while index < len(messages):
        message = messages[index]
        if not isinstance(message, dict) or message.get("role") == "tool":
            index += 1
            continue
        calls = message.get("tool_calls")
        if message.get("role") != "assistant" or not isinstance(calls, list) or not calls:
            prepared.append(message)
            index += 1
            continue
        signed = [dict(call) if isinstance(call, dict) else {"id": "", "type": "function", "function": {}} for call in calls]
        donor = next((call for call in signed if _thought_signature(call)), None)
        signature = _thought_signature(donor) if donor else None
        if signature:
            for call in signed:
                if _thought_signature(call):
                    continue
                extra = dict(call.get("extra_content") or {})
                google = dict(extra.get("google") or {})
                google["thought_signature"] = signature
                extra["google"] = google
                call["extra_content"] = extra
        text = message.get("content")
        echoed = dict(message)
        echoed["content"] = text if isinstance(text, str) and text.strip() else None
        echoed["tool_calls"] = signed
        prepared.append(echoed)
        results: dict[str, dict[str, Any]] = {}
        cursor = index + 1
        while cursor < len(messages) and isinstance(messages[cursor], dict) and messages[cursor].get("role") == "tool":
            row = messages[cursor]
            results[str(row.get("tool_call_id") or "")] = row
            cursor += 1
        index = cursor
        for call in signed:
            call_id = str(call.get("id") or "")
            function = call.get("function") if isinstance(call.get("function"), dict) else {}
            name = str(function.get("name") or "")
            found = results.get(call_id)
            content = found.get("content") if found else ""
            if not isinstance(content, str) or not content.strip():
                content = json.dumps({"error": "The tool did not return a result."})
            prepared.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": str((found or {}).get("name") or name),
                    "content": content,
                }
            )
        continue
    return prepared


def build_chat_payload(
    model: str,
    provider: str,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    reasoning_effort: str | None = None,
    temperature: float | None = None,
    json_mode: bool = False,
    stream: bool = False,
) -> dict[str, Any]:
    """OpenAI-compatible chat body. Gemini 3 omits temperature."""
    payload: dict[str, Any] = {"model": model, "messages": sanitize_chat_messages(messages)}
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    effort = _effort(provider, reasoning_effort, model)
    if effort:
        payload["reasoning_effort"] = effort
    if temperature is not None and not str(model).startswith("gemini-3"):
        payload["temperature"] = temperature
    if json_mode and provider in _JSON_PROVIDERS:
        payload["response_format"] = {"type": "json_object"}
    if stream:
        payload["stream"] = True
    return payload


chat_payload = build_chat_payload


def _response_text(response: httpx.Response) -> str:
    try:
        return response.text
    except Exception:
        return response.content.decode("utf-8", errors="replace")


async def post_with_retry(
    send: Callable[[dict[str, Any]], Awaitable[httpx.Response]],
    payload: dict[str, Any],
    sleep: Callable[[float], Any] | None = None,
    *,
    retry: bool = True,
) -> httpx.Response:
    """POST until success, a non-retriable error, or the attempt budget runs out.

    A 400 is retried once, immediately, only when the error text mentions
    ``reasoning_effort`` and the payload sent that field. ``sleep`` defaults
    to ``asyncio.sleep`` and may be sync or async.
    """
    pause = sleep or asyncio.sleep
    current = dict(payload)
    stripped = False
    attempt = 0
    while True:
        response = await send(current)
        if response.is_success:
            return response
        body = _response_text(response)
        if (
            not stripped
            and response.status_code == 400
            and "reasoning_effort" in body
            and "reasoning_effort" in current
        ):
            current = {key: value for key, value in current.items() if key != "reasoning_effort"}
            stripped = True
            continue
        error = parse_provider_error(response.status_code, body, response.headers)
        if not retry:
            raise error
        delay = retry_plan(error, attempt)
        if delay is None:
            raise error
        waited = pause(delay)
        if inspect.isawaitable(waited):
            await waited
        attempt += 1


def _can_fallback(error: ProviderError, fallback: Any, model: str) -> bool:
    """No silent cross-model fallback. Lite must never become flash on a 503."""
    del error, fallback, model
    return False


async def _with_model_fallback(
    body: dict[str, Any],
    model: str,
    call: Callable[[str, bool], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    try:
        return await call(model, True)
    except ProviderError as exc:
        fallback = body.get("fallbackModel")
        if not _can_fallback(exc, fallback, model):
            raise
        result = await call(str(fallback), False)
        result["fallbackFrom"] = model
        return result


async def _openai_chat(
    provider: str,
    payload: dict[str, Any],
    user_id: str | None,
    ollama_url: str | None,
    timeout: float,
    *,
    retry: bool = True,
) -> dict[str, Any]:
    await pace(user_id, provider)
    if payload.get("stream"):
        return await _collect_openai_stream(provider, payload, user_id, ollama_url, timeout, retry=retry)
    base, headers, _ = await _endpoint(provider, user_id, ollama_url)
    url = f"{base}/chat/completions"

    async def send(current: dict[str, Any]) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                return await client.post(url, headers=headers, json=current)
        except Exception as exc:
            _reraise_transport(exc, provider=provider, model=str(payload.get("model") or ""), url=url)

    response = await post_with_retry(send, payload, retry=retry)
    try:
        data = response.json()
    except json.JSONDecodeError as exc:
        raise ProviderError(502, "other", "The model provider returned a non-JSON response.") from exc
    if not isinstance(data, dict):
        raise ProviderError(502, "other", "The model provider returned a non-JSON response.")
    return data


def _text(content: Any) -> str:
    if isinstance(content, list):
        return "".join(str(part.get("text") or "") if isinstance(part, dict) else str(part) for part in content)
    return str(content or "")


# Normal endings only. Anything else, including a missing reason, is a cut-off.
# OpenAI-compatible covers Gemini's OpenAI endpoint, Copilot, and Ollama's /v1 API.
_FINISH_ALLOW: dict[str, frozenset[str]] = {
    "openai": frozenset({"stop", "tool_calls", "function_call"}),
    "anthropic": frozenset({"end_turn", "tool_use", "stop_sequence"}),
    "gemini": frozenset({"STOP"}),
    "ollama": frozenset({"stop"}),
}


def finish_is_cut_off(reason: str | None, family: str) -> bool:
    """True when ``reason`` is outside that provider's allowlist.

    No reason counts: a dropped connection usually ends the stream without one.
    """
    if not reason:
        return True
    allowed = _FINISH_ALLOW.get(family)
    if allowed is None:
        return True
    return reason not in allowed


def _clean_reason(reason: Any) -> str | None:
    if not isinstance(reason, str):
        return None
    cleaned = reason.strip()
    return cleaned or None


def _finish_fields(choice: dict[str, Any]) -> tuple[str | None, bool]:
    """``(raw reason, cut off)``. A choice that never says how it finished is left alone."""
    if "finish_reason" not in choice and "finish_family" not in choice:
        return None, False
    reason = _clean_reason(choice.get("finish_reason"))
    family = _clean_reason(choice.get("finish_family")) or "openai"
    return reason, finish_is_cut_off(reason, family)


def _stop_fields(data: dict[str, Any], key: str, family: str) -> tuple[str | None, bool]:
    if key not in data:
        return None, False
    reason = _clean_reason(data.get(key))
    return reason, finish_is_cut_off(reason, family)


CONNECTION_DROPPED_NOTICE = "The connection to the model dropped before it replied. Try again."

_TRANSPORT_NAMES = frozenset(
    {
        "RemoteProtocolError",
        "ReadError",
        "ConnectError",
        "NetworkError",
        "ProtocolError",
        "WriteError",
        "CloseError",
        "ConnectionDropped",
    }
)


class ConnectionDropped(Exception):
    """The provider connection died before any assistant text. The message is the user-facing notice."""


def is_non_model_notice(content: str) -> bool:
    """True for a saved notice that must not be sent back as the assistant's own reply."""
    text = content.strip()
    return text == CONNECTION_DROPPED_NOTICE or is_unreachable_notice(text)


def is_transport_drop(exc: BaseException) -> bool:
    """A connection that was established and then died before any assistant text.

    Connection refused, DNS failure, and a down Ollama never connected, so they
    are not drops. Timeouts, cancellation, and quota are not drops either.
    """
    if isinstance(exc, (asyncio.CancelledError, TimeoutError, ModelUnreachable)):
        return False
    if isinstance(exc, httpx.TimeoutException):
        return False
    if isinstance(exc, ConnectionDropped):
        return True
    if str(exc).strip() == CONNECTION_DROPPED_NOTICE:
        return True
    kind = classify_connect(exc)
    if kind in {"refused", "dns"}:
        return False
    if kind == "drop":
        return True
    if isinstance(exc, httpx.ConnectError):
        return False
    if isinstance(exc, httpx.TransportError):
        return True
    name = type(exc).__name__
    return name in _TRANSPORT_NAMES and name not in {"ConnectError", "NetworkError"}


def _reraise_transport(exc: BaseException, *, provider: str, model: str, url: str) -> None:
    if isinstance(exc, (asyncio.CancelledError, ConnectionDropped, ModelUnreachable)):
        raise exc
    failure = transport_failure(exc, provider=provider, model=model, url=url)
    if failure is not None:
        raise failure from exc
    if is_transport_drop(exc):
        raise ConnectionDropped(CONNECTION_DROPPED_NOTICE) from exc
    raise exc


def sanitize_cut_off_reason(reason: str | None) -> str | None:
    """Strip ``]`` and collapse whitespace so a provider reason cannot break the marker line."""
    if not reason:
        return None
    cleaned = re.sub(r"\s+", " ", reason.replace("]", "")).strip()
    return cleaned or None


def cut_off_notice(reason: str | None) -> str:
    """Plain-language sentence for a cut-off reply. The raw reason is kept when it names the cause."""
    if not reason:
        return "The reply was cut off before the model finished."
    lowered = reason.lower()
    if lowered in {"length", "max_tokens"} or reason == "MAX_TOKENS":
        return "The reply hit the length limit."
    if reason.startswith("content_filter"):
        detail = reason[len("content_filter") :].lstrip(":").strip()
        if detail:
            return f"The model stopped early (content filter: {detail})."
        return "The model stopped early (content filter)."
    return f"The model stopped early ({reason})."


def cut_off_reply(partial: str, reason: str | None) -> str:
    """Partial text plus a marker the next turn sends back, so the model does not treat it as finished."""
    safe = sanitize_cut_off_reason(reason)
    notice = cut_off_notice(safe)
    marker = f"[Cut off: {notice} This reply is incomplete. Reason: {safe or 'none'}.]"
    body = partial.strip()
    return f"{marker}\n\n{body}" if body else marker


_CUT_OFF_LINE = re.compile(r"^\[Cut off:\s*(.+)\s+Reason: .+\]$")


def split_cut_off_reply(content: str) -> tuple[str, str | None]:
    """Notice only when ``[Cut off:`` is the first line. A later copy is part of the answer."""
    lines = content.split("\n")
    first = lines[0].strip() if lines else ""
    if not first.startswith("[Cut off:"):
        return content.strip(), None
    matched = _CUT_OFF_LINE.match(first)
    notice = matched.group(1).strip() if matched else first.removeprefix("[Cut off:").removesuffix("]").strip()
    body = "\n".join(lines[1:]).strip()
    return body, notice


def history_entries(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    """User and assistant turns for the next prompt. Connection-dropped notices are left out."""
    out: list[dict[str, str]] = []
    for row in rows:
        role = row.get("role")
        if role not in {"user", "assistant"}:
            continue
        content = str(row.get("content") or "")
        if role == "assistant" and is_non_model_notice(content):
            continue
        if content.strip():
            out.append({"role": str(role), "content": truncate_text(content, 4000)})
    return out


def _from_openai(data: dict[str, Any], model: str) -> dict[str, Any]:
    message = data["choices"][0]["message"]
    calls = []
    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        arguments = fn.get("arguments") or "{}"
        calls.append(
            {
                "id": call.get("id") or "",
                "name": fn.get("name") or "",
                "arguments": arguments if isinstance(arguments, str) else json.dumps(arguments),
            }
        )
    usage = data.get("usage") or {}
    reason, cut_off = _finish_fields(data["choices"][0])
    return {
        "text": _text(message.get("content")),
        "toolCalls": calls,
        "model": data.get("model") or model,
        "credits": None,
        "tokensIn": usage.get("prompt_tokens"),
        "tokensOut": usage.get("completion_tokens"),
        "reasoning": str(message.get("reasoning_content") or ""),
        "finishReason": reason,
        "cutOff": cut_off,
        "raw": data,
    }


def new_stream_state() -> dict[str, Any]:
    return {
        "content": [],
        "reasoning": [],
        "tools": {},
        "tool_indexes": {},
        "model": "",
        "usage": {},
        "finish_reason": None,
        "finish_family": None,
    }


def _note_finish(state: dict[str, Any], reason: Any, family: str) -> None:
    cleaned = _clean_reason(reason)
    if not cleaned:
        return
    state["finish_reason"] = cleaned
    state["finish_family"] = family


def _blank_tool() -> dict[str, Any]:
    return {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}


def _next_tool_index(state: dict[str, Any]) -> int:
    tools = state["tools"]
    if not tools:
        return 0
    return max(int(key) for key in tools) + 1


def _joined_id(*values: Any) -> str:
    """First truthy id, so a blank functionCall id falls through to the part id."""
    for value in values:
        if value:
            return str(value)
    return ""


def _provider_index(call: dict[str, Any]) -> int | None:
    if "index" not in call:
        return None
    raw = call.get("index")
    if raw is None or isinstance(raw, bool) or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _new_tool(state: dict[str, Any], provider_index: int | None) -> dict[str, Any]:
    tools: dict[Any, dict[str, Any]] = state["tools"]
    indexes: dict[Any, int] = state.setdefault("tool_indexes", {})
    index = _next_tool_index(state)
    tools[index] = _blank_tool()
    if provider_index is not None:
        indexes[index] = provider_index
    return tools[index]


def _tool_slot(state: dict[str, Any], call: dict[str, Any]) -> dict[str, Any]:
    """Pick the slot for one streamed call.

    A non-empty id wins over index. A different id always starts a new call,
    even when that index already has one. The same id returns the call it
    already names. A chunk with no id attaches to the most recent call at
    that index. With neither, a named call starts a new one and a bare
    fragment continues the latest call.
    """
    tools: dict[Any, dict[str, Any]] = state["tools"]
    indexes: dict[Any, int] = state.setdefault("tool_indexes", {})
    call_id = _joined_id(call.get("id"))
    provider_index = _provider_index(call)
    if call_id:
        for key, slot in tools.items():
            if slot.get("id") == call_id:
                if provider_index is not None and key not in indexes:
                    indexes[key] = provider_index
                return slot
        return _new_tool(state, provider_index)
    if provider_index is not None:
        match: dict[str, Any] | None = None
        for key in sorted(tools, key=lambda item: int(item)):
            if indexes.get(key) == provider_index:
                match = tools[key]
        if match is not None:
            return match
        return _new_tool(state, provider_index)
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    if function.get("name"):
        return _new_tool(state, None)
    if tools:
        return tools[max(int(key) for key in tools)]
    return _new_tool(state, None)


def _argument_text(value: Any) -> str:
    """Stream argument text. Objects use the same compact JSON as JSON.stringify."""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if not value:
        return ""
    return str(value)


def _repeated_whole_call(state: dict[str, Any], call: dict[str, Any]) -> dict[str, Any] | None:
    """A proxy may resend one finished functionCall. Same name and arguments is not a new call."""
    raw_index = call.get("index") if "index" in call else None
    if raw_index is not None and raw_index != "":
        return None
    if call.get("id"):
        return None
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = str(function.get("name") or "")
    arguments = _argument_text(function.get("arguments"))
    if not name or arguments == "":
        return None
    for slot in state["tools"].values():
        current = slot.get("function") if isinstance(slot.get("function"), dict) else {}
        if current.get("name") == name and current.get("arguments") == arguments:
            return slot
    return None


def _complete_json_object(text: str) -> bool:
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return False
    return isinstance(parsed, dict)


def _merge_arguments(existing: str, incoming: str, *, replace_complete: bool) -> str:
    """Join streamed arguments.

    A repeated id replaces the stored arguments only when both sides are each
    a complete JSON object. An ``{}`` placeholder followed by a fragment is
    empty, so the fragment is the whole result. Anything else is concatenated.
    """
    if replace_complete and _complete_json_object(existing) and _complete_json_object(incoming):
        return incoming
    if existing == "{}" and not _complete_json_object(incoming):
        return incoming
    return existing + incoming


def _merge_tool_extra(slot: dict[str, Any], extra: Any) -> None:
    if not isinstance(extra, dict):
        return
    merged = slot.setdefault("extra_content", {})
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key].update(value)
        else:
            merged[key] = value


def _accumulate_tool_call(state: dict[str, Any], call: Any) -> None:
    if not isinstance(call, dict):
        return
    repeated = _repeated_whole_call(state, call)
    if repeated is not None:
        _merge_tool_extra(repeated, call.get("extra_content"))
        return
    slot = _tool_slot(state, call)
    call_id = _joined_id(call.get("id"))
    same_id = bool(call_id) and slot.get("id") == call_id
    if call_id:
        slot["id"] = call_id
    if call.get("type"):
        slot["type"] = str(call["type"])
    _merge_tool_extra(slot, call.get("extra_content"))
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    incoming_args = _argument_text(function.get("arguments"))
    existing_args = str(slot["function"].get("arguments") or "")
    if function.get("name"):
        new_name = str(function["name"])
        current_name = str(slot["function"].get("name") or "")
        if same_id and current_name and _complete_json_object(existing_args) and _complete_json_object(incoming_args):
            slot["function"]["name"] = new_name
        elif same_id and current_name == new_name:
            pass
        else:
            slot["function"]["name"] = current_name + new_name
    if incoming_args:
        slot["function"]["arguments"] = _merge_arguments(existing_args, incoming_args, replace_complete=same_id)


def _json_arguments(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _openai_usage_from_gemini(meta: dict[str, Any]) -> dict[str, Any] | None:
    """Gemini's last stream chunk reports usageMetadata, not OpenAI usage."""

    def num(*names: str) -> int | None:
        for name in names:
            value = meta.get(name)
            if isinstance(value, bool) or value is None:
                continue
            try:
                return int(value)
            except (TypeError, ValueError):
                continue
        return None

    prompt = num("promptTokenCount", "prompt_token_count")
    completion = num("candidatesTokenCount", "candidates_token_count")
    if prompt is None and completion is None:
        return None
    usage: dict[str, Any] = {"prompt_tokens": prompt or 0, "completion_tokens": completion or 0}
    total = num("totalTokenCount", "total_token_count")
    if total is not None:
        usage["total_tokens"] = total
    return usage


def _consume_gemini_chunk(state: dict[str, Any], event: dict[str, Any]) -> str:
    """Whole functionCall parts. They often arrive one per chunk, with no index."""
    text = ""
    for candidate in event.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        _note_finish(state, candidate.get("finishReason") or candidate.get("finish_reason"), "gemini")
        content = candidate.get("content") if isinstance(candidate.get("content"), dict) else {}
        for part in content.get("parts") or []:
            if not isinstance(part, dict):
                continue
            raw = part.get("functionCall") or part.get("function_call")
            if isinstance(raw, dict):
                if "args" in raw and raw.get("args") is not None:
                    arguments = _json_arguments(raw.get("args"))
                elif "arguments" in raw and raw.get("arguments") is not None:
                    arguments = _json_arguments(raw.get("arguments"))
                else:
                    arguments = "{}"
                built: dict[str, Any] = {
                    "id": _joined_id(raw.get("id"), part.get("id")),
                    "type": "function",
                    "function": {"name": str(raw.get("name") or ""), "arguments": arguments},
                }
                signature = part.get("thoughtSignature") or part.get("thought_signature")
                if isinstance(signature, str) and signature:
                    built["extra_content"] = {"google": {"thought_signature": signature}}
                _accumulate_tool_call(state, built)
                continue
            piece = part.get("text")
            if isinstance(piece, str) and piece:
                state["content"].append(piece)
                text += piece
    return text


def _consume_anthropic_chunk(state: dict[str, Any], event: dict[str, Any]) -> str:
    """Messages API stream events. Tool blocks join on their content-block index."""
    kind = event.get("type")
    if kind == "message_delta":
        delta = event.get("delta") if isinstance(event.get("delta"), dict) else {}
        _note_finish(state, delta.get("stop_reason"), "anthropic")
        return ""
    if kind == "message":
        _note_finish(state, event.get("stop_reason"), "anthropic")
    if kind == "content_block_start":
        block = event.get("content_block") if isinstance(event.get("content_block"), dict) else {}
        if block.get("type") != "tool_use":
            return ""
        raw_input = block.get("input")
        if isinstance(raw_input, str):
            arguments = raw_input
        elif isinstance(raw_input, dict) and raw_input:
            arguments = json.dumps(raw_input, separators=(",", ":"), ensure_ascii=False)
        else:
            arguments = ""
        _accumulate_tool_call(
            state,
            {
                "index": event.get("index"),
                "id": block.get("id") or "",
                "type": "function",
                "function": {"name": block.get("name") or "", "arguments": arguments},
            },
        )
        return ""
    if kind != "content_block_delta":
        return ""
    delta = event.get("delta") if isinstance(event.get("delta"), dict) else {}
    if delta.get("type") == "text_delta" and isinstance(delta.get("text"), str) and delta.get("text"):
        state["content"].append(delta["text"])
        return str(delta["text"])
    if delta.get("type") == "input_json_delta":
        _accumulate_tool_call(
            state,
            {"index": event.get("index"), "function": {"arguments": str(delta.get("partial_json") or "")}},
        )
    return ""


def _usage_has_counts(usage: dict[str, Any]) -> bool:
    for key in ("prompt_tokens", "completion_tokens"):
        value = usage.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return True
    return False


def apply_stream_event(state: dict[str, Any], event: dict[str, Any]) -> str:
    """Merge one provider stream chunk. Returns the new text, if any.

    The finish reason is recorded when a provider sends one. A null reason on
    an earlier chunk is ignored. A stream that closes with none is a cut-off.
    """
    if event.get("model"):
        state["model"] = event["model"]
    usage = event.get("usage") if isinstance(event.get("usage"), dict) else None
    meta = event.get("usageMetadata") if isinstance(event.get("usageMetadata"), dict) else event.get("usage_metadata")
    mapped = _openai_usage_from_gemini(meta) if isinstance(meta, dict) else None
    if mapped is None and isinstance(usage, dict):
        mapped = _openai_usage_from_gemini(usage)
    if mapped:
        state["usage"] = mapped
    elif isinstance(usage, dict) and _usage_has_counts(usage):
        state["usage"] = usage
    _note_finish(state, event.get("done_reason"), "ollama")
    delta_text = _consume_gemini_chunk(state, event)
    delta_text += _consume_anthropic_chunk(state, event)
    for choice in event.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        _note_finish(state, choice.get("finish_reason"), "openai")
        delta = choice.get("delta") or {}
        if not isinstance(delta, dict):
            continue
        _note_finish(state, delta.get("finish_reason"), "openai")
        piece = delta.get("content")
        if isinstance(piece, str) and piece:
            state["content"].append(piece)
            delta_text += piece
        elif isinstance(piece, list):
            text = _text(piece)
            if text:
                state["content"].append(text)
                delta_text += text
        reasoning = delta.get("reasoning_content")
        if isinstance(reasoning, str) and reasoning:
            state["reasoning"].append(reasoning)
        for call in delta.get("tool_calls") or []:
            _accumulate_tool_call(state, call)
    return delta_text


def stream_state_to_completion(state: dict[str, Any], model: str) -> dict[str, Any]:
    tools = [state["tools"][index] for index in sorted(state["tools"])]
    message: dict[str, Any] = {
        "role": "assistant",
        "content": "".join(state["content"]),
        "tool_calls": tools,
    }
    reasoning = "".join(state["reasoning"])
    if reasoning:
        message["reasoning_content"] = reasoning
    choice: dict[str, Any] = {"message": message, "finish_reason": state.get("finish_reason")}
    family = state.get("finish_family")
    if isinstance(family, str) and family:
        choice["finish_family"] = family
    return {
        "model": state.get("model") or model,
        "choices": [choice],
        "usage": state.get("usage") or {},
    }


def _sse_json(line: str) -> Any:
    stripped = line.strip()
    if not stripped.startswith("data:"):
        return None
    data = stripped[5:].strip()
    if data == "[DONE]":
        return _DONE
    if not data:
        return None
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def recover_provider_stream(state: dict[str, Any], exc: BaseException, model: str) -> dict[str, Any]:
    """Turn a transport drop into a partial completion, or raise ``ConnectionDropped`` when nothing arrived.

    Cancellation is re-raised so a user Stop is not labelled as a cut-off.
    """
    if isinstance(exc, asyncio.CancelledError):
        raise exc
    if not is_transport_drop(exc):
        raise exc
    text = "".join(state.get("content") or []).strip()
    if text:
        return stream_state_to_completion(state, model)
    raise ConnectionDropped(CONNECTION_DROPPED_NOTICE) from exc


async def consume_sse_lines(lines: Any, model: str):
    """Yield ``("delta", text)`` then ``("done", completion)``.

    A transport error after text finishes the turn with no finish reason (a cut-off).
    A transport error before text raises ``ConnectionDropped`` with the plain notice.
    """
    state = new_stream_state()
    try:
        async for line in lines:
            item = _sse_json(line)
            if item is _DONE:
                break
            if isinstance(item, dict):
                delta = apply_stream_event(state, item)
                if delta:
                    yield ("delta", delta)
    except asyncio.CancelledError:
        yield ("done", stream_state_to_completion(state, model))
        raise
    except Exception as exc:
        done = recover_provider_stream(state, exc, model)
        yield ("done", done)
        return
    yield ("done", stream_state_to_completion(state, model))


def feed_sse(state: dict[str, Any], block: str) -> list[str]:
    """Apply an SSE text block to ``state``. Returns text deltas. Stops at [DONE]."""
    deltas: list[str] = []
    for line in block.splitlines():
        item = _sse_json(line)
        if item is _DONE:
            break
        if isinstance(item, dict):
            delta = apply_stream_event(state, item)
            if delta:
                deltas.append(delta)
    return deltas


def text_chunks(text: str, size: int = 24) -> list[str]:
    return chunk_text(text, size if size > 0 else 24)


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


async def _openai_stream_events(
    provider: str,
    payload: dict[str, Any],
    user_id: str | None,
    ollama_url: str | None,
    timeout: float,
    *,
    retry: bool = True,
):
    base, headers, _ = await _endpoint(provider, user_id, ollama_url)
    url = f"{base}/chat/completions"
    current = dict(payload)
    current["stream"] = True
    stripped = False
    attempt = 0
    while True:
        failure: ProviderError | None = None
        delay: float | None = None
        action = "raise"
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", url, headers=headers, json=current) as response:
                    if not response.is_success:
                        raw = await response.aread()
                        body = raw.decode("utf-8", errors="replace")
                        if (
                            not stripped
                            and response.status_code == 400
                            and "reasoning_effort" in body
                            and "reasoning_effort" in current
                        ):
                            current = {key: value for key, value in current.items() if key != "reasoning_effort"}
                            stripped = True
                            action = "strip"
                        else:
                            failure = parse_provider_error(response.status_code, body, response.headers)
                            delay = None if not retry else retry_plan(failure, attempt)
                            action = "raise" if delay is None else "sleep"
                    else:
                        async for kind, data in consume_sse_lines(response.aiter_lines(), str(current.get("model") or "")):
                            yield (kind, data)
                        return
        except asyncio.CancelledError:
            raise
        except (ConnectionDropped, ModelUnreachable):
            raise
        except Exception as exc:
            _reraise_transport(exc, provider=provider, model=str(current.get("model") or ""), url=url)
        if action == "strip":
            continue
        if action == "sleep" and delay is not None:
            await asyncio.sleep(delay)
            attempt += 1
            continue
        if failure is None:
            raise ProviderError(502, "other", "The model provider returned an error.")
        raise failure


async def _collect_openai_stream(
    provider: str,
    payload: dict[str, Any],
    user_id: str | None,
    ollama_url: str | None,
    timeout: float,
    *,
    retry: bool = True,
) -> dict[str, Any]:
    result: dict[str, Any] | None = None
    async for kind, data in _openai_stream_events(provider, payload, user_id, ollama_url, timeout, retry=retry):
        if kind == "done":
            result = data
    if result is None:
        raise ProviderError(502, "other", "The model stream ended without a completion.")
    return result


# ── mock provider (no network) ──────────────────────────────────────────────


def _mock_delay_seconds(body: dict[str, Any]) -> float:
    """Optional fixture pause so Stop can cancel a turn before the first token."""
    name = _fixture_name(body)
    if not name:
        return 0.0
    try:
        data = _read_fixture(name)
    except ProviderError:
        return 0.0
    raw = data.get("delayMs")
    try:
        ms = float(raw) if raw is not None else 0.0
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(ms, 8000.0)) / 1000.0


def _fixture_name(body: dict[str, Any]) -> str | None:
    named = body.get("mockFixture")
    if isinstance(named, str) and named.strip():
        return named.strip()
    messages = body.get("messages") or []
    if isinstance(messages, list):
        if any(isinstance(message, dict) and message.get("role") == "tool" for message in messages):
            return None
        for message in reversed(messages):
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            match = _FIXTURE_TAG.search(_text(message.get("content")))
            return match.group(1) if match else None
    prompt = body.get("prompt")
    if isinstance(prompt, str):
        match = _FIXTURE_TAG.search(prompt)
        if match:
            return match.group(1)
    return None


def _read_fixture(name: str) -> dict[str, Any]:
    base = name[:-5] if name.endswith(".json") else name
    if not _FIXTURE_NAME.fullmatch(base):
        raise ProviderError(400, "invalid", "Unknown mock fixture.")
    path = _FIXTURE_DIR / f"{base}.json"
    if not path.is_file():
        raise ProviderError(404, "not_found", f"Unknown mock fixture '{base}'.")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise ProviderError(502, "other", f"Mock fixture '{base}' is not valid JSON.") from exc
    if not isinstance(data, dict):
        raise ProviderError(502, "other", f"Mock fixture '{base}' must be a JSON object.")
    return data


def _raise_fixture_error(data: dict[str, Any]) -> None:
    err = data.get("error")
    if not isinstance(err, dict):
        return
    status = err.get("status") if isinstance(err.get("status"), int) else err.get("code")
    if "kind" not in err and not isinstance(status, int):
        return
    if "details" in err and "kind" not in err and not isinstance(status, int):
        return
    retry = err.get("retryAfterSeconds", err.get("retry_after_seconds"))
    quota = err.get("quotaId", err.get("quota_id"))
    try:
        retry_after = None if retry is None else float(retry)
    except (TypeError, ValueError):
        retry_after = None
    kind = err.get("kind")
    if not isinstance(kind, str):
        kind = "unavailable" if status == 503 else "rate_limit" if status == 429 else "other"
    raise ProviderError(
        status=int(status or 502),
        kind=str(kind),
        message=str(err.get("message") or "Mock provider error."),
        quota_id=str(quota) if quota else None,
        retry_after_seconds=retry_after,
    )


def _mock_from_parts(
    text: str,
    calls: list[dict[str, Any]],
    model: str,
    tokens_in: Any,
    tokens_out: Any,
) -> dict[str, Any]:
    normalized: list[dict[str, str]] = []
    for call in calls:
        arguments = call.get("arguments")
        if not isinstance(arguments, str):
            arguments = json.dumps(arguments if arguments is not None else {})
        normalized.append(
            {"id": str(call.get("id") or ""), "name": str(call.get("name") or ""), "arguments": arguments}
        )

    def _as_int(value: Any) -> int:
        try:
            return int(value) if value is not None else 0
        except (TypeError, ValueError):
            return 0

    prompt_tokens = _as_int(tokens_in)
    completion_tokens = _as_int(tokens_out)
    raw = {
        "model": model,
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": text,
                    "tool_calls": [
                        {
                            "id": call["id"],
                            "type": "function",
                            "function": {"name": call["name"], "arguments": call["arguments"]},
                        }
                        for call in normalized
                    ],
                }
            }
        ],
        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens},
    }
    return {
        "text": text,
        "toolCalls": normalized,
        "model": model,
        "credits": None,
        "tokensIn": prompt_tokens,
        "tokensOut": completion_tokens,
        "reasoning": "",
        "raw": raw,
    }


def _mock_turn(body: dict[str, Any], model: str) -> dict[str, Any]:
    name = _fixture_name(body)
    chosen = model or "mock"
    if not name:
        return _mock_from_parts("Mock answer.", [], chosen, 0, 0)
    data = _read_fixture(name)
    _raise_fixture_error(data)
    if isinstance(data.get("choices"), list):
        return _from_openai(data, str(data.get("model") or chosen))
    calls = data.get("toolCalls") if isinstance(data.get("toolCalls"), list) else []
    return _mock_from_parts(
        str(data.get("text") or ""),
        calls,
        str(data.get("model") or chosen),
        data.get("tokensIn"),
        data.get("tokensOut"),
    )


# ── Anthropic Messages API ──────────────────────────────────────────────────


def _to_anthropic(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    system: list[str] = []
    out: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            system.append(_text(message.get("content")))
            continue
        if role == "tool":
            block = {"type": "tool_result", "tool_use_id": message.get("tool_call_id"), "content": _text(message.get("content"))}
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
            continue
        if role == "assistant":
            blocks: list[dict[str, Any]] = []
            text = _text(message.get("content"))
            if text:
                blocks.append({"type": "text", "text": text})
            for call in message.get("tool_calls") or []:
                fn = call.get("function") or {}
                try:
                    arguments = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                blocks.append({"type": "tool_use", "id": call.get("id"), "name": fn.get("name"), "input": arguments})
            out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": ""}]})
            continue
        out.append({"role": "user", "content": _text(message.get("content"))})
    return "\n\n".join(system), out


def _anthropic_tools(body: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "name": tool["function"]["name"],
            "description": tool["function"].get("description", ""),
            "input_schema": tool["function"].get("parameters") or {"type": "object", "properties": {}},
        }
        for tool in body.get("chatTools") or []
        if tool.get("type") == "function"
    ]


def _anthropic_result(data: dict[str, Any], model: str) -> dict[str, Any]:
    text = "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")
    calls = [
        {"id": block["id"], "name": block["name"], "arguments": json.dumps(block.get("input") or {})}
        for block in data.get("content", [])
        if block.get("type") == "tool_use"
    ]
    usage = data.get("usage") or {}
    reason, cut_off = _stop_fields(data, "stop_reason", "anthropic")
    choice: dict[str, Any] = {
        "message": {
            "role": "assistant",
            "content": text,
            "tool_calls": [
                {"id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": call["arguments"]}}
                for call in calls
            ],
        }
    }
    if "stop_reason" in data:
        choice["finish_reason"] = data.get("stop_reason")
        choice["finish_family"] = "anthropic"
    native = {"choices": [choice]}
    return {
        "text": text,
        "toolCalls": calls,
        "model": data.get("model") or model,
        "credits": None,
        "tokensIn": usage.get("input_tokens"),
        "tokensOut": usage.get("output_tokens"),
        "reasoning": "",
        "finishReason": reason,
        "cutOff": cut_off,
        "raw": native,
    }


async def _anthropic_chat(body: dict[str, Any], model: str, user_id: str | None, timeout: float) -> dict[str, Any]:
    cred = _resolve(user_id, "anthropic")
    if not cred.secret:
        raise ModelAuthError("No key for anthropic. Paste one in Settings → Models.")
    system, messages = _to_anthropic(body.get("messages") or [])
    tools = _anthropic_tools(body)
    url = (cred.base_url or "https://api.anthropic.com").rstrip("/") + "/v1/messages"
    headers = {"x-api-key": cred.secret, "anthropic-version": "2023-06-01"}

    def payload_for(chosen: str) -> dict[str, Any]:
        payload: dict[str, Any] = {"model": chosen, "max_tokens": int(body.get("maxTokens") or 4096), "messages": messages}
        if system:
            payload["system"] = system
        if tools:
            payload["tools"] = tools
        effort = _effort("anthropic", body.get("reasoningEffort"), chosen)
        if effort and effort != "minimal":
            payload["output_config"] = {"effort": effort}
        return payload

    async def send(current: dict[str, Any]) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                return await client.post(url, headers=headers, json=current)
        except Exception as exc:
            _reraise_transport(exc, provider="anthropic", model=str(current.get("model") or model), url=url)

    async def call(chosen: str, allow_retry: bool) -> dict[str, Any]:
        response = await post_with_retry(send, payload_for(chosen), retry=allow_retry)
        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise ProviderError(502, "other", "The model provider returned a non-JSON response.") from exc
        if not isinstance(data, dict):
            raise ProviderError(502, "other", "The model provider returned a non-JSON response.")
        return _anthropic_result(data, chosen)

    return await _with_model_fallback(body, model, call)


# ── public entry points ─────────────────────────────────────────────────────


def _cursor_chat_error() -> ModelAuthError:
    return ModelAuthError(
        "Cursor runs delegated agent work, not the chat. Pick Gemini, OpenAI, Claude, Mistral, Kimi, Qwen, OpenRouter, Copilot or Ollama for this tier."
    )


async def _openai_turn(
    body: dict[str, Any],
    model: str,
    provider: str,
    messages: list[dict[str, Any]],
    timeout: float,
    *,
    tools: list[dict[str, Any]] | None = None,
    temperature: float | None = None,
    json_mode: bool = False,
    stream: bool = False,
) -> dict[str, Any]:
    async def call(chosen: str, allow_retry: bool) -> dict[str, Any]:
        payload = build_chat_payload(
            chosen,
            provider,
            messages,
            tools=tools,
            reasoning_effort=body.get("reasoningEffort"),
            temperature=temperature,
            json_mode=json_mode,
            stream=stream,
        )
        data = await _openai_chat(provider, payload, body.get("userId"), body.get("ollamaUrl"), timeout, retry=allow_retry)
        return _from_openai(data, chosen)

    return await _with_model_fallback(body, model, call)


async def complete_with_tools(body: dict[str, Any]) -> dict[str, Any]:
    """One assistant turn. Agent-runtime owns the credential; hub-api owns the tools."""
    await asyncio.to_thread(require_verified_user, body.get("userId"))
    model = str(body.get("model") or spec_for("coder")["model"])
    provider = str(body.get("provider") or infer_provider(model))
    if provider == "mock":
        return _mock_turn(body, model)
    if provider == "cursor":
        raise _cursor_chat_error()
    if provider == "anthropic":
        return await _anthropic_chat(body, model, body.get("userId"), 300)
    return await _openai_turn(
        body,
        model,
        provider,
        body.get("messages") or [],
        300,
        tools=body.get("chatTools") or None,
        stream=bool(body.get("stream")),
    )


_NO_JSON = object()
_MAX_STARTS = 64


def parse_model_json(text: str, shape: str | None = None) -> Any:
    """Pull one JSON value out of a model reply.

    ``shape`` is what the caller can use. ``"triage"`` is a todos array or an
    object that holds one. ``"plan"`` is an object with ``steps``. A complete
    value that does not match is skipped. A value inside an opener that never
    closes is not a candidate, so a cut-off reply raises and the caller can
    fall back. The scan is one forward pass and stops after 64 top-level
    starts. ``RecursionError`` from deep nesting is a no-match, not a crash.
    A stray quote or brace in the prose does not hide a later well-formed value.
    """
    found = _first_match(text, shape)
    if found is not _NO_JSON:
        return found
    recovered = _recover_model_json(text, shape)
    if recovered is not _NO_JSON:
        return recovered
    raise RuntimeError(f"The model did not return JSON: {text[:200]}")


def _loads(text: str) -> Any:
    try:
        return json.loads(text)
    except (json.JSONDecodeError, RecursionError):
        return _NO_JSON


def _accepts(value: Any, shape: str | None) -> bool:
    if shape == "triage":
        return _is_triage_payload(value)
    if shape == "plan":
        return isinstance(value, dict) and "steps" in value
    return True


def _is_triage_payload(value: Any) -> bool:
    """A todos array, one todo, or an object that wraps them. ``[1]`` and ``{}`` are not."""
    if isinstance(value, list):
        return all(isinstance(item, dict) for item in value)
    if not isinstance(value, dict):
        return False
    if isinstance(value.get("todos"), list):
        return True
    if "todo" in value and (value.get("todo") is None or isinstance(value.get("todo"), dict)):
        return True
    title = value.get("title")
    return isinstance(value.get("id"), str) and isinstance(title, str) and bool(title.strip())


def _first_match(text: str, shape: str | None) -> Any:
    trimmed = text.strip()
    if trimmed:
        whole = _loads(trimmed)
        if whole is not _NO_JSON and _accepts(whole, shape):
            return whole
    return _first_json_value(text, shape)


def _first_json_value(text: str, shape: str | None = None) -> Any:
    """First top-level value that matches ``shape``.

    Starts are only counted at depth 0, and only while that opener later
    closes. An inner value of a cut-off reply is never returned. Two matches
    are no match, so the first object is not kept while the second is dropped.
    """
    accepted: Any = _NO_JSON
    accepted_count = 0
    depth = 0
    in_string = False
    escape = False
    start = -1
    starts = 0
    for index, char in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        if char in "{[":
            if depth == 0:
                if starts >= _MAX_STARTS:
                    break
                starts += 1
                start = index
            depth += 1
            continue
        if char not in "}]":
            continue
        if depth == 0:
            continue
        depth -= 1
        if depth != 0 or start < 0:
            continue
        parsed = _loads(text[start : index + 1])
        start = -1
        if parsed is _NO_JSON or not _accepts(parsed, shape):
            continue
        accepted_count += 1
        if accepted_count > 1:
            return _NO_JSON
        accepted = parsed
    if depth != 0:
        return _NO_JSON
    return accepted if accepted_count == 1 else _NO_JSON


def _looks_like_json(text: str, open_at: int) -> bool:
    index = open_at + 1
    while index < len(text) and text[index].isspace():
        index += 1
    nxt = text[index] if index < len(text) else ""
    if text[open_at] == "{":
        return nxt in {'"', "}"}
    return nxt in {'"', "{", "[", "]", "-", "t", "f", "n"} or nxt.isdigit()


def _json_end(text: str, start: int) -> int | None:
    """Index just past one JSON value, or None when that opener never closes."""
    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        if char in "{[":
            depth += 1
            continue
        if char not in "}]":
            continue
        depth -= 1
        if depth == 0:
            return index + 1
    return None


def _recover_model_json(text: str, shape: str | None) -> Any:
    """First well-formed value, ignoring quotes and braces that are not JSON.

    An opener that looks like JSON and never closes is a cut-off reply, so
    nothing nested inside it is returned.
    """
    accepted: Any = _NO_JSON
    accepted_count = 0
    starts = 0
    index = 0
    while index < len(text):
        char = text[index]
        if char not in "{[":
            index += 1
            continue
        if starts >= _MAX_STARTS:
            break
        starts += 1
        if not _looks_like_json(text, index):
            index += 1
            continue
        end = _json_end(text, index)
        if end is None:
            return _NO_JSON
        parsed = _loads(text[index:end])
        if parsed is _NO_JSON or not _accepts(parsed, shape):
            index = end
            continue
        accepted_count += 1
        if accepted_count > 1:
            return _NO_JSON
        accepted = parsed
        index = end
    return accepted if accepted_count == 1 else _NO_JSON


async def complete_text(body: dict[str, Any]) -> dict[str, Any]:
    """A single completion without tools. `json: true` parses one JSON object or array."""
    await asyncio.to_thread(require_verified_user, body.get("userId"))
    model = str(body.get("model") or CHEAPEST["google"])
    provider = str(body.get("provider") or infer_provider(model))
    messages: list[dict[str, Any]] = []
    if body.get("system"):
        messages.append({"role": "system", "content": body["system"]})
    messages.append({"role": "user", "content": body.get("prompt") or ""})
    if provider == "mock":
        mock_body = dict(body)
        mock_body["messages"] = messages
        result = _mock_turn(mock_body, model)
    elif provider == "cursor":
        raise ModelAuthError("Cursor is not a completion provider. Pick another provider for this tier.")
    elif provider == "anthropic":
        call = {
            "messages": messages,
            "maxTokens": body.get("maxTokens"),
            "userId": body.get("userId"),
            "reasoningEffort": body.get("reasoningEffort"),
            "fallbackModel": body.get("fallbackModel"),
            "chatTools": body.get("chatTools"),
        }
        result = await _anthropic_chat(call, model, body.get("userId"), 120)
    else:
        raw_temp = body.get("temperature", 0)
        temperature = 0.0 if raw_temp is None else float(raw_temp)
        result = await _openai_turn(
            body,
            model,
            provider,
            messages,
            120,
            temperature=temperature,
            json_mode=bool(body.get("json")),
            stream=bool(body.get("stream")),
        )
    out = {key: result[key] for key in ("text", "model", "tokensIn", "tokensOut")}
    if result.get("fallbackFrom"):
        out["fallbackFrom"] = result["fallbackFrom"]
    if body.get("json"):
        raw_text = result.get("text")
        text = raw_text if isinstance(raw_text, str) else ""
        shape = body.get("jsonShape")
        out["json"] = parse_model_json(text, shape if shape in {"triage", "plan"} else None)
    return out


async def complete_json(
    prompt: str,
    *,
    model: str | None = None,
    role: ModelRole = "planner",
    provider: str | None = None,
    user_id: str | None = None,
) -> tuple[Any, str, float | None]:
    """One structured JSON completion. Returns (payload, model, credits)."""
    spec = spec_for(role, model)
    result = await complete_text(
        {
            "model": spec["model"],
            "provider": provider or spec["provider"],
            "userId": user_id or profile.get().get("userId"),
            "system": "Return only JSON.",
            "prompt": prompt,
            "json": True,
            "jsonShape": "plan",
            "temperature": spec["temperature"],
            "reasoningEffort": profile.get().get("reasoningEffort"),
        }
    )
    return result["json"], result["model"], None


def _public_failure(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, (HostedAccessError, HostedAccessUnavailable)):
        return {"message": str(exc), "kind": "auth", "status": exc.status_code}
    if isinstance(exc, ModelUnreachable):
        return exc.to_dict()
    if isinstance(exc, ConnectionDropped):
        return {"message": CONNECTION_DROPPED_NOTICE, "kind": "other", "status": 503}
    if isinstance(exc, ProviderError):
        payload: dict[str, Any] = {"message": exc.message, "kind": exc.kind, "status": exc.status}
        if exc.quota_id:
            payload["quotaId"] = exc.quota_id
        if exc.retry_after_seconds is not None:
            payload["retryAfterSeconds"] = exc.retry_after_seconds
        return payload
    if isinstance(exc, (ModelAuthError, credentials.DecryptError)):
        status = 409 if isinstance(exc, credentials.DecryptError) else 503
        return {"message": str(exc), "kind": "auth", "status": status}
    text = str(exc)
    if "http://" in text or "https://" in text:
        text = "The model provider could not be reached."
    return {"message": truncate_text(text, 800), "kind": "other", "status": 502}


async def _chat_frames(body: dict[str, Any]):
    model = str(body.get("model") or spec_for("coder")["model"])
    provider = str(body.get("provider") or infer_provider(model))
    if provider == "mock":
        result = _mock_turn(body, model)
        wait = _mock_delay_seconds(body)
        if wait:
            await asyncio.sleep(wait)
        for piece in text_chunks(str(result.get("text") or "")):
            yield _sse("delta", {"text": piece})
        yield _sse("turn", result)
        return
    if provider == "cursor":
        raise _cursor_chat_error()
    if provider == "anthropic":
        result = await _anthropic_chat(body, model, body.get("userId"), 300)
        for piece in text_chunks(str(result.get("text") or "")):
            yield _sse("delta", {"text": piece})
        yield _sse("turn", result)
        return
    payload = build_chat_payload(
        model,
        provider,
        body.get("messages") or [],
        tools=body.get("chatTools") or None,
        reasoning_effort=body.get("reasoningEffort"),
        stream=True,
    )
    emitted = False
    try:
        async for frame in _yield_openai_frames(provider, payload, body, model, retry=True):
            emitted = True
            yield frame
    except ProviderError as exc:
        fallback = body.get("fallbackModel")
        if emitted or not _can_fallback(exc, fallback, model):
            raise
        alt = build_chat_payload(
            str(fallback),
            provider,
            body.get("messages") or [],
            tools=body.get("chatTools") or None,
            reasoning_effort=body.get("reasoningEffort"),
            stream=True,
        )
        async for frame in _yield_openai_frames(provider, alt, body, str(fallback), retry=False, fallback_from=model):
            yield frame


async def _yield_openai_frames(
    provider: str,
    payload: dict[str, Any],
    body: dict[str, Any],
    model: str,
    *,
    retry: bool,
    fallback_from: str | None = None,
):
    delay = await take_token(body.get("userId"), provider)
    if delay > 0:
        yield _sse("status", {"text": "Waiting for the rate limit…"})
        await asyncio.sleep(delay)
    async for kind, data in _openai_stream_events(provider, payload, body.get("userId"), body.get("ollamaUrl"), 300, retry=retry):
        if kind == "delta":
            yield _sse("delta", {"text": data})
        elif kind == "done":
            result = _from_openai(data, model)
            if fallback_from:
                result["fallbackFrom"] = fallback_from
            yield _sse("turn", result)


async def stream_with_tools(body: dict[str, Any]):
    """SSE frames: delta text, then the same object complete_with_tools returns."""
    try:
        await asyncio.to_thread(require_verified_user, body.get("userId"))
        async for frame in _chat_frames(body):
            yield frame
    except ProviderError as exc:
        yield _sse("error", _public_failure(exc))
    except ModelAuthError as exc:
        yield _sse("error", _public_failure(exc))
    except credentials.DecryptError as exc:
        yield _sse("error", _public_failure(exc))
    except Exception as exc:
        yield _sse("error", _public_failure(exc))


# ── catalog ─────────────────────────────────────────────────────────────────

_SKIP_GEMINI = re.compile(r"tts|image|robotics|computer-use|transcribe|omni|embedding|aqa|banana|lyria|research|antigravity|veo|imagen")
_catalog_cache: dict[tuple[str, str, str], tuple[float, list[str] | Exception]] = {}
_catalog_results: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}
_RESULT_TTL = 20
_RESULT_MAX = 32


def _remember_catalog(key: tuple[str, str], value: list[dict[str, Any]]) -> None:
    now = time.time()
    expired = [item for item, (exp, _) in _catalog_results.items() if exp <= now]
    for item in expired:
        _catalog_results.pop(item, None)
    if key not in _catalog_results and len(_catalog_results) >= _RESULT_MAX:
        oldest = min(_catalog_results, key=lambda item: _catalog_results[item][0])
        _catalog_results.pop(oldest, None)
    _catalog_results[key] = (now + _RESULT_TTL, value)


async def list_models(
    provider: str,
    user_id: str | None,
    ollama_url: str | None = None,
    secret: str | None = None,
    base_url: str | None = None,
) -> list[str]:
    await asyncio.to_thread(require_verified_user, user_id)
    if provider == "ollama" or base_url:
        await asyncio.to_thread(require_host_access, user_id, "Host Ollama and custom model proxies")
    cache_key = (provider, user_id or "", (secret or "")[-6:])
    cached = _catalog_cache.get(cache_key)
    if cached and cached[0] > time.time():
        if isinstance(cached[1], Exception):
            raise cached[1]
        return cached[1]
    cred = None
    if secret is None or (provider == "ollama" and not base_url):
        cred = await asyncio.to_thread(_resolve, user_id, provider)
    key = secret if secret is not None else (cred.secret if cred else "")
    ollama_base = base_url or (cred.base_url if cred else None)
    async with httpx.AsyncClient(timeout=15) as client:
        if provider == "google":
            response = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", headers={"x-goog-api-key": key}
            )
            response.raise_for_status()
            models = [
                row["name"].removeprefix("models/")
                for row in response.json().get("models", [])
                if "generateContent" in row.get("supportedGenerationMethods", [])
                and row["name"].startswith(("models/gemini", "models/gemma"))
                and not _SKIP_GEMINI.search(row["name"])
            ]
        elif provider in ("openai", "openrouter", "mistral", "kimi", "qwen"):
            response = await client.get(f"{BASES[provider]}/models", headers={"Authorization": f"Bearer {key}"})
            response.raise_for_status()
            models = sorted(row["id"] for row in response.json().get("data", []))
            if provider == "openai":
                models = [name for name in models if name.startswith(("gpt", "o1", "o3", "o4"))]
            if provider == "mistral":
                models = [name for name in models if not name.startswith(("voxtral", "mistral-ocr", "mistral-embed", "codestral-embed"))]
            if provider == "qwen":
                models = [name for name in models if "qwen" in name.lower() and "embed" not in name.lower() and "vl" not in name.lower()]
        elif provider == "anthropic":
            response = await client.get(
                "https://api.anthropic.com/v1/models", headers={"x-api-key": key, "anthropic-version": "2023-06-01"}
            )
            response.raise_for_status()
            models = [row["id"] for row in response.json().get("data", [])]
        elif provider == "cursor":
            response = await client.get("https://api.cursor.com/v0/models", auth=(key, ""))
            response.raise_for_status()
            models = list(response.json().get("models", []))
        elif provider == "ollama":
            base = (ollama_base or ollama_url or "http://127.0.0.1:11434").rstrip("/")
            response = await client.get(f"{base}/api/tags", timeout=2)
            response.raise_for_status()
            models = [row["name"] for row in response.json().get("models", [])]
        elif provider == "copilot":
            token, base = await _copilot_session(key, allow_host_config=await asyncio.to_thread(can_use_host_credentials, user_id))
            response = await client.get(
                f"{base}/models",
                headers={"Authorization": f"Bearer {token}", "Editor-Version": "Ensemble/0.1", "Copilot-Integration-Id": "vscode-chat"},
            )
            response.raise_for_status()
            models = [row["id"] for row in response.json().get("data", [])]
        else:
            models = []
    _catalog_cache[cache_key] = (time.time() + 45, models)
    return models


async def catalog(user_id: str | None, ollama_url: str | None) -> list[dict[str, Any]]:
    await asyncio.to_thread(require_verified_user, user_id)
    key = (user_id or "", ollama_url or "")
    cached = _catalog_results.get(key)
    if cached and cached[0] > time.time():
        return cached[1]

    async def one(provider: str) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "provider": provider,
            "available": False,
            "source": "none",
            "models": [],
            "chat": provider != "cursor",
            "cheapest": CHEAPEST.get(provider),
            "error": None,
        }
        try:
            cred = await asyncio.to_thread(_resolve, user_id, provider)
        except ModelAuthError as exc:
            entry["error"] = str(exc)[:200]
            return entry
        entry["source"] = cred.source
        if provider != "ollama" and not cred.secret:
            return entry
        try:
            entry["models"] = await list_models(provider, user_id, ollama_url, secret=cred.secret or None, base_url=cred.base_url)
            entry["available"] = bool(entry["models"]) or provider != "ollama"
        except Exception as exc:
            entry["error"] = str(exc)[:200] if provider != "ollama" else None
            _catalog_cache[(provider, user_id or "", (cred.secret or "")[-6:])] = (time.time() + 20, exc)
        return entry

    out = list(await asyncio.gather(*(one(provider) for provider in credentials.PROVIDERS)))
    _remember_catalog(key, out)
    return out


def clear_catalog_cache() -> None:
    _catalog_cache.clear()
    _catalog_results.clear()
