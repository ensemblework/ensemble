import asyncio
from datetime import datetime, timezone
from contextlib import contextmanager

import pytest

from ensemble_agent import credentials, hosted_access, models
from ensemble_agent.plots.sandbox import run_plot


@pytest.fixture
def hosted(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("ENSEMBLE_DESKTOP", "0")
    monkeypatch.setenv("ENSEMBLE_OPERATOR_EMAILS", "operator@example.test, second@example.test")
    monkeypatch.setenv("OPENAI_API_KEY", "host-only-key")
    monkeypatch.setenv("GITHUB_TOKEN", "host-only-gh")
    users = {
        "operator": ("operator@example.test", datetime.now(timezone.utc)),
        "member": ("member@example.test", datetime.now(timezone.utc)),
        "unverified": ("operator@example.test", None),
    }

    def user(user_id):
        if user_id not in users:
            raise hosted_access.HostedAccessError("Account required")
        return users[user_id]

    monkeypatch.setattr(hosted_access, "resolve_user", user)
    monkeypatch.setattr(credentials, "stored_map", lambda user_id: {"openai": ("byok-key", None)} if user_id == "member" else {})
    monkeypatch.setattr(credentials, "_broken", lambda user_id: set())
    monkeypatch.setattr(credentials, "_gh_token", lambda: pytest.fail("nonoperator must not run gh"))
    return users


def test_exact_operator_allowlist(hosted):
    assert hosted_access.is_operator_email("operator@example.test")
    for email in ("Operator@example.test", "example.test", "operator@example.test.evil"):
        assert not hosted_access.is_operator_email(email)


def test_only_verified_operator_can_use_host_credentials(hosted):
    assert credentials.resolve("operator", "openai").source == "env"
    assert credentials.resolve("member", "openai").secret == "byok-key"
    assert credentials.resolve("member", "copilot").source == "none"
    assert not hosted_access.can_use_host_credentials(None)
    for user_id in (None, "unknown", "unverified"):
        with pytest.raises(hosted_access.HostedAccessError):
            credentials.resolve(user_id, "openai")


def test_listing_hides_fallback_key_names(hosted, monkeypatch):
    class Connection:
        def execute(self, *args):
            return self

        def fetchall(self):
            return []

    @contextmanager
    def connect():
        yield Connection()

    monkeypatch.setattr(credentials, "_connect", connect)
    assert all(row["source"] == "none" and row["hint"] is None for row in credentials.listing("member"))
    assert next(row for row in credentials.listing("operator") if row["provider"] == "openai")["source"] == "env"


def test_user_resolution_database_failure_is_not_a_missing_key(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("ENSEMBLE_DESKTOP", "0")

    def failed():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(credentials, "_connect", failed)
    with pytest.raises(hosted_access.HostedAccessUnavailable, match="temporarily unavailable"):
        hosted_access.can_use_host_credentials("operator")
    with pytest.raises(hosted_access.HostedAccessUnavailable, match="temporarily unavailable"):
        hosted_access.require_verified_user("member")


def test_local_ollama_proxy_and_python_are_denied_before_execution(hosted, monkeypatch):
    with pytest.raises(hosted_access.HostedAccessError):
        asyncio.run(models._endpoint("ollama", "member", "http://127.0.0.1:11434"))
    with pytest.raises(hosted_access.HostedAccessError):
        asyncio.run(models.list_models("ollama", "member", "http://127.0.0.1:11434", secret="own"))
    monkeypatch.setattr(credentials, "stored_map", lambda _: {"openai": ("byok", "http://localhost:4000")})
    with pytest.raises(hosted_access.HostedAccessError):
        credentials.resolve("member", "openai")
    with pytest.raises(hosted_access.HostedAccessError):
        run_plot("print('unsafe')", [], user_id="member")
    with pytest.raises(hosted_access.HostedAccessError):
        run_plot("print('unsafe')", [])


def test_dev_and_desktop_preserve_local_behavior(hosted, monkeypatch):
    monkeypatch.setattr(hosted_access, "resolve_user", lambda _: pytest.fail("must not query local account"))
    for env in ({"NODE_ENV": "development", "ENSEMBLE_DESKTOP": "0"}, {"NODE_ENV": "production", "ENSEMBLE_DESKTOP": "1"}):
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        assert not hosted_access.is_hosted()
        hosted_access.require_verified_user(None)
        hosted_access.require_host_access(None, "Python")
        assert hosted_access.can_use_host_credentials(None)


def test_http_denials_are_403_before_model_or_plot_work(hosted, monkeypatch):
    from fastapi.testclient import TestClient
    from ensemble_agent.main import app

    token = "hosted-safety-test-internal-token"
    monkeypatch.setenv("ENSEMBLE_INTERNAL_TOKEN", token)
    client = TestClient(app)
    headers = {"x-ensemble-internal": token}
    for path, body in (
        ("/api/complete", {"userId": "unverified", "provider": "mock", "model": "mock", "prompt": "test"}),
        ("/api/chat/tools", {"userId": "unverified", "provider": "mock", "model": "mock", "messages": []}),
        ("/api/chat/tools/stream", {"userId": "unverified", "provider": "mock", "model": "mock", "messages": []}),
        ("/api/plots/run", {"userId": "member", "code": "print('no')", "datasets": []}),
        ("/api/plots/parse", {"userId": "member", "filename": "table.xlsx", "contentBase64": ""}),
    ):
        response = client.post(path, json=body, headers=headers)
        assert response.status_code == 403, response.text
        assert "detail" in response.json()
    client.close()
