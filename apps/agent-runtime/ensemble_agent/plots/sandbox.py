"""Run a short matplotlib script with no network and no access outside a temp dir.

The drawing happens in one long-lived interpreter (`worker.py`). Hosted hub-api
calls `run_plot` here. The desktop sidecar spawns that same file itself, because
a packaged app does not ship this package.

See plot_mode() for how the hosted runtime and the desktop app differ.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import uuid
from collections.abc import Callable
from pathlib import Path

# Through the spawn choke point (a Node start per worker), after the font cache exists.
TIMEOUT_S = 25
COLD_TIMEOUT_S = 45
# Hosted warm worker, after the font cache exists.
WARM_TIMEOUT_S = 20
# Extra seconds to notice that a queued export has started.
QUEUE_SLACK_S = 5
# Total queue wait, including slack. Vercel and Caddy cut hosted requests at
# 120s, and Node fetch gives up on a silent body at 300s. Stay under both.
QUEUE_WAIT_CAP_S = 110
PLOT_EXPORTS_BUSY = "Plot exports are busy. Try again."

_WORKER_ENV_KEEP = (
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT",
    "PYTHONPATH", "PYTHONHOME", "PYTHONNOUSERSITE",
)


class PlotRuntimeUnavailable(RuntimeError):
    """python3 is missing, or matplotlib is not installed for that interpreter."""


class PlotExportsBusy(Exception):
    """The export was still queued when its queue budget ran out."""


def queue_start_delay(limits: list[float], cap: int) -> float:
    """Seconds until one more export can start.

    `limits` are the exports already ahead, oldest first, each at the limit it
    was actually given (the long first-run limit when the worker is fresh or
    was just restarted). Slots follow the concurrency cap: a new export starts
    when the earliest slot is free after those jobs have been placed.
    """
    if not limits:
        return 0.0
    slots = [0.0] * max(1, cap)
    for limit in limits:
        earliest = min(range(len(slots)), key=lambda index: slots[index])
        slots[earliest] += limit
    return min(slots)


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "pnpm-workspace.yaml").is_file() and (parent / "apps" / "hub-api").is_dir():
            return parent
    raise RuntimeError("Plot sandbox could not find the Ensemble checkout (pnpm-workspace.yaml).")


def _worker_file() -> Path:
    return Path(__file__).resolve().with_name("worker.py")


def _python_read_paths(python: str | None = None) -> list[str]:
    """Prefixes and site-packages of the interpreter that will draw the plot.

    Seatbelt denies $HOME unless a path is named. A user-site or a venv under
    the home directory has to be granted, or matplotlib looks missing.
    """
    chosen = python or plot_python()
    script = (
        "import json, os, site, sys\n"
        "raw = [sys.prefix, sys.base_prefix, sys.exec_prefix]\n"
        "raw.extend(p for p in sys.path if p)\n"
        "try:\n"
        "    raw.extend(site.getsitepackages())\n"
        "except Exception:\n"
        "    pass\n"
        "try:\n"
        "    user = site.getusersitepackages()\n"
        "    if isinstance(user, str):\n"
        "        raw.append(user)\n"
        "except Exception:\n"
        "    pass\n"
        "seen = []\n"
        "for item in raw:\n"
        "    path = os.path.realpath(item)\n"
        "    if path not in seen and os.path.isdir(path):\n"
        "        seen.append(path)\n"
        "print(json.dumps(seen))\n"
    )
    env = _worker_env()
    env["HOME"] = str(Path.home())
    try:
        completed = subprocess.run(
            [chosen, "-c", script],
            capture_output=True,
            text=True,
            timeout=10,
            env=env,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    try:
        parsed = json.loads(completed.stdout or "")
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]


def matplotlib_cache_dir() -> Path:
    """Per-user matplotlib config. Override with ENSEMBLE_MPLCONFIGDIR or MPLCONFIGDIR."""
    chosen = os.environ.get("ENSEMBLE_MPLCONFIGDIR") or os.environ.get("MPLCONFIGDIR")
    if chosen:
        path = Path(chosen)
    elif sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        path = Path(base) / "Ensemble" / "Cache" / "matplotlib"
    elif sys.platform == "darwin":
        path = Path.home() / "Library" / "Caches" / "Ensemble" / "matplotlib"
    else:
        base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
        path = Path(base) / "ensemble" / "matplotlib"
    path.mkdir(parents=True, exist_ok=True)
    return path


def plot_mode() -> str:
    """Which launcher a plot uses.

    "sandbox": macOS, and the desktop app (ENSEMBLE_DESKTOP=1). On macOS the warm
    worker is started through hub-api's spawn choke point (workspace/sandbox/cli.ts),
    which applies Seatbelt. Forked plots inherit it. Linux has no OS sandbox, so
    a desktop plot there uses the same in-process guards as hosted.

    "hosted": the Linux runtime. The worker is the interpreter itself.
    """
    if os.environ.get("ENSEMBLE_DESKTOP") == "1" or sys.platform == "darwin":
        return "sandbox"
    return "hosted"


def plot_python() -> str:
    """Interpreter for the warm worker. ENSEMBLE_PYTHON overrides the runtime's own."""
    override = (os.environ.get("ENSEMBLE_PYTHON") or "").strip()
    return override or sys.executable


