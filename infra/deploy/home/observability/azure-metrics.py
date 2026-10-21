#!/usr/bin/env python3
"""Azure cost and blob storage for the operator's dashboards (docs/07 §1.3).

Run by ensemble-azure-metrics.timer every 6 hours with the machine user's `az login`. Writes
Prometheus text to $ENSEMBLE_OBS_DIR/textfile/azure.prom, which node-exporter serves:

  ensemble_azure_cost{subscription,service,currency,period="month_to_date|previous_month"}
  ensemble_azure_cost_month_estimate{subscription,currency}   month to date, projected to month end
  ensemble_blob_objects{container,prefix} / ensemble_blob_bytes{container,prefix}
  ensemble_azure_metrics_success{part="cost|blob"} and ..._last_run_timestamp_seconds

Cost Management allows only a few queries a minute: each subscription is asked once per run, and a
429 waits and tries again. The storage connection string comes from AZURE_STORAGE_CONNECTION_STRING
in the environment (the app's env file); it is never put on a command line.
"""
from __future__ import annotations

import calendar
import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(os.environ.get("ENSEMBLE_OBS_DIR", str(Path.home() / "ensemble-host/observability"))) / "textfile" / "azure.prom"
CONTAINERS = [c for c in os.environ.get("ENSEMBLE_BLOB_CONTAINERS", "ensemble-files,ensemble-backups").split(",") if c]


def az(args: list[str], timeout: int = 120) -> object:
    result = subprocess.run(["az", *args, "--only-show-errors", "-o", "json"], capture_output=True, text=True, timeout=timeout, env=os.environ)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else f"az exited {result.returncode}")
    return json.loads(result.stdout or "null")


def label(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def cost_query(subscription: str, start: str, end: str) -> list[list[object]]:
    body = {
        "type": "ActualCost",
        "timeframe": "Custom",
        "timePeriod": {"from": start, "to": end},
        "dataset": {"granularity": "None", "aggregation": {"totalCost": {"name": "Cost", "function": "Sum"}}, "grouping": [{"type": "Dimension", "name": "ServiceName"}]},
    }
    url = f"https://management.azure.com/subscriptions/{subscription}/providers/Microsoft.CostManagement/query?api-version=2023-11-01"
    for attempt in range(5):
        try:
            result = az(["rest", "--method", "post", "--url", url, "--body", json.dumps(body)])
            return result["properties"]["rows"]  # type: ignore[index]
        except RuntimeError as error:
            if "429" not in str(error) and "Too Many Requests" not in str(error):
                raise
            time.sleep(30 * (attempt + 1))
    raise RuntimeError("Cost Management kept answering 429")


def collect_cost(lines: list[str]) -> bool:
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    previous_end = month_start
    previous_start = (month_start - timedelta(days=1)).replace(day=1)
    days_in_month = calendar.monthrange(now.year, now.month)[1]
    elapsed_days = max((now - month_start).total_seconds() / 86400, 1 / 24)
    ok = True
    subscriptions = az(["account", "list", "--query", "[?state=='Enabled'].{id:id,name:name}"])
    for sub in subscriptions:  # type: ignore[union-attr]
        name = label(sub["name"])
        for period, start, end in (("month_to_date", month_start, now), ("previous_month", previous_start, previous_end)):
            try:
                rows = cost_query(sub["id"], start.strftime("%Y-%m-%dT%H:%M:%SZ"), end.strftime("%Y-%m-%dT%H:%M:%SZ"))
            except Exception as error:  # noqa: BLE001 - one subscription failing must not hide the others
                print(f"cost {sub['name']} {period}: {error}", file=sys.stderr)
                ok = False
                continue
            totals: dict[str, float] = defaultdict(float)
            for cost, service, currency in rows:
                lines.append(f'ensemble_azure_cost{{subscription="{name}",service="{label(str(service))}",currency="{label(str(currency))}",period="{period}"}} {float(cost):.6f}')
                totals[str(currency)] += float(cost)
            if period == "month_to_date":
                for currency, total in (totals or {"INR": 0.0}).items():
                    lines.append(f'ensemble_azure_cost_month_estimate{{subscription="{name}",currency="{label(currency)}"}} {total / elapsed_days * days_in_month:.6f}')
            time.sleep(20)
    return ok


def collect_blobs(lines: list[str]) -> bool:
    if not os.environ.get("AZURE_STORAGE_CONNECTION_STRING"):
        print("AZURE_STORAGE_CONNECTION_STRING is not set; blob storage skipped", file=sys.stderr)
        return False
    ok = True
    for container in CONTAINERS:
        try:
            blobs = az(["storage", "blob", "list", "--container-name", container, "--num-results", "*", "--query", "[].{n:name,s:properties.contentLength}"], timeout=600)
        except Exception as error:  # noqa: BLE001
            print(f"blob {container}: {error}", file=sys.stderr)
            ok = False
            continue
        counts: dict[str, int] = defaultdict(int)
        sizes: dict[str, int] = defaultdict(int)
        for blob in blobs or []:  # type: ignore[union-attr]
            prefix = blob["n"].split("/", 1)[0] if "/" in blob["n"] else "(root)"
            counts[prefix] += 1
            sizes[prefix] += int(blob["s"] or 0)
        for prefix in sorted(set(counts) | {"(total)"}):
            count = sum(counts.values()) if prefix == "(total)" else counts[prefix]
            size = sum(sizes.values()) if prefix == "(total)" else sizes[prefix]
            lines.append(f'ensemble_blob_objects{{container="{label(container)}",prefix="{label(prefix)}"}} {count}')
            lines.append(f'ensemble_blob_bytes{{container="{label(container)}",prefix="{label(prefix)}"}} {size}')
    return ok


def main() -> int:
    lines: list[str] = []
    blob_ok = collect_blobs(lines)
    cost_ok = collect_cost(lines)
    lines.append(f'ensemble_azure_metrics_success{{part="blob"}} {int(blob_ok)}')
    lines.append(f'ensemble_azure_metrics_success{{part="cost"}} {int(cost_ok)}')
    lines.append(f"ensemble_azure_metrics_last_run_timestamp_seconds {int(time.time())}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    temp = OUT.with_suffix(".tmp")
    temp.write_text("\n".join(lines) + "\n")
    temp.replace(OUT)
    print(f"wrote {len(lines)} lines to {OUT}")
    return 0 if blob_ok and cost_ok else 1


if __name__ == "__main__":
    sys.exit(main())
