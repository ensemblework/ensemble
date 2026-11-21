"""A private screen for the agent: a headless GNOME Shell on a D-Bus session bus of its own, with its own
Wayland socket, AT-SPI bus, runtime folder and settings, so nothing the agent opens there shows on the
owner's screen and nothing there touches the owner's session.

Isolation, each point a constraint:
- headless mode opens no display (KMS) or input device, only a render node;
- GNOME Shell runs in a session mode of its own (`SHELL_MODE`): no system menu, overview, run dialog or
  settings, and none of the shell's agents, which would otherwise act for the owner's session on the
  system bus (GeoClue keeps one location agent per user, so a second shell would replace the owner's);
  its screen never locks, whatever the owner's session does;
- the session's bus, AT-SPI bus, Wayland socket and every runtime file live in a private folder
  (`XDG_RUNTIME_DIR` of its own): the owner's sockets of the same names are never replaced;
- the private bus starts only allowlisted services (settings, the permission store, apps that start by
  D-Bus): never the owner's keyring, file systems, document portal, indexer or calendar;
- settings, data and caches are private folders; no sound; no login session id;
- only PipeWire is shared (the screen's frames), through `PIPEWIRE_RUNTIME_DIR`.
It is started with the helper (`--agent-screen`) and stopped with it, after the apps on it: they end on
a signal rather than by losing their display.
"""
from __future__ import annotations

import ctypes
import glob
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import time
from typing import Callable, Iterable, Mapping
from xml.sax.saxutils import escape

DEFAULT_SIZE = (1600, 1000)
SIZE = re.compile(r"^(\d{3,4})x(\d{3,4})$")
TOKEN = re.compile(r"^[0-9a-f]{8}$")
PREFIX = "ensemble-agent-"
UNIT_PREFIX = "app-ensemble-agent"
UNIT = re.compile(r"^app-ensemble-agent-[A-Za-z0-9_.\\:-]{1,200}$")

KEEP = ("HOME", "USER", "LOGNAME", "PATH", "LANG", "LANGUAGE", "TZ", "GI_TYPELIB_PATH", "GST_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE")

# Services the private bus may start: settings, the permission store GNOME Shell asks, and apps that start by D-Bus.
ALLOWED_SERVICES = ("ca.desrt.dconf", "org.freedesktop.impl.portal.PermissionStore")
A11Y_LAUNCHERS = ("/usr/libexec/at-spi-bus-launcher", "/usr/lib/at-spi2-core/at-spi-bus-launcher", "/usr/lib/at-spi-bus-launcher")

# Settings of the agent screen's own GNOME (its private dconf): no lock, no blanking, no welcome tour, no animations.
# The lockdown key also makes the shell ignore logind's Lock for the owner's session and take no sleep inhibitor.
SETTINGS = (
    ("org.gnome.desktop.session", "idle-delay", "uint32 0"),
    ("org.gnome.desktop.screensaver", "lock-enabled", "false"),
    ("org.gnome.desktop.lockdown", "disable-lock-screen", "true"),
    ("org.gnome.desktop.screensaver", "idle-activation-enabled", "false"),
    ("org.gnome.desktop.interface", "enable-animations", "false"),
    ("org.gnome.desktop.interface", "toolkit-accessibility", "true"),
    ("org.gnome.desktop.notifications", "show-banners", "false"),
    ("org.gnome.shell", "welcome-dialog-last-shown-version", "'9999'"),
)

SHELL_MODE = "ensemble-agent"
# GNOME Shell reads session modes from `gnome-shell/modes/<name>.json` in XDG_DATA_DIRS. The quick settings
# hold the location agent and the power, network and Bluetooth controls of the computer; the overview's
# search offers suspend and power off; the components are the polkit, network, keyring and mount agents.
# The keyboard indicator stays: it is what sets the keyboard options before the shell applies a keymap.
SHELL_MODE_SPEC = {
    "parentMode": "user",
    "hasOverview": False,
    "hasRunDialog": False,
    "allowSettings": False,
    "showWelcomeDialog": False,
    "showCalendarEvents": False,
    "components": [],
    "panel": {"left": [], "center": ["dateMenu"], "right": ["screenRecording", "screenSharing", "keyboard"]},
}

