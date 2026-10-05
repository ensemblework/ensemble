from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv() -> None:
    """Read the repo .env without overriding the real environment."""
    root = Path(__file__).resolve().parents[3]
    for candidate in (root / ".env", Path.cwd() / ".env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip().removeprefix("export ").strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


_load_dotenv()


@dataclass(frozen=True)
class Settings:
    database_url: str
    hub_api: str
    tenant_domains: frozenset[str]
    copilot_api_key: str | None
    github_token: str | None
    openai_api_key: str | None
    llm_provider: str
    internal_token: str
    daily_high_risk_limit: int
    plot_python: str | None
    plot_concurrency: int

    @property
    def psycopg_dsn(self) -> str:
        return self.database_url


def get_settings() -> Settings:
    raw_domains = os.environ.get("ENSEMBLE_TENANT_DOMAINS", "ensemble.local")
    return Settings(
        database_url=os.environ.get("DATABASE_URL", "postgresql://ensemble:ensemble@localhost:5432/ensemble"),
        hub_api=os.environ.get("HUB_API_URL", "http://127.0.0.1:4000"),
        tenant_domains=frozenset(part.strip() for part in raw_domains.split(",") if part.strip()),
        copilot_api_key=os.environ.get("COPILOT_API_KEY"),
        github_token=os.environ.get("GITHUB_TOKEN"),
        openai_api_key=os.environ.get("OPENAI_API_KEY"),
        llm_provider=os.environ.get("ENSEMBLE_LLM_PROVIDER", "google"),
        internal_token=os.environ.get("ENSEMBLE_INTERNAL_TOKEN", "dev-internal-token"),
        daily_high_risk_limit=int(os.environ.get("ENSEMBLE_DAILY_HIGH_RISK_LIMIT", "20")),
        plot_python=(os.environ.get("ENSEMBLE_PYTHON") or "").strip() or None,
        plot_concurrency=_plot_concurrency(),
    )


def _plot_concurrency() -> int:
    raw = (os.environ.get("ENSEMBLE_PLOT_CONCURRENCY") or "2").strip() or "2"
    try:
        value = int(raw)
    except ValueError:
        return 2
    return min(32, max(1, value))
