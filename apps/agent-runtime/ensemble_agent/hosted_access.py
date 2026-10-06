from __future__ import annotations

import os
import logging
from collections.abc import Mapping


class HostedAccessError(Exception):
    status_code = 403


class HostedAccessUnavailable(RuntimeError):
    status_code = 503


def is_hosted(env: Mapping[str, str] | None = None) -> bool:
    values = os.environ if env is None else env
    return values.get("NODE_ENV") == "production" and values.get("ENSEMBLE_DESKTOP") != "1"


def resolve_user(user_id: str | None):
    if not user_id:
        raise HostedAccessError("A signed-in account is required to use hosted resources.")
    from ensemble_agent.credentials import _connect

    try:
        with _connect() as conn:
            row = conn.execute("select email, email_verified_at from users where id = %s", (user_id,)).fetchone()
    except Exception as exc:
        logging.getLogger("ensemble.credentials").error("hosted account lookup failed: %s", type(exc).__name__)
        raise HostedAccessUnavailable("Hosted account verification is temporarily unavailable.") from exc
    if not row:
        raise HostedAccessError("A signed-in account is required to use hosted resources.")
    return row


def is_operator_email(email: str) -> bool:
    return email in {value.strip() for value in os.environ.get("ENSEMBLE_OPERATOR_EMAILS", "").split(",") if value.strip()}


def require_verified_user(user_id: str | None) -> None:
    if is_hosted() and not resolve_user(user_id)[1]:
        raise HostedAccessError("Verify your email before using hosted resources.")


def require_host_access(user_id: str | None, feature: str) -> None:
    if not is_hosted():
        return
    email, verified = resolve_user(user_id)
    if not verified:
        raise HostedAccessError("Verify your email before using hosted resources.")
    if not is_operator_email(email):
        raise HostedAccessError(f"{feature} is available only to the hosted Ensemble operator. Use a paired computer for local execution.")


def can_use_host_credentials(user_id: str | None) -> bool:
    if not is_hosted():
        return True
    if not user_id:
        return False
    email, verified = resolve_user(user_id)
    return bool(verified) and is_operator_email(email)
