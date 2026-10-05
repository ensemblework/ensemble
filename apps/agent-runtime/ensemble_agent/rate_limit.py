"""Per-key token bucket so one tool turn cannot burst past the provider RPM.

When REDIS_URL points at a real Redis, every process that shares the key
draws from the same bucket. Otherwise each process keeps its own.
"""

from __future__ import annotations

import asyncio
import os
import time

# Free-tier Gemini is 15 requests per minute. Other providers get a wider bucket.
_RPM = {"google": 15}
_DEFAULT_RPM = 60

_buckets: dict[str, "_Bucket"] = {}
_locks: dict[str, asyncio.Lock] = {}
_MISSING = object()
_injected: object = _MISSING
_auto_client: object = _MISSING
_redis_down_until = 0.0

# Atomic refill. The local bucket below uses the same numbers.
_SCRIPT = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local rate = tonumber(ARGV[3])
local raw = redis.call("GET", key)
local tokens = capacity
local updated = now
if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == "table" then
    tokens = tonumber(parsed.tokens) or capacity
    updated = tonumber(parsed.updated) or now
  end
end
local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * rate)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  updated = now
else
  wait = (1 - tokens) / rate
  tokens = 0
  updated = now + wait
end
redis.call("SET", key, cjson.encode({tokens = tokens, updated = updated}), "EX", 180)
return string.format("%.6f", wait)
"""


class _Bucket:
    def __init__(self, rpm: int) -> None:
        self.capacity = float(rpm)
        self.tokens = float(rpm)
        self.rate = float(rpm) / 60.0
        self.updated = time.monotonic()

    def reserve(self, now: float) -> float:
        elapsed = max(0.0, now - self.updated)
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
        self.updated = now
        if self.tokens >= 1:
            self.tokens -= 1
            return 0.0
        wait = (1 - self.tokens) / self.rate
        self.tokens = 0.0
        self.updated = now + wait
        return wait


def set_rate_limit_client_for_tests(client: object) -> None:
    """Pass a Redis-like client, or None to force the in-process bucket."""
    global _injected
    _injected = client


def reset_rate_limit_client_for_tests() -> None:
    global _injected
    _injected = _MISSING


def _redis_url() -> str:
    url = os.environ.get("REDIS_URL", "").strip()
    if not url or url.startswith("memory:"):
        return ""
    return url


def _note_redis_down() -> None:
    global _redis_down_until
    if _injected is _MISSING:
        _redis_down_until = time.monotonic() + 30


def _redis_client():
    global _auto_client, _redis_down_until
    if _injected is not _MISSING:
        return _injected
    if time.monotonic() < _redis_down_until:
        return None
    url = _redis_url()
    if not url:
        return None
    if _auto_client is _MISSING:
        try:
            import redis
        except ImportError:
            _redis_down_until = time.monotonic() + 30
            return None
        _auto_client = redis.Redis.from_url(url, socket_connect_timeout=0.3, socket_timeout=0.3)
    return _auto_client


def _reserve_redis(client: object, ident: str, rpm: int, now: float) -> float:
    key = f"ensemble:model-rpm:{ident}"
    raw = client.eval(_SCRIPT, 1, key, f"{now:.6f}", str(rpm), f"{rpm / 60.0:.8f}")  # type: ignore[attr-defined]
    return float(raw)


def reserve_delay(user_id: str | None, provider: str, *, now: float | None = None) -> float:
    """Seconds to wait before the next call. Reserves the token immediately."""
    if provider in ("mock", "cursor", ""):
        return 0.0
    rpm = _RPM.get(provider, _DEFAULT_RPM)
    ident = f"{user_id or 'anon'}:{provider}:{rpm}"
    instant = time.monotonic() if now is None else now
    client = _redis_client()
    if client is not None:
        try:
            return _reserve_redis(client, ident, rpm, instant)
        except Exception:
            _note_redis_down()
    bucket = _buckets.setdefault(ident, _Bucket(rpm))
    return bucket.reserve(instant)


async def take_token(user_id: str | None, provider: str) -> float:
    """Reserve one request. Returns the wait; the caller sleeps outside the lock."""
    if provider in ("mock", "cursor", ""):
        return 0.0
    rpm = _RPM.get(provider, _DEFAULT_RPM)
    ident = f"{user_id or 'anon'}:{provider}:{rpm}"
    lock = _locks.setdefault(ident, asyncio.Lock())
    async with lock:
        return reserve_delay(user_id, provider)


async def pace(user_id: str | None, provider: str) -> float:
    """Wait until this key has a request token. Returns how long it waited."""
    delay = await take_token(user_id, provider)
    if delay > 0:
        await asyncio.sleep(delay)
    return delay


def reset_buckets() -> None:
    _buckets.clear()
