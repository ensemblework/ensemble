"""JSON-RPC 2.0 over stdio, one JSON object per line, with typed errors.

Every error carries `data.kind` (a stable name), `data.ran` ("no", "maybe" or "yes": whether anything
the request asked for may have happened) and `data.retryable`.
"""
from __future__ import annotations

import json
import time
from typing import Any

MAX_LINE_BYTES = 4 * 1024 * 1024

CODES: dict[str, int] = {
    "parse_error": -32700,
    "invalid_request": -32600,
    "method_not_found": -32601,
    "invalid_params": -32602,
    "internal": -32603,
    "consent_needed": -32001,
    "consent_denied": -32002,
    "stopped_by_owner": -32003,
    "no_session": -32004,
    "capture_failed": -32005,
    "input_failed": -32006,
    "element_gone": -32007,
    "target_not_found": -32008,
    "not_inspectable": -32009,
    "unsupported_here": -32010,
    "timeout": -32011,
    "cancelled": -32012,
    "recording_active": -32013,
    "recording_failed": -32014,
    "a11y_unavailable": -32015,
    "launch_failed": -32016,
    "bad_display": -32017,
    "no_recording": -32018,
}

RAN = ("no", "maybe", "yes")


class RpcError(Exception):
    def __init__(self, kind: str, message: str, *, ran: str = "no", retryable: bool = False, extra: dict[str, Any] | None = None):
        if kind not in CODES:
            kind = "internal"
        if ran not in RAN:
            ran = "maybe"
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.ran = ran
        self.retryable = retryable
        self.extra = extra or {}

    @property
    def code(self) -> int:
        return CODES[self.kind]

    def to_error(self) -> dict[str, Any]:
        data = {"kind": self.kind, "ran": self.ran, "retryable": self.retryable}
        data.update(self.extra)
        return {"code": self.code, "message": self.message[:2000], "data": data}


def error(kind: str, message: str, **kwargs: Any) -> RpcError:
    return RpcError(kind, message, **kwargs)


class Request:
    __slots__ = ("id", "method", "params")

    def __init__(self, id: int | str | None, method: str, params: dict[str, Any]):
        self.id = id
        self.method = method
        self.params = params

    @property
    def is_notification(self) -> bool:
        return self.id is None


def parse_line(line: str | bytes) -> Request:
    """One line from stdin as a request or a notification; raises RpcError for anything else."""
    if isinstance(line, bytes):
        if len(line) > MAX_LINE_BYTES:
            raise error("invalid_request", "The request is too large.")
        try:
            line = line.decode("utf-8")
        except UnicodeDecodeError:
            raise error("parse_error", "The request is not UTF-8.")
    elif len(line) > MAX_LINE_BYTES:
        raise error("invalid_request", "The request is too large.")
    try:
        message = json.loads(line)
    except (ValueError, RecursionError):
        raise error("parse_error", "The request is not JSON.")
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        raise error("invalid_request", "Expected a JSON-RPC 2.0 object.")
    method = message.get("method")
    if not isinstance(method, str) or not method or len(method) > 64:
        raise error("invalid_request", "The request has no method.")
    request_id = message.get("id")
    if request_id is not None and (isinstance(request_id, bool) or not isinstance(request_id, (int, str))):
        raise error("invalid_request", "The request id must be a number or a string.")
    params = message.get("params", {})
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise error("invalid_params", "Params must be an object.")
    return Request(request_id, method, params)


def _dump(message: dict[str, Any]) -> str:
    return json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"


def response(request_id: int | str | None, result: Any) -> str:
    return _dump({"jsonrpc": "2.0", "id": request_id, "result": result})


def error_response(request_id: int | str | None, failure: RpcError) -> str:
    return _dump({"jsonrpc": "2.0", "id": request_id, "error": failure.to_error()})


def notification(method: str, params: dict[str, Any]) -> str:
    return _dump({"jsonrpc": "2.0", "method": method, "params": params})


class Deadline:
    """The time a request may take, from its `deadline_ms` (milliseconds from now)."""

    def __init__(self, ms: float | None, clock=time.monotonic):
        self._clock = clock
        self._end = None if ms is None else clock() + max(0.0, float(ms)) / 1000.0

    @classmethod
    def from_params(cls, params: dict[str, Any], default_ms: float, clock=time.monotonic) -> "Deadline":
        raw = params.get("deadline_ms", default_ms)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise error("invalid_params", "deadline_ms must be a number.")
        if value != value or value <= 0:
            raise error("invalid_params", "deadline_ms must be positive.")
        return cls(min(value, 600_000.0), clock)

    def remaining(self) -> float:
        if self._end is None:
            return float("inf")
        return max(0.0, self._end - self._clock())

    def expired(self) -> bool:
        return self.remaining() <= 0

    def check(self, ran: str = "no") -> None:
        if self.expired():
            raise error("timeout", "The request ran out of time on this computer.", ran=ran, retryable=True)


def param(params: dict[str, Any], name: str, kind: type | tuple[type, ...], default: Any = ..., *, required: bool = False) -> Any:
    """A typed parameter: missing gives `default` (or an error when required), the wrong type is an error."""
    if name not in params or params[name] is None:
        if required or default is ...:
            raise error("invalid_params", f"{name} is required.")
        return default
    value = params[name]
    if kind in (int, float) or (isinstance(kind, tuple) and float in kind):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise error("invalid_params", f"{name} must be a number.")
        return value
    if not isinstance(value, kind):
        raise error("invalid_params", f"{name} has the wrong type.")
    return value
