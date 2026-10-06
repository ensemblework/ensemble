from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import NoReturn

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

from ensemble_agent import credentials
from ensemble_agent.hosted_access import HostedAccessError, HostedAccessUnavailable, require_host_access, require_verified_user
from ensemble_agent.config import get_settings
from ensemble_agent.production import format_production_problems, production_problems
from ensemble_agent.redact import install_secret_redaction
from ensemble_agent.models import (
    CONNECTION_DROPPED_NOTICE,
    ConnectionDropped,
    ModelAuthError,
    catalog,
    clear_catalog_cache,
    complete_text,
    complete_with_tools,
    list_models,
    stream_with_tools,
)
from ensemble_agent.reach import ModelUnreachable
from ensemble_agent.provider_error import ProviderError, friendly_key_error
from ensemble_agent.search import grounded_search

install_secret_redaction()


def refuse_unsafe_production() -> None:
    """Exit before serving when production is using a dev credential or bypass."""
    problems = production_problems(dict(os.environ))
    if not problems:
        return
    message = format_production_problems(problems)
    print(message, file=sys.stderr)
    raise RuntimeError(message)


def _warm_plots() -> None:
    try:
        from ensemble_agent.plots.sandbox import prewarm

        prewarm()
    except Exception:
        # A missing matplotlib install must not take the rest of the runtime down.
        return


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    refuse_unsafe_production()
    import threading

    threading.Thread(target=_warm_plots, name="plots-prewarm", daemon=True).start()
    yield


app = FastAPI(title="ensemble-agent-runtime", lifespan=_lifespan)

@app.exception_handler(HostedAccessError)
async def hosted_access_failure(_request, exc: HostedAccessError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=403)

@app.exception_handler(HostedAccessUnavailable)
async def hosted_access_unavailable(_request, exc: HostedAccessUnavailable) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=503)


def _guard(token: str | None) -> None:
    if token != get_settings().internal_token:
        raise HTTPException(status_code=401, detail="Missing or wrong x-ensemble-internal token.")


def http_error_for(exc: Exception) -> HTTPException:
    """Map a model failure onto a JSON-serializable HTTPException."""
    if isinstance(exc, HostedAccessError):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, HostedAccessUnavailable):
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, ModelUnreachable):
        return HTTPException(status_code=503, detail=exc.to_dict())
    if isinstance(exc, ConnectionDropped):
        return HTTPException(status_code=503, detail=CONNECTION_DROPPED_NOTICE)
    if isinstance(exc, ProviderError):
        status = exc.status if exc.status in (429, 503, 400, 404) else 502
        return HTTPException(
            status_code=status,
            detail={
                "message": exc.message,
                "kind": exc.kind,
                "retryAfterSeconds": exc.retry_after_seconds,
                "quotaId": exc.quota_id,
            },
        )
    if isinstance(exc, credentials.DecryptError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, ModelAuthError):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=502, detail=str(exc)[:500])


def _fail(exc: Exception) -> NoReturn:
    raise http_error_for(exc) from exc


@app.get("/health")
def health() -> dict[str, bool | str]:
    return {"ok": True, "service": "agent-runtime"}


@app.post("/api/chat/tools")
async def chat_tools(body: dict, x_ensemble_internal: str | None = Header(default=None)) -> JSONResponse:
    """One model turn. Nothing more — hub-api owns the tool loop (docs/11)."""
    _guard(x_ensemble_internal)
    try:
        result = await complete_with_tools(body)
    except Exception as exc:
        _fail(exc)
    return JSONResponse(result)


