"""Production boot checks for agent-runtime.

The token and auth-bypass rules match hub-api's src/lib/production.ts.
Dev (NODE_ENV other than production) is not checked.
"""

from __future__ import annotations

DEFAULT_INTERNAL_TOKEN = "dev-internal-token"

EXAMPLE_INTERNAL_TOKENS = frozenset(
    {
        "dev-internal-token",
        "change-me",
        "changeme",
        "change_me",
        "replace-me",
        "replaceme",
        "replace_me",
        "example",
        "example-token",
        "example-internal-token",
        "your-internal-token",
        "your-token-here",
        "todo",
        "secret",
        "password",
    }
)

NAMED_BYPASS = (
    "ENSEMBLE_DEV_AUTH_BYPASS",
    "ENSEMBLE_DEV_LOGIN",
    "ENSEMBLE_AUTH_BYPASS",
    "ENSEMBLE_DISABLE_AUTH",
    "ENSEMBLE_SKIP_AUTH",
    "ENSEMBLE_BRIDGE_ALLOW_DEFAULT_INTERNAL_TOKEN",
)

_TRUTHY = frozenset({"1", "true", "yes", "on"})


def _truthy(value: str | None) -> bool:
    if not value:
        return False
    return value.strip().lower() in _TRUTHY


def _bypass_name(name: str) -> bool:
    lowered = name.lower()
    for marker in ("auth_bypass", "dev_login", "disable_auth", "skip_auth"):
        if lowered == marker or lowered.endswith("_" + marker) or f"_{marker}_" in lowered:
            return True
    return False


def is_insecure_internal_token(value: str | None) -> bool:
    token = (value or "").strip().lower()
    if not token:
        return True
    return token in EXAMPLE_INTERNAL_TOKENS


def production_problems(env: dict[str, str]) -> list[str]:
    if env.get("NODE_ENV") != "production":
        return []
    problems: list[str] = []
    raw = (env.get("ENSEMBLE_INTERNAL_TOKEN") or "").strip()
    if is_insecure_internal_token(raw):
        shown = raw or DEFAULT_INTERNAL_TOKEN
        kind = "default" if not raw or shown.lower() == DEFAULT_INTERNAL_TOKEN else "example"
        problems.append(
            f'ENSEMBLE_INTERNAL_TOKEN is the {kind} value "{shown}". '
            "Set a private value (openssl rand -hex 32) before starting in production."
        )
    names = [name for name in NAMED_BYPASS if _truthy(env.get(name))]
    for name, value in env.items():
        if name not in names and _bypass_name(name) and _truthy(value):
            names.append(name)
    for name in names:
        problems.append(f"{name} is on. Turn it off before starting in production.")
    return problems


def format_production_problems(problems: list[str]) -> str:
    lines = ["Refusing to start in production:", *[f"- {line}" for line in problems]]
    return "\n".join(lines)