def plot_concurrency() -> int:
    raw = (os.environ.get("ENSEMBLE_PLOT_CONCURRENCY") or "2").strip() or "2"
    try:
        value = int(raw)
    except ValueError:
        return 2
    return min(32, max(1, value))


def _tsx() -> Path:
    repo = _repo_root()
    candidates = [
        repo / "node_modules" / ".bin" / "tsx",
        repo / "apps" / "hub-api" / "node_modules" / ".bin" / "tsx",
    ]
    return next((path for path in candidates if path.is_file()), candidates[0])


def seatbelt_worker_argv(python: str, worker: str, root: str, read_only: list[str], read_write: list[str]) -> list[str]:
    """Argv that starts the warm worker under the macOS spawn choke point."""
    repo = _repo_root()
    cli = repo / "apps" / "hub-api" / "src" / "workspace" / "sandbox" / "cli.ts"
    command = [str(_tsx()), str(cli), "--worker", "--root", root, "--python", python, "--script", worker]
    for path in read_only:
        command.extend(["--read-only", path])
    for path in read_write:
        command.extend(["--read-write", path])
    return command


def worker_launch_args(mode: str | None = None) -> list[str]:
    """How this process starts the warm worker. Tests check the shape; they do not have to spawn it."""
    python = plot_python()
    worker = str(_worker_file())
    chosen = mode or plot_mode()
    if chosen == "sandbox" and sys.platform == "darwin":
        root = tempfile.mkdtemp(prefix="ensemble-plots-")
        return seatbelt_worker_argv(python, worker, root, _python_read_paths(python), [str(matplotlib_cache_dir())])
    return [python, worker]


def _worker_env() -> dict[str, str]:
    """Allow-list. Forked plots inherit this, so tokens and API keys stay out."""
    env = {key: os.environ[key] for key in _WORKER_ENV_KEEP if os.environ.get(key)}
    env.update({
        "MPLCONFIGDIR": str(matplotlib_cache_dir()),
        "MPLBACKEND": "Agg",
        "PYTHONDONTWRITEBYTECODE": "1",
        "ENSEMBLE_PLOT_CONCURRENCY": str(plot_concurrency()),
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "NUMEXPR_NUM_THREADS": "1",
        "VECLIB_MAXIMUM_THREADS": "1",
    })
    crash = os.environ.get("ENSEMBLE_PLOT_TEST_CRASH")
    if crash:
        env["ENSEMBLE_PLOT_TEST_CRASH"] = crash
    env.setdefault("LANG", "C.UTF-8")
    return env


class _Pending:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.done = threading.Event()
        self.box: dict = {}
        self.on_started: Callable[[], None] | None = None
        self.announced = False
        self.timeout = 0.0


