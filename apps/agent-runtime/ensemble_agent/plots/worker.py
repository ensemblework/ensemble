"""Long-lived matplotlib plot worker.

Source of truth for the desktop bundle. The sidecar ships this file at
apps/hub-api/src/runtime/py/plot_worker.py because a packaged app has no
apps/agent-runtime tree. Those two copies must stay byte-for-byte identical.

The parent imports matplotlib (Agg) and pandas once and forks a child per plot.
It starts no threads, so the fork stays safe. Windows has no fork and runs each
plot in a fresh interpreter. A forked child that dies from a fork-safety crash
is retried once in that fresh interpreter. A user error, a timeout, or a limit
hit is not retried.

Limits, set in the child only: 8s CPU, 2GB address space, 32MB file size.
"""

from __future__ import annotations

import json
import os
import select
import signal
import sys
import tempfile
import time
import traceback
from collections import deque
from pathlib import Path

# Before numpy. A thread pool started at import makes fork unsafe.
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")

MAX_OUTPUT = 16_000
CPU_SECONDS = 8
ADDRESS_BYTES = 2 * 1024 * 1024 * 1024
FILE_BYTES = 32 * 1024 * 1024

HELPER = '''
import json, os, sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
_DATA = json.loads((_ROOT / "datasets.json").read_text())

def load(name):
    import pandas as pd
    key = str(name)
    if key not in _DATA:
        known = ", ".join(sorted(_DATA)) or "(none)"
        raise KeyError(f"No dataset named {key!r}. Available: {known}")
    path = _ROOT / _DATA[key]
    return pd.read_json(path)

def apply_publication(preset="icml", font="Liberation Serif", family="serif"):
    import matplotlib as mpl
    mpl.rcParams.update({
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "font.family": family,
        "font.serif": [font, "Liberation Serif", "Nimbus Roman", "STIXGeneral", "DejaVu Serif"],
        "font.sans-serif": [font, "Liberation Sans", "DejaVu Sans"],
        "font.size": 9,
        "axes.labelsize": 9,
        "axes.titlesize": 10,
        "xtick.labelsize": 8,
        "ytick.labelsize": 8,
        "legend.fontsize": 8,
        "axes.linewidth": 0.6,
        "lines.linewidth": 1.25,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "grid.alpha": 0.25,
        "grid.linewidth": 0.4,
        "legend.frameon": False,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.04,
    })

def apply_style(font="Liberation Serif", family="serif", size=9):
    apply_publication("custom", font, family)
    import matplotlib as mpl
    mpl.rcParams["font.size"] = float(size)

def save(fig=None):
    import matplotlib.pyplot as plt
    if fig is None:
        fig = plt.gcf()
    out = _ROOT / "out"
    out.mkdir(exist_ok=True)
    kind = os.environ.get("PLOTS_FORMAT", "all") or "all"
    try:
        dpi = int(os.environ.get("PLOTS_DPI", "200") or "200")
    except ValueError:
        dpi = 200
    targets = ["pdf", "svg", "png", "eps"] if kind == "all" else [kind]
    for item in targets:
        if item == "png":
            fig.savefig(out / "figure.png", dpi=dpi)
        elif item in {"pdf", "svg", "eps"}:
            fig.savefig(out / f"figure.{item}")

import matplotlib.pyplot as plt
plt.show = lambda *args, **kwargs: save()
'''

_FORK_FAULTS = set()
for _name in ("SIGSEGV", "SIGBUS", "SIGABRT", "SIGILL"):
    _sig = getattr(signal, _name, None)
    if _sig is not None:
        _FORK_FAULTS.add(_sig)


def concurrency() -> int:
    """How many forked plots may run at once. Extra jobs wait."""
    raw = (os.environ.get("ENSEMBLE_PLOT_CONCURRENCY") or "2").strip() or "2"
    try:
        value = int(raw)
    except ValueError:
        return 2
    return min(32, max(1, value))


