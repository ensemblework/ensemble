"""Provider failures as a structured error, before they cross the process boundary."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Mapping

ProviderKind = str

_MESSAGE_LIMIT = 800
_DELAY = re.compile(r"^(\d+(?:\.\d+)?)(ms|s)$")
_ZERO_LIMIT = re.compile(
    r'(?:"(?:quotaValue|quotaLimit|limit)"\s*:\s*"?0(?:\.0+)?"?|\blimit\s*[:=]?\s*0\b)',
    re.IGNORECASE,
)


class ProviderError(Exception):
    """A model provider rejected or failed a call.

    ``str(self)`` includes status, kind, message, and retryAfter so a process
    boundary that only forwards exception text can still map the failure.
    """

    def __init__(
        self,
        status: int,
        kind: str,
        message: str,
        quota_id: str | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        self.status = int(status)
        self.kind = kind
        self.message = message
        self.quota_id = quota_id
        self.retry_after_seconds = retry_after_seconds
        super().__init__(self._text())

    def _text(self) -> str:
        parts = [f"status={self.status}", f"kind={self.kind}"]
        if self.retry_after_seconds is not None:
            parts.append(f"retryAfter={self.retry_after_seconds:g}")
        if self.quota_id:
            parts.append(f"quotaId={self.quota_id}")
        parts.append(self.message)
        return " ".join(parts)

    def __str__(self) -> str:
        return self._text()


def parse_provider_error(status: int, body_text: str, headers: Mapping[str, str] | None) -> ProviderError:
    """Build a ProviderError from an HTTP status, body, and headers.

    Google bodies are read as ``error.message``, ``error.status``, and
    ``error.details[]`` (RetryInfo.retryDelay, QuotaFailure violations).
    Retry-After wins over the body delay when the header is present.
    """
    message, quota_id, body_delay, limit_zero = _google_error(body_text or "")
    header_delay = _retry_after_header(headers)
    retry_after = header_delay if header_delay is not None else body_delay
    kind = _kind(status, body_text or "", quota_id, limit_zero)
    return ProviderError(
        status=status,
        kind=kind,
        message=_compose_message(message, quota_id, retry_after),
        quota_id=quota_id,
        retry_after_seconds=retry_after,
    )


def friendly_key_error(provider: str, status: int, body: str) -> str:
    """One line for a failed key check. Never includes the request URL."""
    del body  # provider bodies and httpx errors can embed the URL
    name = _PROVIDER_NAMES.get(provider, provider or "The provider")
    if status in (400, 401, 403):
        if provider == "google":
            return "Google rejected this key (check it was copied fully and the Generative Language API is enabled)."
        return f"{name} rejected this key (check it was copied fully)."
    if status == 429:
        return f"{name} is rate-limiting this key. Wait a moment and try again."
    return f"That key did not work for {name}."


def annotate_models(ids: list[str], probes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Mark catalog rows from probe results. 503/high demand stays selectable."""
    by_model: dict[str, dict[str, Any]] = {}
    for probe in probes:
        model = probe.get("model")
        if isinstance(model, str):
            by_model[model] = probe
    rows: list[dict[str, Any]] = []
    for model_id in ids:
        probe = by_model.get(model_id)
        if probe is None:
            rows.append({"id": model_id, "available": True, "reason": None})
            continue
        kind = str(probe.get("kind") or "")
        detail = probe.get("detail")
        reason = detail.strip() if isinstance(detail, str) and detail.strip() else None
        rows.append(
            {
                "id": model_id,
                "available": kind not in ("not_found", "quota"),
                "reason": reason,
            }
        )
    return rows


