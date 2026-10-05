"""Redact secrets before they reach a log line."""

from __future__ import annotations

import logging
import re

_QUERY = re.compile(
    r"([?&](?:ticket|token|access_token|refresh_token|id_token|code|api_key|apikey|client_secret|password|secret|key)=)[^&#\s]*",
    re.IGNORECASE,
)
_BEARER = re.compile(r"(authorization\s*[:=]\s*bearer\s+)\S+", re.IGNORECASE)
_INTERNAL = re.compile(r"(x-ensemble-internal\s*[:=]\s*)\S+", re.IGNORECASE)
_SHAPED = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{10,}|"
    r"github_pat_[A-Za-z0-9_]{10,}|ens_[A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9-]{8,})\b"
)


def redact_text(value: str) -> str:
    value = _QUERY.sub(r"\1[redacted]", value)
    value = _BEARER.sub(r"\1[redacted]", value)
    value = _INTERNAL.sub(r"\1[redacted]", value)
    return _SHAPED.sub("[redacted]", value)


class SecretRedactFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_text(record.msg)
        if record.args:
            record.args = _redact_args(record.args)
        return True


def _redact_args(args: tuple[object, ...] | dict[str, object]) -> tuple[object, ...] | dict[str, object]:
    if isinstance(args, dict):
        return {key: redact_text(value) if isinstance(value, str) else value for key, value in args.items()}
    return tuple(redact_text(value) if isinstance(value, str) else value for value in args)


def install_secret_redaction() -> None:
    root = logging.getLogger()
    if any(isinstance(item, SecretRedactFilter) for item in root.filters):
        return
    root.addFilter(SecretRedactFilter())
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