def _import_stack() -> str:
    import matplotlib

    matplotlib.use("Agg")
    import numpy  # noqa: F401
    import pandas  # noqa: F401
    import matplotlib.pyplot as plt

    try:
        import seaborn  # noqa: F401
    except Exception:
        pass
    try:
        import scipy  # noqa: F401
    except Exception:
        pass
    return str(matplotlib.get_backend())


def _warm_font_cache() -> None:
    cache = os.environ.get("MPLCONFIGDIR")
    if not cache:
        return
    os.makedirs(cache, exist_ok=True)
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1])
    fig.savefig(str(Path(cache) / "_warm.png"))
    plt.close(fig)


def _install_guards(root: Path) -> None:
    """Hosted in-process guards. Installed in the child, never in the parent."""
    blocked = {
        "socket", "subprocess", "ctypes", "multiprocessing", "pickle",
        "http", "ftplib", "smtplib", "telnetlib", "ssl",
        "requests", "httpx", "webbrowser", "pty", "importlib.metadata",
    }

    def blocked_import(fullname: str) -> bool:
        top = fullname.split(".")[0]
        if top in blocked or fullname in blocked:
            return True
        if fullname == "urllib.request" or fullname.startswith("urllib.request."):
            return True
        if fullname.startswith("urllib.response") or fullname.startswith("urllib.robotparser"):
            return True
        return False

    class Block:
        def find_spec(self, fullname, path, target=None):
            if blocked_import(fullname):
                raise ImportError(f"import of {fullname} is not allowed in the plot sandbox")
            return None

    import socket
    import subprocess as subprocess_mod

    def no(*_args, **_kwargs):
        raise OSError("network and process creation are disabled in the plot sandbox")

    socket.socket.connect = no  # type: ignore[method-assign]
    socket.socket.connect_ex = no  # type: ignore[method-assign]
    socket.create_connection = no  # type: ignore[assignment]
    socket.getaddrinfo = no  # type: ignore[assignment]
    subprocess_mod.Popen = no  # type: ignore[assignment]
    subprocess_mod.run = no  # type: ignore[assignment]
    subprocess_mod.call = no  # type: ignore[assignment]
    os.system = no  # type: ignore[assignment]
    os.popen = no  # type: ignore[assignment]

    prefixes = [str(root), os.path.realpath(sys.prefix), os.path.realpath(sys.base_prefix)]
    for entry in list(sys.path):
        if entry and os.path.isdir(entry):
            prefixes.append(os.path.realpath(entry))
    cache = os.environ.get("MPLCONFIGDIR")
    if cache:
        prefixes.append(os.path.realpath(cache))

    def allowed(path: str) -> bool:
        if not path or path.startswith("<"):
            return True
        real = os.path.realpath(path)
        if any(real == prefix or real.startswith(prefix + os.sep) for prefix in prefixes):
            return True
        lowered = real.replace("\\", "/").lower()
        if "/matplotlib" in lowered or lowered.endswith("/fonts") or "/fonts/" in lowered or "/share/font" in lowered:
            return True
        return False

    def audit(event, args):
        if event in {"socket.connect", "socket.getaddrinfo", "os.system", "subprocess.Popen", "os.exec", "os.posix_spawn"}:
            raise PermissionError("network and process creation are disabled in the plot sandbox")
        if event == "open":
            target = args[0] if args else None
            if isinstance(target, int):
                return
            if isinstance(target, (str, bytes, os.PathLike)) and not allowed(os.fsdecode(target)):
                raise PermissionError(f"filesystem access outside the sandbox is disabled: {target}")

    for name in list(sys.modules):
        if name.split(".")[0] in blocked:
            del sys.modules[name]
    sys.addaudithook(audit)
    sys.meta_path.insert(0, Block())
    _lock_alarm()


def _set_limits() -> None:
    if sys.platform == "win32":
        return
    import resource

    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_BYTES, FILE_BYTES))
    try:
        resource.setrlimit(resource.RLIMIT_AS, (ADDRESS_BYTES, ADDRESS_BYTES))
    except (ValueError, OSError):
        pass