class _PlotClient:
    """Speaks the worker protocol. Threads live here, never in the forking parent."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen[str] | None = None
        self.pending: dict[str, _Pending] = {}
        self.lock = threading.Lock()
        self.generation = 0
        self.python = ""
        self.concurrency = 0
        self.crash = ""
        self.gate = threading.Lock()

    def submit(self, job: dict, timeout: float, on_started: Callable[[], None] | None = None) -> dict:
        self._ensure()
        pending = _Pending()
        pending.on_started = on_started
        pending.timeout = timeout
        job_id = str(job["id"])
        with self.lock:
            proc = self.proc
            if proc is None or proc.poll() is not None or not proc.stdin:
                raise RuntimeError("plot worker stopped")
            ahead_limits = [item.timeout for item in self.pending.values()]
            cap = max(1, self.concurrency)
            self.pending[job_id] = pending
            proc.stdin.write(json.dumps(job) + "\n")
            proc.stdin.flush()
        # Queue time is not this plot's clock. Budget each export ahead at the
        # limit it is running under, not at this export's own (often shorter) limit.
        # The cap is the longest we will wait: past it the proxy has already
        # dropped the request, so the waiter gets the busy error instead.
        allowance = min(queue_start_delay(ahead_limits, cap) + QUEUE_SLACK_S, QUEUE_WAIT_CAP_S)
        if not pending.done.is_set() and not pending.started.wait(allowance):
            self._cancel(job_id)
            with self.lock:
                self.pending.pop(job_id, None)
            raise PlotExportsBusy(PLOT_EXPORTS_BUSY)
        if not pending.done.wait(timeout + 5):
            # The worker's own deadline kills this child. Cancel is the backstop, and it does not kill the parent.
            self._cancel(job_id)
            if not pending.done.wait(3):
                with self.lock:
                    self.pending.pop(job_id, None)
                raise TimeoutError("plot worker timed out")
        if pending.box.get("dead"):
            raise RuntimeError(str(pending.box.get("error") or "plot worker stopped"))
        result = pending.box.get("result")
        if not isinstance(result, dict):
            raise RuntimeError("plot worker stopped")
        return result

    def _cancel(self, job_id: str) -> None:
        with self.lock:
            proc = self.proc
            if proc is None or proc.poll() is not None or not proc.stdin:
                return
            proc.stdin.write(json.dumps({"id": job_id, "cancel": True}) + "\n")
            proc.stdin.flush()

    def _ensure(self) -> None:
        # Held across startup so a second export cannot write a job before the ready line is consumed.
        with self.gate:
            self._ensure_locked()

    def _ensure_locked(self) -> None:
        python = plot_python()
        cap = plot_concurrency()
        crash = os.environ.get("ENSEMBLE_PLOT_TEST_CRASH") or ""
        with self.lock:
            alive = self.proc is not None and self.proc.poll() is None
            if alive and python == self.python and cap == self.concurrency and crash == self.crash:
                return
            self._stop_locked()
            self.proc = self._spawn(python)
            self.python = python
            self.concurrency = cap
            self.crash = crash
            generation = self.generation
            proc = self.proc
        ready = self._read_ready(proc, COLD_TIMEOUT_S)
        if not ready or not ready.get("ready"):
            missing = str((ready or {}).get("missing") or "")
            with self.lock:
                self._stop_locked()
            if missing in {"matplotlib", "python"} or not ready:
                raise PlotRuntimeUnavailable("The plot runtime is not available.")
            raise RuntimeError("The plot worker did not start.")
        threading.Thread(target=self._read_loop, args=(proc, generation), name="plot-worker-read", daemon=True).start()
        if proc.stderr is not None:
            threading.Thread(target=self._drain, args=(proc,), name="plot-worker-err", daemon=True).start()

    def _spawn(self, python: str) -> subprocess.Popen[str]:
        worker = str(_worker_file())
        env = _worker_env()
        if plot_mode() == "sandbox" and sys.platform == "darwin":
            root = tempfile.mkdtemp(prefix="ensemble-plots-")
            argv = seatbelt_worker_argv(python, worker, root, _python_read_paths(python), [str(matplotlib_cache_dir())])
        else:
            argv = [python, worker]
        try:
            return subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                text=True,
            )
        except OSError as exc:
            raise PlotRuntimeUnavailable("The plot runtime is not available.") from exc

    def _read_ready(self, proc: subprocess.Popen[str], timeout: float) -> dict | None:
        box: list[str] = []

        def read() -> None:
            if proc.stdout:
                box.append(proc.stdout.readline())

        thread = threading.Thread(target=read, daemon=True)
        thread.start()
        thread.join(timeout)
        if thread.is_alive():
            return None
        if not box or not box[0]:
            return None
        try:
            parsed = json.loads(box[0])
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None

    def _read_loop(self, proc: subprocess.Popen[str], generation: int) -> None:
        if not proc.stdout:
            return
        for raw in proc.stdout:
            text = raw.strip()
            if not text:
                continue
            try:
                message = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            job_id = str(message.get("id") or "")
            callback = None
            with self.lock:
                if generation != self.generation:
                    return
                pending = self.pending.get(job_id)
                if pending is None:
                    continue
                if message.get("started") is True and "stdout" not in message and "timeout" not in message and "error" not in message:
                    pending.started.set()
                    if not pending.announced:
                        pending.announced = True
                        callback = pending.on_started
                    finished = False
                else:
                    self.pending.pop(job_id, None)
                    finished = True
            if callback is not None:
                try:
                    callback()
                except Exception:
                    pass
            if not finished:
                continue
            pending.box["result"] = message
            pending.started.set()
            pending.done.set()
        with self.lock:
            if generation != self.generation:
                return
            leftover = list(self.pending.values())
            self.pending.clear()
        for pending in leftover:
            pending.box["dead"] = True
            pending.box["error"] = "plot worker stopped"
            pending.started.set()
            pending.done.set()

    def _drain(self, proc: subprocess.Popen[str]) -> None:
        if not proc.stderr:
            return
        for _line in proc.stderr:
            pass

    def _stop_locked(self) -> None:
        self.generation += 1
        proc = self.proc
        self.proc = None
        leftover = list(self.pending.values())
        self.pending.clear()
        if proc is not None and proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        for pending in leftover:
            pending.box["dead"] = True
            pending.box["error"] = "plot worker stopped"
            pending.started.set()
            pending.done.set()

    def _abandon(self) -> None:
        with self.lock:
            self._stop_locked()

    def shutdown(self) -> None:
        with self.lock:
            self._stop_locked()


_client = _PlotClient()
_warm = False


def reset_plot_worker() -> None:
    """Drop the warm interpreter. The next plot starts a new one."""
    global _warm
    _client.shutdown()
    _warm = False


def prewarm() -> None:
    """Import matplotlib once so the font cache exists before the first export."""
    _client._ensure()


def run_plot(
    code: str,
    datasets: list[dict],
    fmt: str = "all",
    dpi: int | None = None,
    on_started: Callable[[], None] | None = None,
) -> dict:
    global _warm
    warm_timeout = WARM_TIMEOUT_S if plot_mode() == "hosted" else TIMEOUT_S
    timeout = warm_timeout if _warm else COLD_TIMEOUT_S
    job = {
        "id": uuid.uuid4().hex,
        "code": code,
        "datasets": datasets,
        "format": fmt or "all",
        "dpi": dpi or 200,
        "timeout": timeout,
    }
    try:
        completed = _client.submit(job, timeout, on_started=on_started)
    except PlotRuntimeUnavailable:
        return {"error": "The plot runtime is not available.", "stdout": "", "stderr": "", "line": None, "retry": True}
    except PlotExportsBusy:
        return {"error": PLOT_EXPORTS_BUSY, "stdout": "", "stderr": "", "line": None, "retry": True}
    except TimeoutError:
        _warm = False
        return {"error": f"The script ran longer than {timeout} seconds. Try again.", "stdout": "", "stderr": "", "line": None, "retry": True}
    except Exception as exc:
        return {"error": f"The plot runtime could not draw that figure. {exc}"[:300], "stdout": "", "stderr": "", "line": None, "retry": True}
    if completed.get("timeout"):
        _warm = False
        return {
            "error": f"The script ran longer than {timeout} seconds. Try again.",
            "stdout": str(completed.get("stdout") or ""),
            "stderr": str(completed.get("stderr") or ""),
            "line": None,
            "retry": True,
        }
    _warm = True
    payload = {
        "stdout": completed.get("stdout") or "",
        "stderr": completed.get("stderr") or "",
        "png": completed.get("png"),
        "svg": completed.get("svg"),
        "pdf": completed.get("pdf"),
        "eps": completed.get("eps"),
        "line": completed.get("line"),
    }
    if completed.get("error"):
        payload["error"] = completed["error"]
    return payload