SESSION_CONF = """<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:path={bus}</listen>
  <auth>EXTERNAL</auth>
  <servicedir>{services}</servicedir>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
  <limit name="service_start_timeout">60000</limit>
</busconfig>
"""


class AgentScreenError(Exception):
    def __init__(self, message: str, fix: str | None = None):
        super().__init__(message)
        self.fix = fix


def parse_size(text: str | None) -> tuple[int, int]:
    """`WxH` within 640x480 and 7680x4320; the default when empty."""
    if not text:
        return DEFAULT_SIZE
    match = SIZE.match(text.strip())
    if not match:
        raise ValueError("The agent screen's size is WIDTHxHEIGHT, such as 1600x1000.")
    width, height = int(match.group(1)), int(match.group(2))
    if not (640 <= width <= 7680 and 480 <= height <= 4320):
        raise ValueError("The agent screen is between 640x480 and 7680x4320.")
    return width, height


def owner_runtime(env: Mapping[str, str]) -> str:
    return env.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"


def paths(owner_runtime_dir: str, token: str) -> dict[str, str]:
    """The private runtime folder and what is in it."""
    if not TOKEN.match(token):
        raise ValueError("A screen token is 8 hex digits.")
    runtime = os.path.join(owner_runtime_dir, f"{PREFIX}{token}")
    return {
        "runtime": runtime,
        "bus": os.path.join(runtime, "bus"),
        "services": os.path.join(runtime, "services"),
        "config": os.path.join(runtime, "session.conf"),
        "display": f"{PREFIX}{token}",
        "wayland": os.path.join(runtime, f"{PREFIX}{token}"),
        "pids": os.path.join(runtime, "pids"),
    }