def _execute_user(root: Path) -> None:
    os.chdir(root)
    sys.path.insert(0, str(root))
    if os.environ.get("PLOTS_FORKED") == "1" and os.environ.get("ENSEMBLE_PLOT_TEST_CRASH") == "fork":
        os.kill(os.getpid(), signal.SIGSEGV)
    _import_stack()
    _install_guards(root)
    _set_limits()
    code = (root / "user_script.py").read_text()
    exec(compile(code, "user_script.py", "exec"), {"__name__": "__main__"})


def _prepare(job: dict) -> Path:
    root = Path(tempfile.mkdtemp(prefix="ensemble-plot-"))
    (root / "out").mkdir()
    (root / "ensemble_plots.py").write_text(HELPER)
    mapping: dict[str, str] = {}
    for item in job.get("datasets") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "data")
        safe = "".join(ch if ch.isalnum() else "_" for ch in name)[:40] or "data"
        filename = f"{safe}.json"
        columns = list(item.get("columns") or [])
        rows = item.get("rows") or []
        records = []
        for row in rows:
            record = {}
            cells = list(row) if isinstance(row, (list, tuple)) else []
            for index, column in enumerate(columns):
                record[str(column)] = cells[index] if index < len(cells) else None
            records.append(record)
        (root / filename).write_text(json.dumps(records))
        mapping[name] = filename
    (root / "datasets.json").write_text(json.dumps(mapping))
    (root / "user_script.py").write_text(str(job.get("code") or ""))
    return root


def _apply_job_env(root: Path, fmt: str, dpi: int, forked: bool) -> None:
    os.environ["HOME"] = str(root)
    os.environ["PLOTS_ROOT"] = str(root)
    os.environ["PLOTS_FORMAT"] = fmt
    os.environ["PLOTS_DPI"] = str(dpi)
    os.environ["MPLBACKEND"] = "Agg"
    if forked:
        os.environ["PLOTS_FORKED"] = "1"
    else:
        os.environ.pop("PLOTS_FORKED", None)
        os.environ.pop("ENSEMBLE_PLOT_TEST_CRASH", None)


