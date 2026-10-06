"""Model credentials. The runtime is the only resolver (docs/11 §5).

A key the engineer pasted in Settings wins over the environment, so a hosted
Ensemble can hold one fallback key while each person brings their own.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from ensemble_agent.config import get_settings
from ensemble_agent.vault import decrypt, encrypt, hint
from ensemble_agent.hosted_access import can_use_host_credentials, require_host_access, require_verified_user

Provider = Literal["openai", "anthropic", "google", "mistral", "kimi", "qwen", "copilot", "cursor", "openrouter", "ollama"]
PROVIDERS: tuple[Provider, ...] = (
    "google",
    "openai",
    "anthropic",
    "mistral",
    "kimi",
    "qwen",
    "openrouter",
    "copilot",
    "cursor",
    "ollama",
)

ENV_KEYS: dict[str, tuple[str, ...]] = {
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "google": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    "mistral": ("MISTRAL_API_KEY",),
    "kimi": ("MOONSHOT_API_KEY", "KIMI_API_KEY"),
    "qwen": ("DASHSCOPE_API_KEY", "QWEN_API_KEY"),
    "copilot": ("COPILOT_API_KEY", "GITHUB_TOKEN"),
    "cursor": ("CURSOR_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
    "ollama": (),
}


@dataclass(frozen=True)
class Credential:
    provider: str
    secret: str
    source: Literal["you", "env", "cli", "none"]
    base_url: str | None = None


DECRYPT_MESSAGE = "This stored key can't be decrypted — re-enter it in Settings → Models."


class DecryptError(Exception):
    """The stored ciphertext could not be opened. Not a server fault."""

    def __init__(self, message: str = DECRYPT_MESSAGE) -> None:
        super().__init__(message)


import threading
import time

_conn_lock = threading.Lock()
_conn = None
_cred_cache: dict[str, tuple[float, dict[str, tuple[str, str | None]], set[str]]] = {}
_gh_cache: tuple[float, str | None] | None = None
_log = logging.getLogger("ensemble.credentials")

# Prisma adds these. libpq rejects them, and a failed connect used to drop every saved key with no log.
_PRISMA_ONLY_PARAMS = frozenset({"connection_limit", "pool_timeout", "schema"})
_URL_PASSWORD = re.compile(r"([a-z][a-z0-9+.-]*://[^:/\s]+:)([^@/\s]+)@", re.IGNORECASE)
_PASSWORD_PARAM = re.compile(r"(?i)(password=)[^&\s]+")


def strip_prisma_params(dsn: str) -> str:
    """Drop Prisma-only query params so psycopg can open the same DATABASE_URL."""
    try:
        parts = urlsplit(dsn)
    except ValueError:
        return dsn
    if not parts.query:
        return dsn
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    kept = [(key, value) for key, value in pairs if key not in _PRISMA_ONLY_PARAMS]
    if len(kept) == len(pairs):
        return dsn
    query = urlencode(kept)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def _safe_db_message(exc: BaseException, dsn: str) -> str:
    """Error class and message, with the database URL and password removed."""
    text = f"{type(exc).__name__}: {exc}"
    variants = [dsn, strip_prisma_params(dsn)]
    for variant in variants:
        if variant:
            text = text.replace(variant, "[database]")
    text = _URL_PASSWORD.sub(r"\1[redacted]@", text)
    text = _PASSWORD_PARAM.sub(r"\1[redacted]", text)
    return text


def _warn_connect(exc: BaseException, dsn: str) -> None:
    _log.warning("saved model keys were not loaded: %s", _safe_db_message(exc, dsn))


def _open(dsn: str):
    import psycopg

    return psycopg.connect(dsn, autocommit=True)


class _PooledConnection:
    """One process-wide connection. Callers still use `with _connect()`."""

    def __enter__(self):
        global _conn
        _conn_lock.acquire()
        dsn = get_settings().psycopg_dsn
        try:
            closed = _conn is None or getattr(_conn, "closed", True)
            if closed:
                _conn = _open(strip_prisma_params(dsn))
            return _conn
        except Exception as exc:
            _conn_lock.release()
            _warn_connect(exc, dsn)
            raise

    def __exit__(self, exc_type, exc, tb):
        global _conn
        try:
            if exc_type is not None:
                try:
                    if _conn is not None:
                        _conn.close()
                except Exception:
                    pass
                _conn = None
        finally:
            _conn_lock.release()
        return False


def _connect():
    return _PooledConnection()


def stored_map(user_id: str) -> dict[str, tuple[str, str | None]]:
    """Every saved credential for a user, from one query."""
    now = time.monotonic()
    cached = _cred_cache.get(user_id)
    if cached and cached[0] > now:
        return cached[1]
    found: dict[str, tuple[str, str | None]] = {}
    broken: set[str] = set()
    with _connect() as conn:
        rows = conn.execute(
            "select provider, secret, base_url from model_credentials where user_id = %s",
            (user_id,),
        ).fetchall()
    for provider, secret, base_url in rows:
        try:
            found[str(provider)] = (decrypt(secret), base_url)
        except Exception:
            broken.add(str(provider))
    _cred_cache[user_id] = (now + 20, found, broken)
    return found


def _broken(user_id: str) -> set[str]:
    cached = _cred_cache.get(user_id)
    if cached and cached[0] > time.monotonic():
        return cached[2]
    stored_map(user_id)
    cached = _cred_cache.get(user_id)
    return cached[2] if cached else set()


def _stored(user_id: str, provider: str) -> tuple[str, str | None] | None:
    with _connect() as conn:
        row = conn.execute(
            "select secret, base_url from model_credentials where user_id = %s and provider = %s",
            (user_id, provider),
        ).fetchone()
    if not row:
        return None
    try:
        secret = decrypt(row[0])
    except Exception as exc:
        raise DecryptError(DECRYPT_MESSAGE) from exc
    return secret, row[1]


def _gh_token() -> str | None:
    global _gh_cache
    now = time.monotonic()
    if _gh_cache and _gh_cache[0] > now:
        return _gh_cache[1]
    gh = shutil.which("gh")
    token: str | None = None
    if gh:
        try:
            result = subprocess.run([gh, "auth", "token"], capture_output=True, text=True, timeout=10, check=False)
        except (subprocess.SubprocessError, OSError):
            result = None
        if result is not None:
            text = result.stdout.strip()
            token = text if result.returncode == 0 and text else None
    _gh_cache = (now + 45, token)
    return token


def resolve(user_id: str | None, provider: str) -> Credential:
    require_verified_user(user_id)
    if provider == "mock":
        return Credential(provider, "mock", "you")
    if user_id:
        if provider in _broken(user_id):
            raise DecryptError(DECRYPT_MESSAGE)
        stored = stored_map(user_id).get(provider)
        if stored:
            if stored[1]:
                require_host_access(user_id, "Custom model proxies")
            return Credential(provider, stored[0], "you", stored[1])
    if not can_use_host_credentials(user_id):
        return Credential(provider, "", "none")
    for name in ENV_KEYS.get(provider, ()):
        value = os.environ.get(name, "").strip()
        if value:
            return Credential(provider, value, "env")
    if provider == "copilot":
        token = _gh_token()
        if token:
            return Credential(provider, token, "cli")
    return Credential(provider, "", "none")


def save(user_id: str, provider: str, secret: str, base_url: str | None = None) -> None:
    if base_url:
        require_host_access(user_id, "Custom model proxies")
    _cred_cache.pop(user_id, None)
    with _connect() as conn:
        conn.execute(
            """
            insert into model_credentials (user_id, provider, secret, hint, base_url, updated_at)
            values (%s, %s, %s, %s, %s, now())
            on conflict (user_id, provider)
            do update set secret = excluded.secret, hint = excluded.hint, base_url = excluded.base_url, updated_at = now()
            """,
            (user_id, provider, encrypt(secret), hint(secret), base_url),
        )


def remove(user_id: str, provider: str) -> None:
    with _connect() as conn:
        conn.execute("delete from model_credentials where user_id = %s and provider = %s", (user_id, provider))


def listing(user_id: str) -> list[dict[str, object]]:
    rows: dict[str, tuple[str, object]] = {}
    with _connect() as conn:
        for provider, key_hint, updated in conn.execute(
            "select provider, hint, updated_at from model_credentials where user_id = %s", (user_id,)
        ).fetchall():
            rows[provider] = (key_hint, updated)
    allow_host_keys = can_use_host_credentials(user_id)
    out: list[dict[str, object]] = []
    for provider in PROVIDERS:
        if provider in rows:
            out.append({"provider": provider, "source": "you", "hint": rows[provider][0], "updatedAt": str(rows[provider][1])})
            continue
        env = next((name for name in ENV_KEYS.get(provider, ()) if allow_host_keys and os.environ.get(name, "").strip()), None)
        out.append({"provider": provider, "source": "env" if env else "none", "hint": env, "updatedAt": None})
    return out