@app.post("/api/chat/tools/stream")
async def chat_tools_stream(body: dict, x_ensemble_internal: str | None = Header(default=None)) -> StreamingResponse:
    """Text deltas, then one turn event. Failures before any byte are an error event."""
    _guard(x_ensemble_internal)
    require_verified_user(body.get("userId"))
    return StreamingResponse(
        stream_with_tools(body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )


@app.post("/api/search")
async def search(body: dict, x_ensemble_internal: str | None = Header(default=None)) -> dict:
    """Provider-native grounding. An empty list means the Hub should use its fallback search."""
    _guard(x_ensemble_internal)
    require_verified_user(body.get("userId"))
    try:
        results = await grounded_search(
            body.get("userId"),
            str(body.get("provider") or "google"),
            str(body.get("model") or "gemini-3.5-flash-lite"),
            str(body.get("query") or ""),
        )
    except Exception as exc:
        logging.getLogger("ensemble.search").warning("search unavailable: %s", exc)
        return {"results": [], "error": "search unavailable"}
    return {"results": results}


@app.post("/api/complete")
async def complete(body: dict, x_ensemble_internal: str | None = Header(default=None)) -> JSONResponse:
    _guard(x_ensemble_internal)
    try:
        result = await complete_text(body)
    except Exception as exc:
        _fail(exc)
    return JSONResponse(result)


@app.get("/api/models")
async def models(userId: str | None = None, ollamaUrl: str | None = None, x_ensemble_internal: str | None = Header(default=None)) -> dict:
    _guard(x_ensemble_internal)
    return {"providers": await catalog(userId, ollamaUrl)}


@app.get("/api/credentials")
def list_credentials(userId: str, x_ensemble_internal: str | None = Header(default=None)) -> dict:
    _guard(x_ensemble_internal)
    return {"credentials": credentials.listing(userId)}


@app.put("/api/credentials")
async def put_credential(body: dict, x_ensemble_internal: str | None = Header(default=None)) -> dict:
    _guard(x_ensemble_internal)
    require_verified_user(body.get("userId"))
    if body.get("baseUrl"):
        require_host_access(body.get("userId"), "Custom model proxies")
    provider = str(body.get("provider") or "")
    secret = str(body.get("apiKey") or "").strip()
    if provider not in credentials.PROVIDERS or provider == "ollama":
        raise HTTPException(status_code=400, detail="Unknown provider.")
    if not secret:
        raise HTTPException(status_code=400, detail="Paste a key first.")
    try:
        found = await list_models(provider, body.get("userId"), secret=secret)
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code if exc.response is not None else 0
        body_text = ""
        if exc.response is not None:
            try:
                body_text = exc.response.text
            except Exception:
                body_text = ""
        raise HTTPException(status_code=400, detail=friendly_key_error(provider, status, body_text)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=400, detail=friendly_key_error(provider, 0, "")) from exc
    except Exception as exc:
        message = str(exc)
        if "://" in message:
            message = friendly_key_error(provider, 0, "")
        raise HTTPException(status_code=400, detail=message[:200]) from exc
    credentials.save(str(body["userId"]), provider, secret, body.get("baseUrl"))
    clear_catalog_cache()
    return {"ok": True, "models": len(found)}


@app.delete("/api/credentials/{provider}")
def delete_credential(provider: str, userId: str, x_ensemble_internal: str | None = Header(default=None)) -> dict:
    _guard(x_ensemble_internal)
    credentials.remove(userId, provider)
    clear_catalog_cache()
    return {"ok": True}


@app.post("/api/plots/parse")
def plots_parse(body: dict, x_ensemble_internal: str | None = Header(default=None)) -> dict:
    """Read a spreadsheet or columnar file. Pickle is refused. No network."""
    _guard(x_ensemble_internal)
    require_host_access(body.get("userId"), "Python table parsing")
    import base64

    from ensemble_agent.plots.parse_table import parse_table

    raw = str(body.get("contentBase64") or "")
    try:
        data = base64.b64decode(raw)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="The file was not valid base64.") from exc
    if len(data) > 32 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="That file is larger than 32 MB.")
    try:
        return parse_table(str(body.get("filename") or "table"), data, str(body.get("sheet") or ""))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read that file. {exc}"[:300]) from exc


@app.post("/api/plots/run")
def plots_run(body: dict, x_ensemble_internal: str | None = Header(default=None)) -> StreamingResponse:
    """Run matplotlib in the plot sandbox. The child has no network.

    Newline-delimited JSON. ``{"started": true}`` is sent when the child
    begins, and the result follows. Time spent queued is not the run clock.
    """
    _guard(x_ensemble_internal)
    require_host_access(body.get("userId"), "Python plots")
    import json
    import queue
    import threading

    from ensemble_agent.plots.sandbox import run_plot

    code = str(body.get("code") or "")
    if len(code) > 100_000:
        raise HTTPException(status_code=400, detail="That script is too long.")
    datasets = body.get("datasets") if isinstance(body.get("datasets"), list) else []
    fmt = str(body.get("format") or "all")
    if fmt not in {"png", "svg", "pdf", "eps", "all"}:
        fmt = "all"
    dpi = body.get("dpi")

    events: queue.Queue[dict] = queue.Queue()

    def on_started() -> None:
        events.put({"started": True})

    def work() -> None:
        try:
            events.put({"result": run_plot(code, datasets, fmt=fmt, dpi=int(dpi) if isinstance(dpi, (int, float)) else None, on_started=on_started, user_id=body.get("userId"))})
        except Exception as exc:
            events.put({"error": str(exc)})

    threading.Thread(target=work, daemon=True).start()

    def generate():
        while True:
            item = events.get()
            if item.get("started") is True and "result" not in item and "error" not in item:
                yield json.dumps({"started": True}) + "\n"
                continue
            if "error" in item:
                detail = f"The plot runtime could not draw that figure. {item['error']}"[:300]
                yield json.dumps({"error": detail, "stdout": "", "stderr": "", "line": None, "retry": True}) + "\n"
                return
            yield json.dumps(item.get("result") or {}) + "\n"
            return

    return StreamingResponse(generate(), media_type="application/x-ndjson")


def main() -> None:
    import uvicorn

    try:
        refuse_unsafe_production()
    except RuntimeError:
        raise SystemExit(1) from None
    # 5000 is taken by AirPlay Receiver on macOS. Bound to loopback: hub-api is the only caller.
    port = int(os.environ.get("AGENT_RUNTIME_PORT", "5055"))
    # Watch only the package. The default is the working directory, which holds .venv, so the
    # stat reloader (used when watchfiles is not installed) polls thousands of files and keeps a core busy.
    package = os.path.dirname(os.path.abspath(__file__))
    uvicorn.run("ensemble_agent.main:app", host="127.0.0.1", port=port, reload=True, reload_dirs=[package])


if __name__ == "__main__":
    main()
