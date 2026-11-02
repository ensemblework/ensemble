"""How long one model call may take: ``ENSEMBLE_MODEL_CALL_TIMEOUT_MS``, as in hub-api's lib/model-timeout.ts.

hub-api starts the clock and sends what it allows as ``timeoutMs``. This runtime waits that long and
a few seconds more, so hub-api always cuts first and says why; without it, the setting is the limit.
"""

from __future__ import annotations

import math
import os
from collections.abc import Mapping
from typing import Any

from ensemble_agent.provider_error import ProviderError

DEFAULT_MS = 15 * 60_000
MIN_MS = 30_000
MAX_MS = 30 * 60_000
# The runtime's margin past hub-api's limit.
GRACE_MS = 10_000


def model_call_timeout_ms(env: Mapping[str, str] | None = None) -> int:
    source = os.environ if env is None else env
    raw = (source.get("ENSEMBLE_MODEL_CALL_TIMEOUT_MS") or "").strip()
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_MS
    if not math.isfinite(value):
        return DEFAULT_MS
    return int(min(MAX_MS, max(MIN_MS, round(value))))


def runtime_seconds(body: Mapping[str, Any], env: Mapping[str, str] | None = None) -> float:
    """What this runtime waits for a provider: hub-api's ``timeoutMs`` and the margin, else the setting."""
    asked = body.get("timeoutMs")
    if isinstance(asked, (int, float)) and not isinstance(asked, bool) and math.isfinite(asked) and asked >= 1_000:
        return (min(float(asked), MAX_MS) + GRACE_MS) / 1000
    return model_call_timeout_ms(env) / 1000


def duration_words(ms: float) -> str:
    if ms < 90_000 and ms % 60_000:
        seconds = max(1, round(ms / 1000))
        return f"{seconds} second{'' if seconds == 1 else 's'}"
    minutes = max(1, round(ms / 60_000))
    return f"{minutes} minute{'' if minutes == 1 else 's'}"


def timeout_message(model: str, ms: float) -> str:
    from ensemble_agent.included import MODELS

    known = MODELS.get(model)
    label = known.label if known else model.strip() or "The model"
    return f"{label} did not answer within {duration_words(ms)}, so I stopped waiting. Ask again, or try a narrower question."


class ModelTimeout(ProviderError):
    """A model call that ran past its limit. hub-api shows its message."""

    def __init__(self, model: str, seconds: float) -> None:
        super().__init__(504, "timeout", timeout_message(model, seconds * 1000))