def _redirect_stdio(root: Path) -> None:
    """Point the child's own output at files. The protocol pipe stays with the parent.

    The old Python wrappers are dropped before dup2. Their close only affects this
    process, and it must happen while fd 1 still refers to the protocol pipe.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    stdin = open(os.devnull, "r")  # noqa: SIM115
    stdout = open(root / "_stdout.txt", "w")  # noqa: SIM115
    stderr = open(root / "_stderr.txt", "w")  # noqa: SIM115
    sys.stdin = stdin
    sys.stdout = stdout
    sys.stderr = stderr
    os.dup2(stdin.fileno(), 0)
    os.dup2(stdout.fileno(), 1)
    os.dup2(stderr.fileno(), 2)


def _flush_child() -> None:
    try:
        sys.stdout.flush()
    except Exception:
        pass
    try:
        sys.stderr.flush()
    except Exception:
        pass


def _arm_child(timeout: float) -> None:
    """Die with the worker, and stop even if the parent never reaps us.

    prctl runs before the plot guards, which refuse ctypes. The getppid check
    covers the parent dying between fork and the prctl call. signal.alarm is
    the wall-clock backstop on macOS, which has no PDEATHSIG. SIG_DFL so the
    kernel stops the process even inside C code. The parent also kills this
    child from its own deadline, which does not depend on this alarm.
    """
    parent = os.getppid()
    if sys.platform.startswith("linux"):
        try:
            import ctypes

            libc = ctypes.CDLL("libc.so.6", use_errno=True)
            libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
            libc.prctl.restype = ctypes.c_int
            libc.prctl(1, int(signal.SIGKILL), 0, 0, 0)  # PR_SET_PDEATHSIG
        except Exception:
            pass
        if os.getppid() != parent:
            os.kill(os.getpid(), signal.SIGKILL)
    if not hasattr(signal, "SIGALRM"):
        return
    seconds = max(1, int(timeout + 2))
    if timeout + 2 > seconds:
        seconds += 1
    try:
        signal.signal(signal.SIGALRM, signal.SIG_DFL)
        signal.alarm(seconds)
    except (OSError, ValueError):
        pass


def _lock_alarm() -> None:
    """Keep the alarm backstop after user code. alarm(0) must not disarm it."""
    if not hasattr(signal, "alarm") or not hasattr(signal, "SIGALRM"):
        return
    real_alarm = signal.alarm
    real_signal = signal.signal
    real_setitimer = getattr(signal, "setitimer", None)
    real_getitimer = getattr(signal, "getitimer", None)
    itimer_real = getattr(signal, "ITIMER_REAL", None)
    try:
        real_signal(signal.SIGALRM, signal.SIG_DFL)
    except (OSError, ValueError):
        pass

    def alarm(seconds: int = 0) -> int:
        remaining = real_alarm(0)
        try:
            requested = int(seconds)
        except (TypeError, ValueError):
            requested = 0
        if remaining <= 0:
            return real_alarm(requested) if requested > 0 else 0
        # A positive request may only make the backstop sooner, never later or off.
        real_alarm(remaining if requested <= 0 else min(remaining, requested))
        return remaining

    def locked_signal(signum, handler):
        if signum == signal.SIGALRM:
            return signal.SIG_DFL
        return real_signal(signum, handler)

    signal.alarm = alarm  # type: ignore[method-assign]
    signal.signal = locked_signal  # type: ignore[method-assign]
    if real_setitimer is not None and real_getitimer is not None and itimer_real is not None:

        def setitimer(which, seconds, interval=0.0):
            if which == itimer_real:
                return real_getitimer(which)
            return real_setitimer(which, seconds, interval)

        signal.setitimer = setitimer  # type: ignore[method-assign]


def _plot_dirs_in_use() -> set[str]:
    """Plot directories a live process still has as its working directory."""
    used: set[str] = set()
    proc = Path("/proc")
    if not proc.is_dir():
        return used
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cwd = os.path.realpath(entry / "cwd")
        except OSError:
            continue
        used.add(cwd)
    return used


def _sweep_stale_plots(directory: Path | None = None, max_age: float = 180) -> None:
    """Remove leftover plot folders. Skip anything younger than a few minutes or still in use."""
    import shutil

    root = directory or Path(tempfile.gettempdir())
    now = time.time()
    in_use = _plot_dirs_in_use()
    try:
        entries = list(root.glob("ensemble-plot-*"))
    except OSError:
        return
    for path in entries:
        if not path.is_dir():
            continue
        try:
            if now - path.stat().st_mtime < max_age:
                continue
            if str(path.resolve()) in in_use:
                continue
        except OSError:
            continue
        shutil.rmtree(path, ignore_errors=True)


def _enter_own_group() -> None:
    """Join a new process group. The parent does this too, so a child that
    never reaches this line is still in the group the parent will kill.
    """
    try:
        os.setpgid(0, 0)
    except OSError:
        pass


def _run_fork_child(root: Path, fmt: str, dpi: int, timeout: float) -> None:
    _enter_own_group()
    _arm_child(timeout)
    try:
        _redirect_stdio(root)
        _apply_job_env(root, fmt, dpi, forked=True)
        _execute_user(root)
    except SystemExit as exc:
        _flush_child()
        code = exc.code
        os._exit(code if isinstance(code, int) else 1)
    except Exception:
        traceback.print_exc()
        _flush_child()
        os._exit(1)
    _flush_child()
    os._exit(0)


def _cold_env(root: Path, fmt: str, dpi: int, timeout: float) -> dict[str, str]:
    keep = (
        "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT",
        "MPLCONFIGDIR", "PYTHONPATH", "PYTHONHOME", "PYTHONNOUSERSITE",
        "OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "ENSEMBLE_OS_SANDBOX",
    )
    env = {key: os.environ[key] for key in keep if os.environ.get(key)}
    env.update({
        "HOME": str(root),
        "PLOTS_ROOT": str(root),
        "PLOTS_FORMAT": fmt,
        "PLOTS_DPI": str(dpi),
        "MPLBACKEND": "Agg",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PLOTS_TIMEOUT": str(timeout),
    })
    env.setdefault("LANG", "C.UTF-8")
    return env


def _run_cold(root: Path, fmt: str, dpi: int, timeout: float) -> tuple[int, bool, int | None]:
    """Fresh interpreter. Used on Windows and when a fork crashes before the plot."""
    import subprocess

    env = _cold_env(root, fmt, dpi, timeout)
    command = [sys.executable, str(Path(__file__).resolve()), "--once", str(root)]
    with (root / "_stdout.txt").open("w") as stdout, (root / "_stderr.txt").open("w") as stderr:
        proc = subprocess.Popen(
            command,
            cwd=str(root),
            env=env,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
        )
        try:
            # The parent's wait is the deadline. The child's alarm is only a backstop.
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_group(proc.pid)
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            return -1, True, None
    if code < 0:
        return code, False, -code
    return code, False, None


def _read_text(path: Path) -> str:
    try:
        return path.read_text(errors="replace")[-MAX_OUTPUT:]
    except OSError:
        return ""


def _b64(path: Path) -> str | None:
    if not path.exists() or path.stat().st_size == 0:
        return None
    import base64

    return base64.b64encode(path.read_bytes()).decode("ascii")


def _line(stderr: str) -> int | None:
    for row in reversed(stderr.splitlines()):
        if "user_script.py" in row and "line" in row:
            digits = "".join(ch if ch.isdigit() else " " for ch in row).split()
            if digits:
                return int(digits[-1])
    return None


def _summary(stderr: str) -> str:
    lines = [line for line in stderr.splitlines() if line.strip()]
    return lines[-1][:500] if lines else ""


def _payload(root: Path, returncode: int, timed_out: bool, sig: int | None, fallback: bool, fmt: str) -> dict:
    stdout = _read_text(root / "_stdout.txt")
    stderr = _read_text(root / "_stderr.txt")
    out = root / "out"
    svg_path = out / "figure.svg"
    payload = {
        "returncode": returncode,
        "timeout": timed_out,
        "signal": sig,
        "fallback": fallback,
        "stdout": stdout,
        "stderr": stderr,
        "png": _b64(out / "figure.png"),
        "svg": svg_path.read_text(errors="replace") if svg_path.exists() else None,
        "pdf": _b64(out / "figure.pdf"),
        "eps": _b64(out / "figure.eps"),
        "line": _line(stderr),
    }
    if timed_out:
        return payload
    wanted = payload.get(fmt) if fmt in {"png", "svg", "pdf", "eps"} else payload.get("pdf")
    # Equal soft and hard RLIMIT_CPU delivers SIGKILL, not SIGXCPU. A wall-clock
    # timeout is flagged before this and does not use this sentence.
    cpu_signals = {getattr(signal, "SIGXCPU", 24), getattr(signal, "SIGKILL", 9)}
    if sig in cpu_signals:
        payload["error"] = "The script hit the CPU limit."
    elif sig == getattr(signal, "SIGXFSZ", 25) or "File too large" in stderr or "Errno 27" in stderr:
        payload["error"] = "The script hit the file size limit."
    elif returncode != 0 and not wanted:
        payload["error"] = _summary(stderr) or "The script failed."
    return payload


def _fork_fault(status: int, timed_out: bool) -> bool:
    if timed_out or not os.WIFSIGNALED(status):
        return False
    return os.WTERMSIG(status) in _FORK_FAULTS


def _finish_status(status: int, timed_out: bool) -> tuple[int, int | None]:
    if os.WIFSIGNALED(status):
        return -os.WTERMSIG(status), os.WTERMSIG(status)
    if timed_out:
        return -1, None
    return os.WEXITSTATUS(status), None


def _kill_group(pid: int) -> None:
    """SIGKILL the process group the parent created for this child, then the pid.

    SIGKILL cannot be masked. Killing the group also stops a grandchild the
    plot forked into the same group.
    """
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass


def _reply(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def _once(root: Path) -> None:
    try:
        _arm_child(float(os.environ.get("PLOTS_TIMEOUT") or "20"))
    except (TypeError, ValueError):
        _arm_child(20)
    fmt = os.environ.get("PLOTS_FORMAT") or "all"
    dpi_raw = os.environ.get("PLOTS_DPI") or "200"
    try:
        dpi = int(dpi_raw)
    except ValueError:
        dpi = 200
    _apply_job_env(root, fmt, dpi, forked=False)
    try:
        _execute_user(root)
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)


class _Server:
    def __init__(self, fork_ok: bool) -> None:
        self.fork_ok = fork_ok
        self.queue: deque[dict] = deque()
        self.children: dict[int, dict] = {}
        self.buffer = b""
        self.cap = concurrency()
        self.stdin_fd = sys.stdin.fileno()

    def serve(self) -> None:
        if not self.fork_ok:
            self._serve_serial()
            return
        import fcntl

        flags = fcntl.fcntl(self.stdin_fd, fcntl.F_GETFL)
        fcntl.fcntl(self.stdin_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        while True:
            self._fill()
            if not self.children and not self.queue and not self.buffer:
                readable, _, _ = select.select([self.stdin_fd], [], [], None)
                if not readable:
                    continue
                if not self._read():
                    return
                continue
            readable, _, _ = select.select([self.stdin_fd], [], [], 0.05)
            if readable and not self._read():
                self._drain()
                return
            self._deadlines()
            self._reap()

    def _serve_serial(self) -> None:
        """Windows, or a parent that already has threads. One cold interpreter at a time."""
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                job = json.loads(raw)
            except json.JSONDecodeError:
                continue
            self._cold_job(job)

    def _read(self) -> bool:
        try:
            chunk = os.read(self.stdin_fd, 1 << 20)
        except BlockingIOError:
            return True
        if not chunk:
            return False
        self.buffer += chunk
        self._take_lines()
        return True

    def _take_lines(self) -> None:
        while b"\n" in self.buffer:
            raw, self.buffer = self.buffer.split(b"\n", 1)
            text = raw.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                job = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(job, dict) and job.get("id") and job.get("cancel"):
                self._cancel_job(str(job["id"]))
                continue
            if isinstance(job, dict) and job.get("id"):
                self.queue.append(job)

    def _fill(self) -> None:
        while self.queue and len(self.children) < self.cap:
            self._start(self.queue.popleft())

    def _start(self, job: dict) -> None:
        root = _prepare(job)
        fmt = str(job.get("format") or "all")
        try:
            dpi = int(job.get("dpi") or 200)
        except (TypeError, ValueError):
            dpi = 200
        try:
            timeout = float(job.get("timeout") or 20)
        except (TypeError, ValueError):
            timeout = 20
        sys.stdout.flush()
        sys.stderr.flush()
        pid = os.fork()
        if pid == 0:
            _enter_own_group()
            _run_fork_child(root, fmt, dpi, timeout)
        # The parent puts the child in its own group before any user code runs.
        # The wall-clock kill below is SIGKILL to that group, so alarm(0), a
        # blocked SIGALRM, or a reloaded signal module cannot keep the child alive.
        try:
            os.setpgid(pid, pid)
        except OSError:
            pass
        job_id = str(job["id"])
        self.children[pid] = {
            "id": job_id,
            "root": root,
            "fmt": fmt,
            "dpi": dpi,
            "timeout": timeout,
            "deadline": time.monotonic() + timeout,
            "timed_out": False,
        }
        _reply({"id": job_id, "started": True})

    def _deadlines(self) -> None:
        """Each child's clock starts when that child is forked.

        The parent kills the child's process group with SIGKILL. That does not
        use the child's alarm, and a script cannot block SIGKILL or leave the
        group by reloading the in-process guard.
        """
        now = time.monotonic()
        for pid, state in self.children.items():
            if not state["timed_out"] and now >= state["deadline"]:
                state["timed_out"] = True
                _kill_group(pid)

    def _reap(self) -> None:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                return
            state = self.children.pop(pid, None)
            if state is None:
                continue
            self._on_child(state, status)

    def _drain(self) -> None:
        for pid in list(self.children):
            _kill_group(pid)
        while self.children:
            try:
                pid, status = os.waitpid(-1, 0)
            except ChildProcessError:
                self.children.clear()
                return
            state = self.children.pop(pid, None)
            if state is not None:
                self._on_child(state, status)

    def _on_child(self, state: dict, status: int) -> None:
        root: Path = state["root"]
        timed_out = bool(state["timed_out"])
        fallback = False
        if _fork_fault(status, timed_out):
            code, cold_timeout, sig = _run_cold(root, state["fmt"], state["dpi"], state["timeout"])
            returncode, timed_out = code, cold_timeout
            fallback = True
        else:
            returncode, sig = _finish_status(status, timed_out)
        self._send(state["id"], root, returncode, timed_out, sig, fallback, state["fmt"])

    def _cold_job(self, job: dict) -> None:
        job_id = str(job.get("id") or "")
        if not job_id:
            return
        root = _prepare(job)
        fmt = str(job.get("format") or "all")
        try:
            dpi = int(job.get("dpi") or 200)
        except (TypeError, ValueError):
            dpi = 200
        try:
            timeout = float(job.get("timeout") or 20)
        except (TypeError, ValueError):
            timeout = 20
        _reply({"id": job_id, "started": True})
        code, timed_out, sig = _run_cold(root, fmt, dpi, timeout)
        self._send(job_id, root, code if not timed_out else -1, timed_out, sig, False, fmt)

    def _cancel_job(self, job_id: str) -> None:
        """Stop one export. The warm parent and every other child keep running."""
        kept: deque[dict] = deque()
        while self.queue:
            item = self.queue.popleft()
            if str(item.get("id")) != job_id:
                kept.append(item)
        self.queue = kept
        for pid, state in self.children.items():
            if state["id"] == job_id and not state["timed_out"]:
                state["timed_out"] = True
                _kill_group(pid)
                return

    def _send(self, job_id: str, root: Path, returncode: int, timed_out: bool, sig: int | None, fallback: bool, fmt: str) -> None:
        try:
            body = _payload(root, returncode, timed_out, sig, fallback, fmt)
        except Exception:
            body = {
                "returncode": 1,
                "timeout": False,
                "signal": None,
                "fallback": fallback,
                "stdout": "",
                "stderr": traceback.format_exc()[-MAX_OUTPUT:],
                "png": None,
                "svg": None,
                "pdf": None,
                "eps": None,
                "line": None,
                "error": "The script failed.",
            }
        body["id"] = job_id
        try:
            import shutil

            shutil.rmtree(root, ignore_errors=True)
        except Exception:
            pass
        _reply(body)


def _serve() -> None:
    try:
        backend = _import_stack()
        _warm_font_cache()
    except Exception as exc:
        missing = "matplotlib" if "matplotlib" in type(exc).__name__ or "matplotlib" in str(exc) or isinstance(exc, ModuleNotFoundError) else "python"
        _reply({"ready": False, "missing": missing})
        sys.exit(1)
    try:
        _sweep_stale_plots()
    except Exception:
        pass
    import threading

    threads = threading.active_count()
    fork_ok = sys.platform != "win32" and hasattr(os, "fork") and threads == 1 and backend.lower() == "agg"
    _reply({"ready": True, "backend": backend, "threads": threads, "fork": fork_ok})
    _Server(fork_ok).serve()


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == "--once":
        _once(Path(sys.argv[2]))
        return
    _serve()


if __name__ == "__main__":
    main()