_PROVIDER_NAMES = {
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


def _kind(status: int, body_text: str, quota_id: str | None, limit_zero: bool) -> str:
    if status in (401, 403):
        return "auth"
    if status == 404:
        return "not_found"
    if status == 400:
        return "invalid"
    if status == 429:
        return "quota" if _is_quota(body_text, quota_id, limit_zero) else "rate_limit"
    if status in (502, 503, 504):
        return "unavailable"
    if 500 <= status <= 599:
        return "other"
    return "other"


def _is_quota(body_text: str, quota_id: str | None, limit_zero: bool) -> bool:
    haystack = body_text.lower()
    ident = (quota_id or "").lower()
    if any(token in haystack for token in ("per-day", "per day", "per_day", "perday")):
        return True
    if "per_day" in ident or "perday" in ident:
        return True
    if "resource_exhausted" in haystack or "resource exhausted" in haystack:
        return True
    # quotaValue / limit 0, including free_tier rows that advertise a zero allowance.
    if limit_zero:
        return True
    return False


def _google_error(body_text: str) -> tuple[str, str | None, float | None, bool]:
    message = body_text.strip()
    quota_id: str | None = None
    quota_metric: str | None = None
    retry_after: float | None = None
    limit_zero = bool(_ZERO_LIMIT.search(body_text))
    try:
        data = json.loads(body_text)
    except json.JSONDecodeError:
        return message or "The model provider returned an error.", None, None, limit_zero
    error = data.get("error") if isinstance(data, dict) else None
    details: list[Any] = []
    if isinstance(error, dict):
        if isinstance(error.get("message"), str) and error["message"].strip():
            message = error["message"].strip()
        raw_details = error.get("details")
        if isinstance(raw_details, list):
            details = raw_details
    elif isinstance(data, dict) and isinstance(data.get("message"), str):
        message = data["message"].strip()
    for detail in details:
        if not isinstance(detail, dict):
            continue
        kind = str(detail.get("@type") or "")
        if "retryDelay" in detail or kind.endswith("RetryInfo"):
            parsed = _parse_delay(detail.get("retryDelay"))
            if parsed is not None:
                retry_after = parsed
        violations = detail.get("violations")
        if not isinstance(violations, list):
            continue
        if not (kind.endswith("QuotaFailure") or "violations" in detail):
            continue
        for violation in violations:
            if not isinstance(violation, dict):
                continue
            if quota_id is None and violation.get("quotaId"):
                quota_id = str(violation["quotaId"])
            if quota_metric is None and violation.get("quotaMetric"):
                quota_metric = str(violation["quotaMetric"])
            for key in ("quotaValue", "quotaLimit", "limit"):
                if _is_zero(violation.get(key)):
                    limit_zero = True
    if quota_id is None:
        quota_id = quota_metric
    if not message:
        message = "The model provider returned an error."
    return message, quota_id, retry_after, limit_zero


def _clip(text: str, room: int) -> str:
    if len(text) <= room:
        return text
    if room <= 3:
        return text[: max(room, 0)]
    return text[: room - 3].rstrip() + "..."


def _compose_message(message: str, quota_id: str | None, retry_after: float | None) -> str:
    """Clip provider prose to 800 characters without dropping quota id or retry delay."""
    text = (message or "").strip() or "The model provider returned an error."
    required: list[str] = []
    if quota_id:
        required.append(quota_id)
    if retry_after is not None:
        required.append(f"retryDelay={_format_retry(retry_after)}")
    if not required:
        return _clip(text, _MESSAGE_LIMIT)

    def missing_from(value: str) -> list[str]:
        return [part for part in required if part not in value]

    if len(text) <= _MESSAGE_LIMIT and not missing_from(text):
        return text
    trailer = " (" + ", ".join(required) + ")"
    if len(trailer) >= _MESSAGE_LIMIT:
        return trailer.strip()[:_MESSAGE_LIMIT]
    body = _clip(text, _MESSAGE_LIMIT - len(trailer))
    still_missing = missing_from(body)
    if not still_missing:
        return body
    trailer = " (" + ", ".join(still_missing) + ")"
    if len(trailer) >= _MESSAGE_LIMIT:
        return trailer.strip()[:_MESSAGE_LIMIT]
    body = _clip(text, _MESSAGE_LIMIT - len(trailer))
    if not body:
        return trailer.strip()
    return body + trailer


def _format_retry(seconds: float) -> str:
    if float(seconds).is_integer():
        return f"{int(seconds)}s"
    return f"{seconds:g}s"


def _is_zero(value: Any) -> bool:
    if value is None or isinstance(value, bool):
        return False
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return False
    try:
        return float(value) == 0.0
    except (TypeError, ValueError):
        return False


def _parse_delay(value: Any) -> float | None:
    if isinstance(value, dict):
        try:
            seconds = float(value.get("seconds") or 0)
            nanos = float(value.get("nanos") or 0)
        except (TypeError, ValueError):
            return None
        return seconds + nanos / 1_000_000_000
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if not isinstance(value, str):
        return None
    text = value.strip()
    match = _DELAY.fullmatch(text)
    if not match:
        try:
            return float(text)
        except ValueError:
            return None
    number = float(match.group(1))
    if match.group(2) == "ms":
        return number / 1000
    return number


def _header(headers: Mapping[str, str] | None, name: str) -> str | None:
    if not headers:
        return None
    folded = name.lower()
    for key, value in headers.items():
        if str(key).lower() == folded:
            return str(value)
    return None


def _retry_after_header(headers: Mapping[str, str] | None) -> float | None:
    raw = _header(headers, "retry-after")
    if raw is None:
        return None
    return _parse_retry_after(raw)


def _parse_retry_after(value: str) -> float | None:
    text = value.strip()
    if not text:
        return None
    try:
        return max(0.0, float(text))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())
