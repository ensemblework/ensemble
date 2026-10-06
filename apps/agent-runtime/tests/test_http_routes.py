"""Production FastAPI routes with provider/database boundaries stubbed, never network calls."""

import json

import httpx
import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from ensemble_agent import main
from ensemble_agent.models import ConnectionDropped, ModelAuthError
from ensemble_agent.provider_error import ProviderError
from ensemble_agent.reach import ModelUnreachable


TOKEN = "http-runtime-test-token-not-for-production"
HEADERS = {"x-ensemble-internal": TOKEN}
ROUTES = [
    (method, route.path)
    for route in main.app.routes
    if isinstance(route, APIRoute) and route.path.startswith("/api/")
    for method in sorted(route.methods)
]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.setenv("ENSEMBLE_DESKTOP", "0")
    monkeypatch.setenv("ENSEMBLE_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setattr(main, "_warm_plots", lambda: None)

    async def forbid_network(*_args, **_kwargs):
        raise AssertionError("A route regression tried to call an external HTTP service")

    monkeypatch.setattr(httpx.AsyncClient, "send", forbid_network)
    with TestClient(main.app) as test_client:
        yield test_client


@pytest.mark.parametrize(("method", "path"), ROUTES)
@pytest.mark.parametrize("headers", [{}, {"x-ensemble-internal": "wrong-token"}])
def test_every_api_route_requires_the_internal_token(client, method, path, headers):
    response = client.request(
        method,
        path.replace("{provider}", "google"),
        params={"userId": "http-test-user"},
        headers=headers,
        **({"json": {}} if method in {"POST", "PUT"} else {}),
    )
    assert response.status_code == 401, response.text


@pytest.mark.parametrize(("method", "path"), [(method, path) for method, path in ROUTES if method in {"POST", "PUT"}])
@pytest.mark.parametrize("body", [None, "wrong-type"])
def test_object_body_schema_errors_are_422(client, method, path, body):
    response = client.request(method, path, headers=HEADERS, json=body)
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("path", ["/api/chat/tools", "/api/complete"])
@pytest.mark.parametrize(
    ("failure", "status"),
    [
        (ProviderError(429, "quota", "Wait", retry_after_seconds=12), 429),
        (ProviderError(503, "overloaded", "Busy"), 503),
        (ProviderError(400, "invalid_request", "Bad request"), 400),
        (ProviderError(404, "not_found", "Unknown model"), 404),
        (ProviderError(401, "auth", "Provider denied"), 502),
        (ConnectionDropped("closed"), 503),
        (ModelAuthError("Missing model key"), 503),
        (ModelUnreachable("Unreachable", provider="google", model="fixture", host="example.test", reason="dns"), 503),
        (RuntimeError("Unexpected provider error"), 502),
    ],
)
def test_provider_failures_have_a_client_visible_status(client, monkeypatch, path, failure, status):
    async def fail(_body):
        raise failure

    monkeypatch.setattr(main, "complete_with_tools", fail)
    monkeypatch.setattr(main, "complete_text", fail)
    response = client.post(path, headers=HEADERS, json={"userId": "http-test-user"})
    assert response.status_code == status, response.text
    assert response.json()["detail"]
    if isinstance(failure, ProviderError):
        assert response.json()["detail"]["kind"] == failure.kind
        assert response.json()["detail"]["retryAfterSeconds"] == failure.retry_after_seconds


def test_health_and_model_routes_preserve_response_shapes(client, monkeypatch):
    async def completion(_body):
        return {"text": "fixture", "toolCalls": [], "model": "fixture", "tokensIn": 2, "tokensOut": 1}

    async def catalog(_user_id, _ollama_url):
        return [{"id": "fixture", "models": []}]

    async def stream(_body):
        yield 'event: delta\ndata: {"text":"fixture"}\n\n'
        yield 'event: turn\ndata: {"text":"fixture","toolCalls":[]}\n\n'

    monkeypatch.setattr(main, "complete_with_tools", completion)
    monkeypatch.setattr(main, "complete_text", completion)
    monkeypatch.setattr(main, "catalog", catalog)
    monkeypatch.setattr(main, "stream_with_tools", stream)
    assert client.get("/health").json() == {"ok": True, "service": "agent-runtime"}
    for path in ["/api/chat/tools", "/api/complete"]:
        assert client.post(path, headers=HEADERS, json={}).json()["text"] == "fixture"
    assert client.get("/api/models", headers=HEADERS).json()["providers"][0]["id"] == "fixture"
    response = client.post("/api/chat/tools/stream", headers=HEADERS, json={})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "event: turn" in response.text


def test_credential_routes_use_validated_provider_input(client, monkeypatch):
    calls = []

    async def list_models(_provider, _user_id, *, secret):
        assert secret == "test-only-model-key"
        return ["fixture"]

    monkeypatch.setattr(main, "list_models", list_models)
    monkeypatch.setattr(main, "clear_catalog_cache", lambda: None)
    monkeypatch.setattr(main.credentials, "listing", lambda user_id: [{"provider": "google", "userId": user_id}])
    monkeypatch.setattr(main.credentials, "save", lambda *args: calls.append(args))
    monkeypatch.setattr(main.credentials, "remove", lambda *args: calls.append(args))
    assert client.get("/api/credentials", params={"userId": "user"}, headers=HEADERS).json()["credentials"][0]["userId"] == "user"
    valid = client.put("/api/credentials", headers=HEADERS, json={"userId": "user", "provider": "google", "apiKey": "test-only-model-key"})
    assert valid.status_code == 200, valid.text
    assert valid.json() == {"ok": True, "models": 1}
    for body in [{"provider": "unknown", "apiKey": "test-only-model-key"}, {"provider": "google", "apiKey": ""}]:
        response = client.put("/api/credentials", headers=HEADERS, json=body)
        assert response.status_code == 400, response.text
    assert client.delete("/api/credentials/google", params={"userId": "user"}, headers=HEADERS).status_code == 200
    assert len(calls) == 2


def test_search_and_plots_have_mocked_http_contracts(client, monkeypatch):
    from ensemble_agent.plots import parse_table, sandbox

    async def search(*_args):
        return [{"title": "Fixture", "url": "https://example.test"}]

    def draw(*_args, **kwargs):
        kwargs["on_started"]()
        return {"png": "fixture", "stdout": "", "stderr": ""}

    monkeypatch.setattr(main, "grounded_search", search)
    monkeypatch.setattr(parse_table, "parse_table", lambda *_args: {"columns": [], "rows": [], "rowCount": 0})
    monkeypatch.setattr(sandbox, "run_plot", draw)
    assert client.post("/api/search", headers=HEADERS, json={"query": "fixture"}).json()["results"][0]["title"] == "Fixture"
    assert client.post("/api/plots/parse", headers=HEADERS, json={"filename": "fixture.csv", "contentBase64": ""}).json()["rowCount"] == 0
    result = client.post("/api/plots/run", headers=HEADERS, json={"code": "pass"})
    assert result.status_code == 200, result.text
    events = [json.loads(line) for line in result.text.splitlines()]
    assert events[0] == {"started": True}
    assert events[-1]["png"] == "fixture"
