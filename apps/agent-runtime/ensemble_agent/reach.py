"""Name the cause when the model host cannot be contacted.

A socket that connected and then died is not this error. The public sentence
is built here. Raw error text, stacks, and server paths are not copied into it.
"""

from __future__ import annotations

import errno
import re
from typing import Any
from urllib.parse import urlparse

MODEL_UNREACHABLE = "model_unreachable"

PROVIDER_NAMES = {
    "google": "Google",
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "mistral": "Mistral",
    "kimi": "Kimi",
    "qwen": "Qwen",
    "openrouter": "OpenRouter",
    "copilot": "GitHub Copilot",
    "cursor": "Cursor",
    "ollama": "Ollama",
}

_DROP_NAMES = frozenset(
    {
        "RemoteProtocolError",
        "ReadError",
        "ProtocolError",
        "WriteError",
        "CloseError",
        "ConnectionDropped",
    }
)
_DROP_CODES = frozenset({"ECONNRESET", "EPIPE", "UND_ERR_SOCKET"})
_REFUSED_CODES = frozenset({"ECONNREFUSED"})
_DNS_CODES = frozenset({"ENOTFOUND", "EAI_AGAIN"})
_DROP_ERRNOS = frozenset({errno.ECONNRESET, errno.EPIPE})
_REFUSED_ERRNOS = frozenset({errno.ECONNREFUSED})
_DNS_ERRNOS = frozenset(
    {
        getattr(errno, "EAI_NONAME", -2),
        getattr(errno, "EAI_AGAIN", -3),
        getattr(errno, "EAI_FAIL", -4),
    }
)
_DROP_PHRASE = re.compile(
    r"peer closed connection|incomplete chunked read|socket hang up|other side closed|"
    r"closed before headers|und_err_socket|econnreset|connection reset|\bepipe\b|"
    r"server disconnected without sending",
    re.IGNORECASE,
)
# httpx 0.28 wraps a refused connect as ConnectError("All connection attempts failed").
# anyio/httpcore put ConnectionRefusedError on __context__, with "Connect call failed".
_REFUSED_PHRASE = re.compile(
    r"econnrefused|connection refused|all connection attempts failed|connect call failed",
    re.IGNORECASE,
)
_DNS_PHRASE = re.compile(
    r"enotfound|getaddrinfo|name or service not known|nodename nor servname|"
    r"temporary failure in name resolution|name resolution|unknown host|err_invalid_url",
    re.IGNORECASE,
)


def _code(exc: BaseException) -> str:
    code = getattr(exc, "code", None)
    return code if isinstance(code, str) else ""


def _errno(exc: BaseException) -> int | None:
    value = getattr(exc, "errno", None)
    return value if isinstance(value, int) else None


def _chain(exc: BaseException) -> list[BaseException]:
    """Follow ``__cause__``, ``__context__``, and ExceptionGroup children.

    httpx's ConnectError names only "All connection attempts failed". The
    ConnectionRefusedError (or gaierror) sits on the httpcore error's context,
    not on ``__cause__``.
    """
    out: list[BaseException] = []
    seen: set[int] = set()

    def visit(current: BaseException | None) -> None:
        if not isinstance(current, BaseException) or id(current) in seen:
            return
        seen.add(id(current))
        out.append(current)
        grouped = getattr(current, "exceptions", None)
        if isinstance(grouped, (tuple, list)):
            for item in grouped:
                if isinstance(item, BaseException):
                    visit(item)
        cause = current.__cause__
        if isinstance(cause, BaseException):
            visit(cause)
        context = current.__context__
        if isinstance(context, BaseException) and context is not cause:
            visit(context)

    visit(exc)
    return out


