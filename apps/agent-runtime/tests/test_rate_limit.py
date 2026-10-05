"""The Gemini bucket is shared when Redis is configured, and local otherwise."""

import os

import pytest

from ensemble_agent.rate_limit import (
    reserve_delay,
    reset_buckets,
    reset_rate_limit_client_for_tests,
    set_rate_limit_client_for_tests,
)


class _FakeRedis:
    """In-memory stand-in. Two calls share one bucket even after the process map is cleared."""

    def __init__(self) -> None:
        self.state: dict[str, tuple[float, float]] = {}

    def eval(self, _script: str, _numkeys: int, key: str, now: str, capacity: str, rate: str) -> str:
        instant = float(now)
        cap = float(capacity)
        per_second = float(rate)
        tokens, updated = self.state.get(key, (cap, instant))
        elapsed = max(0.0, instant - updated)
        tokens = min(cap, tokens + elapsed * per_second)
        if tokens >= 1:
            tokens -= 1
            wait = 0.0
            updated = instant
        else:
            wait = (1 - tokens) / per_second
            tokens = 0.0
            updated = instant + wait
        self.state[key] = (tokens, updated)
        return f"{wait:.6f}"


def test_shared_bucket_survives_a_local_reset() -> None:
    fake = _FakeRedis()
    set_rate_limit_client_for_tests(fake)
    try:
        reset_buckets()
        start = 1_000.0
        waits = [reserve_delay("shared-user", "google", now=start) for _ in range(15)]
        assert waits == [0.0] * 15
        reset_buckets()
        assert reserve_delay("shared-user", "google", now=start) == pytest.approx(4.0)
        assert reserve_delay("other-user", "google", now=start) == 0.0
    finally:
        reset_rate_limit_client_for_tests()
        reset_buckets()


def test_redis_bucket_matches_the_local_rule() -> None:
    url = os.environ.get("REDIS_URL", "").strip()
    if not url or url.startswith("memory:"):
        pytest.skip("Redis is not configured (REDIS_URL is unset)")
    try:
        import redis
    except ImportError as exc:
        pytest.skip(f"Redis client is not installed: {exc}")
    client = redis.Redis.from_url(url, socket_connect_timeout=0.4, socket_timeout=0.4)
    try:
        client.ping()
    except Exception as exc:
        pytest.skip(f"Redis is not reachable: {type(exc).__name__}: {exc}")
    set_rate_limit_client_for_tests(client)
    try:
        reset_buckets()
        start = 2_000.0
        ident = "redis-user"
        key = f"ensemble:model-rpm:{ident}:google:15"
        client.delete(key)
        waits = [reserve_delay(ident, "google", now=start) for _ in range(15)]
        assert waits == [0.0] * 15
        reset_buckets()
        assert reserve_delay(ident, "google", now=start) == pytest.approx(4.0, abs=0.02)
    finally:
        reset_rate_limit_client_for_tests()
        reset_buckets()
        try:
            client.delete(f"ensemble:model-rpm:redis-user:google:15")
        except Exception:
            pass
