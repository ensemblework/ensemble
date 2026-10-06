"""Saved model keys. No database."""

from __future__ import annotations

import logging
import pytest

from ensemble_agent import credentials


def test_strip_prisma_query_params() -> None:
    raw = "postgresql://ensemble:s3cret@localhost:5432/ensemble?connection_limit=5&pool_timeout=10&schema=public&sslmode=require"
    stripped = credentials.strip_prisma_params(raw)
    assert "connection_limit" not in stripped
    assert "pool_timeout" not in stripped
    assert "schema=" not in stripped
    assert "sslmode=require" in stripped
    assert stripped.startswith("postgresql://ensemble:s3cret@localhost:5432/ensemble?")
    only = "postgresql://ensemble:s3cret@localhost:5432/ensemble?connection_limit=5"
    assert credentials.strip_prisma_params(only) == "postgresql://ensemble:s3cret@localhost:5432/ensemble"
    plain = "postgresql://ensemble:s3cret@localhost:5432/ensemble"
    assert credentials.strip_prisma_params(plain) == plain


def test_connect_error_is_logged_without_the_url(monkeypatch, caplog) -> None:
    dsn = "postgresql://ensemble:s3cret@localhost:5432/ensemble?connection_limit=5"
    monkeypatch.setenv("DATABASE_URL", dsn)
    seen: dict[str, str] = {}

    def boom(passed: str):
        seen["dsn"] = passed
        raise RuntimeError(f"could not connect using {passed} password=s3cret")

    monkeypatch.setattr(credentials, "_open", boom)
    credentials._cred_cache.clear()
    with caplog.at_level(logging.WARNING, logger="ensemble.credentials"):
        with pytest.raises(RuntimeError):
            credentials.stored_map("user-connect")
    assert "connection_limit" not in seen["dsn"]
    text = caplog.text
    assert "saved model keys were not loaded" in text
    assert "RuntimeError" in text
    assert "could not connect" in text
    assert "s3cret" not in text
    assert "postgresql://" not in text
    assert dsn not in text