def classify_connect(exc: BaseException) -> str:
    """``drop``, ``refused``, ``dns``, or ``other``.

    ``drop`` means a connection was established and then died. Refused and DNS
    never connected. A drop signature wins when both are present.
    """
    parts = _chain(exc)
    blob = "\n".join(f"{type(item).__name__} {_code(item)} {_errno(item) or ''} {item}" for item in parts)
    codes = {_code(item) for item in parts if _code(item)}
    errnos = {number for item in parts if (number := _errno(item)) is not None}
    names = {type(item).__name__ for item in parts}
    messages = [str(item).strip().lower() for item in parts]
    if (
        codes & _DROP_CODES
        or errnos & _DROP_ERRNOS
        or names & _DROP_NAMES
        or any(message == "terminated" for message in messages)
        or _DROP_PHRASE.search(blob)
    ):
        return "drop"
    if (
        codes & _REFUSED_CODES
        or errnos & _REFUSED_ERRNOS
        or any(isinstance(item, ConnectionRefusedError) for item in parts)
        or _REFUSED_PHRASE.search(blob)
    ):
        return "refused"
    if codes & _DNS_CODES or errnos & _DNS_ERRNOS or _DNS_PHRASE.search(blob):
        return "dns"
    return "other"


def _safe_token(value: str, *, allow_url: bool) -> str:
    cleaned = re.sub(r"\s+", "", value)[:200]
    if re.fullmatch(r"[A-Za-z0-9._:-]+", cleaned):
        return cleaned
    if allow_url and re.fullmatch(r"https?://[A-Za-z0-9._:-]+", cleaned):
        return cleaned
    return "the model host"


def host_label(url: str) -> str:
    try:
        parsed = urlparse(url)
    except ValueError:
        return "the model host"
    host = parsed.hostname or ""
    if not host:
        return "the model host"
    if parsed.port and parsed.port not in (80, 443):
        return _safe_token(f"{host}:{parsed.port}", allow_url=False)
    return _safe_token(host, allow_url=False)


def origin_label(url: str) -> str:
    try:
        parsed = urlparse(url)
    except ValueError:
        return "the model host"
    if not parsed.scheme or not parsed.hostname:
        return "the model host"
    origin = f"{parsed.scheme}://{parsed.hostname}"
    if parsed.port:
        origin = f"{origin}:{parsed.port}"
    return _safe_token(origin, allow_url=True)


def provider_label(provider: str) -> str:
    if provider in PROVIDER_NAMES:
        return PROVIDER_NAMES[provider]
    if re.fullmatch(r"[A-Za-z0-9._-]{1,40}", provider or ""):
        return provider
    return "the provider"


def unreachable_message(provider: str, url: str, kind: str) -> tuple[str, str, str]:
    """Public sentence, reason code, and host. The host comes from the URL we called."""
    if provider == "ollama" and kind == "refused":
        host = origin_label(url)
        return f"Couldn't reach Ollama at {host}. Is it running?", "down", host
    if kind == "dns":
        host = host_label(url)
        return f"{host} couldn't be found. Check the model URL.", "dns", host
    host = host_label(url)
    return f"Couldn't reach {provider_label(provider)} at {host}: connection refused", "refused", host


def is_unreachable_notice(content: str) -> bool:
    text = content.strip()
    if text.startswith("Couldn't reach ") and (text.endswith("Is it running?") or text.endswith(": connection refused")):
        return True
    return text.endswith("couldn't be found. Check the model URL.")


class ModelUnreachable(Exception):
    """The model host was never reached. ``message`` is safe to show."""

    def __init__(self, message: str, *, provider: str, model: str, host: str, reason: str) -> None:
        super().__init__(message)
        self.message = message
        self.code = MODEL_UNREACHABLE
        self.provider = provider
        self.model = model
        self.host = host
        self.reason = reason
        self.status = 503

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "error": self.message,
            "message": self.message,
            "provider": self.provider,
            "model": self.model,
            "host": self.host,
            "reason": self.reason,
            "kind": "unreachable",
            "status": self.status,
        }


def transport_failure(exc: BaseException, *, provider: str, model: str, url: str) -> ModelUnreachable | None:
    if isinstance(exc, ModelUnreachable):
        return exc
    kind = classify_connect(exc)
    if kind not in {"refused", "dns"}:
        return None
    message, reason, host = unreachable_message(provider, url, kind)
    return ModelUnreachable(message, provider=provider, model=model, host=host, reason=reason)