def private_dirs(state_dir: str) -> dict[str, str]:
    return {key: os.path.join(state_dir, part) for key, part in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state"))}


def session_env(base: Mapping[str, str], *, state_dir: str, runtime: str, wayland: str | None, bus_address: str | None = None) -> dict[str, str]:
    """The agent session's environment: the owner's language and paths, nothing of the owner's session.

    No DISPLAY, XAUTHORITY, owner's bus or login session id; its own runtime folder, settings and data;
    the owner's installed apps still found (their data folder is read first); no sound, no virtual file
    systems; PipeWire shared for the frames."""
    out = {key: value for key, value in base.items() if key in KEEP or key.startswith("LC_")}
    out.update(private_dirs(state_dir))
    home = base.get("HOME", "")
    owner_data = base.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    system = [entry for entry in (base.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share").split(":") if entry]
    out["XDG_DATA_DIRS"] = ":".join([owner_data, *[entry for entry in system if entry != owner_data]])
    out["XDG_RUNTIME_DIR"] = runtime
    out["PIPEWIRE_RUNTIME_DIR"] = owner_runtime(base)
    out["XDG_SESSION_TYPE"] = "wayland"
    out["XDG_CURRENT_DESKTOP"] = "GNOME"
    out["GDK_BACKEND"] = "wayland"
    out["GIO_USE_VFS"] = "local"
    out["GVFS_DISABLE_FUSE"] = "1"
    out["PULSE_SERVER"] = f"unix:{os.path.join(runtime, 'no-sound')}"
    if wayland:
        out["WAYLAND_DISPLAY"] = wayland
    if bus_address:
        out["DBUS_SESSION_BUS_ADDRESS"] = bus_address
    return out


def session_config(bus_path: str, services_dir: str) -> str:
    return SESSION_CONF.format(bus=escape(bus_path), services=escape(services_dir))


def bus_command(config_path: str, dbus_daemon: str = "dbus-daemon") -> list[str]:
    return [dbus_daemon, f"--config-file={config_path}", "--nofork", "--nopidfile", "--print-address=1"]


def shell_command(display: str, size: tuple[int, int], gnome_shell: str = "gnome-shell") -> list[str]:
    """Headless GNOME Shell with one virtual monitor, Wayland only, in the agent screen's mode; its socket is `display` in its runtime folder."""
    return [gnome_shell, "--headless", "--wayland", "--no-x11", "--wayland-display", display, "--virtual-monitor", f"{size[0]}x{size[1]}", f"--mode={SHELL_MODE}"]


def shell_data_dir(state_dir: str) -> str:
    """The folder put first in GNOME Shell's XDG_DATA_DIRS, holding only its session mode."""
    return os.path.join(state_dir, "shell")


def write_shell_mode(state_dir: str) -> str:
    folder = os.path.join(shell_data_dir(state_dir), "gnome-shell", "modes")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, f"{SHELL_MODE}.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(SHELL_MODE_SPEC, handle)
    return path


def settings_commands(gsettings: str = "gsettings") -> list[list[str]]:
    return [[gsettings, "set", schema, key, value] for schema, key, value in SETTINGS]


def app_launch_prefix(runtime: str) -> list[str]:
    """What an app started on the agent screen runs behind: the runtime folder of the agent session.

    systemd-run itself reaches the user manager through the owner's runtime folder; the app gets the private one."""
    return ["env", f"XDG_RUNTIME_DIR={runtime}"]


def unit_of(command: list[str]) -> str | None:
    """The scope a launch command starts the app in (`--unit=`), when it is one of the agent screen's."""
    for part in command:
        if part.startswith("--unit="):
            unit = part[len("--unit="):]
            return unit if UNIT.match(unit) else None
    return None


def children_of(pid: int) -> list[int]:
    """The processes whose parent is `pid`, from /proc."""
    out = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat", "r", encoding="utf-8", errors="replace") as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        if len(fields) > 1 and fields[1].isdigit() and int(fields[1]) == pid:
            out.append(int(entry))
    return out


def desktop_entries(data_dirs: Iterable[str]) -> list[str]:
    seen: dict[str, str] = {}
    for folder in data_dirs:
        for path in glob.glob(os.path.join(folder, "applications", "*.desktop")):
            seen.setdefault(os.path.basename(path), path)
    return list(seen.values())


def activatable_apps(entries: Iterable[str]) -> list[str]:
    """Application ids whose desktop entry says they start by D-Bus."""
    out = []
    for path in entries:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read(65536)
        except OSError:
            continue
        if re.search(r"^DBusActivatable\s*=\s*true\s*$", text, re.MULTILINE | re.IGNORECASE):
            out.append(os.path.basename(path)[: -len(".desktop")])
    return sorted(set(out))


def allowed_service_files(data_dirs: Iterable[str], app_ids: Iterable[str]) -> dict[str, str]:
    """Service name to its file, for the allowlisted services and the D-Bus started apps."""
    wanted = set(ALLOWED_SERVICES) | set(app_ids)
    found: dict[str, str] = {}
    for folder in data_dirs:
        for name in sorted(wanted):
            path = os.path.join(folder, "dbus-1", "services", f"{name}.service")
            if name not in found and os.path.isfile(path):
                found[name] = path
    return found


def _die_with_parent() -> None:
    """The child gets SIGTERM if the helper dies. GNOME Shell drops it (file capabilities) and ends with its bus instead."""
    try:
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)
    except OSError:
        pass


def _which(name: str, env: Mapping[str, str]) -> str | None:
    for folder in (env.get("PATH") or "/usr/bin:/bin").split(":"):
        candidate = os.path.join(folder, name)
        if folder and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _a11y_launcher() -> str | None:
    return next((path for path in A11Y_LAUNCHERS if os.access(path, os.X_OK)), None)


def _is_socket(path: str) -> bool:
    try:
        return stat.S_ISSOCK(os.stat(path).st_mode)
    except OSError:
        return False


def check(env: Mapping[str, str]) -> dict[str, object]:
    """What the agent screen needs, without starting it."""
    shell = _which("gnome-shell", env)
    out: dict[str, object] = {
        "gnome_shell": bool(shell),
        "dbus_daemon": bool(_which("dbus-daemon", env)),
        "a11y_launcher": bool(_a11y_launcher()),
        "pipewire": _is_socket(os.path.join(owner_runtime(env), "pipewire-0")),
        "headless": False,
        "version": None,
    }
    if shell:
        try:
            helped = subprocess.run([shell, "--help"], env=dict(env), capture_output=True, text=True, timeout=10)
            text = helped.stdout + helped.stderr
            out["headless"] = all(flag in text for flag in ("--headless", "--virtual-monitor", "--wayland-display"))
            out["version"] = subprocess.run([shell, "--version"], env=dict(env), capture_output=True, text=True, timeout=10).stdout.strip()[:60] or None
        except (OSError, subprocess.SubprocessError):
            pass
    return out


def start_time(pid: int) -> int | None:
    """The process's start time in clock ticks since boot (`/proc/<pid>/stat`), which a reused pid does not share."""
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as handle:
            fields = handle.read().rsplit(")", 1)[1].split()
        return int(fields[19])
    except (OSError, IndexError, ValueError):
        return None


def clean_leftovers(owner_runtime_dir: str, log: Callable[[str], None]) -> int:
    """Agent screens a helper that died left behind: their processes end and their folders go."""
    removed = 0
    for runtime in glob.glob(os.path.join(owner_runtime_dir, f"{PREFIX}*")):
        if not TOKEN.match(os.path.basename(runtime)[len(PREFIX):]) or not os.path.isdir(runtime) or os.path.islink(runtime):
            continue
        try:
            with open(os.path.join(runtime, "pids"), "r", encoding="utf-8") as handle:
                rows = [line.split() for line in handle.read().splitlines()]
        except OSError:
            rows = []
        for row in rows:
            if len(row) != 2 or not row[0].isdigit() or not row[1].isdigit():
                continue
            pid, started = int(row[0]), int(row[1])
            # Only the very process this screen started: a pid used again since is left alone.
            if start_time(pid) == started:
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
        shutil.rmtree(runtime, ignore_errors=True)
        removed += 1
    if removed:
        log(f"removed {removed} agent screen(s) left by an earlier helper")
    return removed


class AgentScreen:
    """Starts and stops the private session: its bus, AT-SPI bus, settings and compositor."""

    def __init__(self, state_dir: str, size: tuple[int, int], log: Callable[[str], None], token: str | None = None):
        self.state_dir = state_dir
        self.size = size
        self.log = log
        self.base = dict(os.environ)
        self.owner_runtime = owner_runtime(self.base)
        self.token = token or secrets.token_hex(4)
        self.paths = paths(self.owner_runtime, self.token)
        self.processes: list[subprocess.Popen] = []
        self.shell: subprocess.Popen | None = None
        self.bus_address: str | None = None
        self.env: dict[str, str] = {}
        self.started_at: float | None = None
        self.version: str | None = None
        self.units: list[str] = []

    def _spawn(self, command: list[str], env: dict[str, str], **extra) -> subprocess.Popen:
        process = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, preexec_fn=_die_with_parent, close_fds=True, **extra)
        self.processes.append(process)
        with open(self.paths["pids"], "a", encoding="utf-8") as handle:
            handle.write(f"{process.pid} {start_time(process.pid) or 0}\n")
        return process

    def start(self, timeout_s: float = 25.0) -> dict[str, object]:
        shell_path = _which("gnome-shell", self.base)
        bus_path = _which("dbus-daemon", self.base)
        launcher = _a11y_launcher()
        if not shell_path or not bus_path or not launcher:
            raise AgentScreenError("The agent screen needs GNOME Shell, dbus-daemon and the AT-SPI bus launcher, which are not all installed here.", "sudo apt install gnome-shell dbus-daemon at-spi2-core")
        if not _is_socket(os.path.join(self.owner_runtime, "pipewire-0")):
            raise AgentScreenError("The agent screen needs PipeWire, which is not running for this user.", "Start the desktop session's PipeWire (systemctl --user start pipewire).")
        for folder in private_dirs(self.state_dir).values():
            os.makedirs(folder, mode=0o700, exist_ok=True)
        runtime = self.paths["runtime"]
        os.makedirs(runtime, mode=0o700)
        os.makedirs(self.paths["services"], mode=0o700)
        env = session_env(self.base, state_dir=self.state_dir, runtime=runtime, wayland=None)
        data_dirs = [env["XDG_DATA_HOME"], *env["XDG_DATA_DIRS"].split(":")]
        for name, path in allowed_service_files(data_dirs, activatable_apps(desktop_entries(data_dirs))).items():
            os.symlink(path, os.path.join(self.paths["services"], f"{name}.service"))
        with open(self.paths["config"], "w", encoding="utf-8") as handle:
            handle.write(session_config(self.paths["bus"], self.paths["services"]))
        bus = self._spawn(bus_command(self.paths["config"], bus_path), env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        address = self._read_address(bus, 5.0)
        if not address:
            self.stop()
            raise AgentScreenError("The agent screen's own session bus did not start.")
        self.bus_address = address
        env = {**env, "DBUS_SESSION_BUS_ADDRESS": address}
        self._spawn([launcher, "--launch-immediately"], env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        gsettings = _which("gsettings", self.base)
        if gsettings:
            for command in settings_commands(gsettings):
                try:
                    subprocess.run(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                except (OSError, subprocess.SubprocessError):
                    pass
        write_shell_mode(self.state_dir)
        shell_env = {**env, "XDG_DATA_DIRS": f"{shell_data_dir(self.state_dir)}:{env['XDG_DATA_DIRS']}"}
        log_path = os.path.join(self.state_dir, "shell.log")
        with open(log_path, "w", encoding="utf-8") as log_file:
            self.shell = self._spawn(shell_command(self.paths["display"], self.size, shell_path), shell_env, stdout=log_file, stderr=log_file)
        self.env = {**env, "WAYLAND_DISPLAY": self.paths["wayland"]}
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self.shell.poll() is not None:
                tail = self._log_tail(log_path)
                self.stop()
                raise AgentScreenError(f"GNOME Shell for the agent screen stopped as it started{f' ({tail})' if tail else ''}.", "Check that GNOME Shell runs headless here (gnome-shell --headless --virtual-monitor 1600x1000); its log is shell.log in the agent screen's folder.")
            if _is_socket(self.paths["wayland"]):
                self.started_at = time.time()
                self.version = self._version(shell_path)
                return {"display": self.paths["display"], "size": list(self.size), "pid": self.shell.pid, "version": self.version}
            time.sleep(0.1)
        self.stop()
        raise AgentScreenError("GNOME Shell for the agent screen did not come up in time.", "Check that GNOME Shell runs headless here (gnome-shell --headless).")

    def app_env(self) -> dict[str, str]:
        """For starting an app there: the session's environment, with the owner's runtime folder for systemd-run."""
        return {**self.env, "XDG_RUNTIME_DIR": self.owner_runtime}

    def _version(self, shell_path: str) -> str | None:
        try:
            return subprocess.run([shell_path, "--version"], env=self.base, capture_output=True, text=True, timeout=10).stdout.strip()[:60] or None
        except (OSError, subprocess.SubprocessError):
            return None

    @staticmethod
    def _read_address(process: subprocess.Popen, timeout_s: float) -> str | None:
        import select

        assert process.stdout is not None
        ready, _, _ = select.select([process.stdout], [], [], timeout_s)
        if not ready:
            return None
        line = process.stdout.readline().decode("utf-8", "replace").strip()
        return line if line.startswith("unix:") else None

    @staticmethod
    def _log_tail(path: str) -> str:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                lines = [line.strip() for line in handle.read()[-4000:].splitlines() if line.strip()]
        except OSError:
            return ""
        errors = [line for line in lines if "ERROR" in line or "CRITICAL" in line]
        return (errors or lines or [""])[-1][:200]

    def alive(self) -> bool:
        return self.shell is not None and self.shell.poll() is None

    def track(self, unit: str | None) -> None:
        """A scope an app was started in on this screen, to end it with the screen."""
        if unit and UNIT.match(unit) and unit not in self.units:
            self.units.append(unit)

    def close_apps(self, timeout_s: float = 5.0) -> None:
        """Ends the apps on this screen: the scopes it started them in, and the apps its own bus started."""
        systemctl = _which("systemctl", self.base)
        if self.units and systemctl:
            try:
                subprocess.run([systemctl, "--user", "stop", *[f"{unit}.scope" for unit in self.units]], env=self.base, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout_s)
            except (OSError, subprocess.SubprocessError):
                pass
        self.units = []
        bus = self.processes[0] if self.processes else None
        if bus is None or bus.poll() is not None:
            return
        started = children_of(bus.pid)
        for pid in started:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        deadline = time.monotonic() + min(3.0, timeout_s)
        while time.monotonic() < deadline and any(os.path.exists(f"/proc/{pid}") and pid in children_of(bus.pid) for pid in started):
            time.sleep(0.1)

    def stop(self) -> None:
        if self.alive():
            self.close_apps()
        for process in reversed(self.processes):
            if process.poll() is not None:
                continue
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        self.processes = []
        self.shell = None
        shutil.rmtree(self.paths["runtime"], ignore_errors=True)
