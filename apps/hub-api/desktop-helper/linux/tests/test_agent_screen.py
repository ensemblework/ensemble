import os
import tempfile
import unittest

from desktop_helper import agent_screen as screen
from desktop_helper.apps import app_id_from_unit, launch_command


class SizeAndPaths(unittest.TestCase):
    def test_size(self):
        self.assertEqual(screen.parse_size(None), (1600, 1000))
        self.assertEqual(screen.parse_size("1280x800"), (1280, 800))
        for bad in ("1280", "12x8", "99999x100", "1600x100"):
            with self.assertRaises(ValueError):
                screen.parse_size(bad)

    def test_paths_live_in_a_private_folder_with_names_the_owner_never_uses(self):
        found = screen.paths("/run/user/1000", "0a1b2c3d")
        self.assertEqual(found["runtime"], "/run/user/1000/ensemble-agent-0a1b2c3d")
        self.assertEqual(found["display"], "ensemble-agent-0a1b2c3d")
        self.assertEqual(found["wayland"], "/run/user/1000/ensemble-agent-0a1b2c3d/ensemble-agent-0a1b2c3d")
        self.assertTrue(found["bus"].startswith(found["runtime"] + "/"))
        with self.assertRaises(ValueError):
            screen.paths("/run/user/1000", "../evil")


class Environment(unittest.TestCase):
    owner = {
        "HOME": "/home/mira",
        "PATH": "/usr/bin:/bin",
        "LANG": "en_GB.UTF-8",
        "LC_TIME": "en_GB.UTF-8",
        "XDG_RUNTIME_DIR": "/run/user/1000",
        "XDG_DATA_DIRS": "/usr/local/share:/usr/share:/home/mira/.local/share",
        "DISPLAY": ":0",
        "XAUTHORITY": "/run/user/1000/.mutter-Xwaylandauth",
        "WAYLAND_DISPLAY": "wayland-0",
        "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
        "XDG_SESSION_ID": "2",
        "XDG_SEAT": "seat0",
        "SSH_AUTH_SOCK": "/run/user/1000/keyring/ssh",
        "GNOME_KEYRING_CONTROL": "/run/user/1000/keyring",
        "AT_SPI_BUS_ADDRESS": "unix:path=/run/user/1000/at-spi/bus_0",
        "OPENAI_API_KEY": "sk-not-for-the-agent-screen",
    }

    def test_nothing_of_the_owners_session_reaches_the_agent_screen(self):
        env = screen.session_env(self.owner, state_dir="/data/desktop/agent", runtime="/run/user/1000/ensemble-agent-0a1b2c3d", wayland="/run/user/1000/ensemble-agent-0a1b2c3d/ensemble-agent-0a1b2c3d", bus_address="unix:path=/run/user/1000/ensemble-agent-0a1b2c3d/bus")
        for key in ("DISPLAY", "XAUTHORITY", "XDG_SESSION_ID", "XDG_SEAT", "SSH_AUTH_SOCK", "GNOME_KEYRING_CONTROL", "AT_SPI_BUS_ADDRESS", "OPENAI_API_KEY"):
            self.assertNotIn(key, env)
        self.assertEqual(env["DBUS_SESSION_BUS_ADDRESS"], "unix:path=/run/user/1000/ensemble-agent-0a1b2c3d/bus")
        self.assertEqual(env["WAYLAND_DISPLAY"], "/run/user/1000/ensemble-agent-0a1b2c3d/ensemble-agent-0a1b2c3d")
        self.assertEqual(env["XDG_RUNTIME_DIR"], "/run/user/1000/ensemble-agent-0a1b2c3d")
        self.assertEqual(env["PIPEWIRE_RUNTIME_DIR"], "/run/user/1000")
        self.assertEqual(env["XDG_CONFIG_HOME"], "/data/desktop/agent/config")
        self.assertEqual(env["XDG_DATA_HOME"], "/data/desktop/agent/data")
        self.assertEqual(env["GIO_USE_VFS"], "local")
        self.assertTrue(env["PULSE_SERVER"].startswith("unix:/run/user/1000/ensemble-agent-0a1b2c3d/"))
        self.assertEqual(env["LANG"], "en_GB.UTF-8")
        self.assertEqual(env["LC_TIME"], "en_GB.UTF-8")

    def test_the_owners_apps_are_still_found_first(self):
        env = screen.session_env(self.owner, state_dir="/s", runtime="/r", wayland=None)
        self.assertEqual(env["XDG_DATA_DIRS"].split(":"), ["/home/mira/.local/share", "/usr/local/share", "/usr/share"])
        self.assertNotIn("WAYLAND_DISPLAY", env)
        self.assertNotIn("DBUS_SESSION_BUS_ADDRESS", env)


class Commands(unittest.TestCase):
    def test_compositor_and_bus(self):
        self.assertEqual(
            screen.shell_command("ensemble-agent-0a1b2c3d", (1600, 1000), "/usr/bin/gnome-shell"),
            ["/usr/bin/gnome-shell", "--headless", "--wayland", "--no-x11", "--wayland-display", "ensemble-agent-0a1b2c3d", "--virtual-monitor", "1600x1000", "--mode=ensemble-agent"],
        )
        self.assertEqual(screen.bus_command("/r/session.conf", "/usr/bin/dbus-daemon"), ["/usr/bin/dbus-daemon", "--config-file=/r/session.conf", "--nofork", "--nopidfile", "--print-address=1"])

    def test_the_private_bus_starts_only_its_own_services(self):
        config = screen.session_config("/r/bus", "/r/services")
        self.assertIn("<listen>unix:path=/r/bus</listen>", config)
        self.assertIn("<servicedir>/r/services</servicedir>", config)
        self.assertNotIn("standard_session_servicedirs", config)
        self.assertNotIn("<include", config)
        self.assertIn("&amp;", screen.session_config("/r/a&b", "/r/services"))

    def test_the_shell_mode_leaves_out_what_acts_for_the_owners_session(self):
        import json

        with tempfile.TemporaryDirectory() as state:
            path = screen.write_shell_mode(state)
            self.assertEqual(path, os.path.join(screen.shell_data_dir(state), "gnome-shell", "modes", "ensemble-agent.json"))
            with open(path) as handle:
                mode = json.load(handle)
        self.assertEqual(mode["parentMode"], "user")
        self.assertEqual(mode["components"], [], "no polkit, network, keyring or mount agent")
        self.assertNotIn("quickSettings", sum(mode["panel"].values(), []), "no system menu and no location agent")
        self.assertFalse(mode["hasOverview"], "no search offering suspend or power off")
        self.assertFalse(mode["hasRunDialog"])
        self.assertIn(["/usr/bin/gsettings", "set", "org.gnome.desktop.lockdown", "disable-lock-screen", "true"], screen.settings_commands("/usr/bin/gsettings"))

    def test_settings_keep_the_agent_screen_awake_and_quiet(self):
        commands = screen.settings_commands("/usr/bin/gsettings")
        self.assertIn(["/usr/bin/gsettings", "set", "org.gnome.desktop.screensaver", "lock-enabled", "false"], commands)
        self.assertIn(["/usr/bin/gsettings", "set", "org.gnome.desktop.session", "idle-delay", "uint32 0"], commands)

    def test_apps_start_with_the_agent_screens_runtime_folder(self):
        command = launch_command("/usr/share/applications/org.gnome.Calculator.desktop", "org.gnome.Calculator", systemd_run="/usr/bin/systemd-run", gio="/usr/bin/gio", prefix=screen.app_launch_prefix("/run/user/1000/ensemble-agent-0a1b2c3d"), unit_prefix="app-ensemble-agent")
        self.assertEqual(command[:4], ["/usr/bin/systemd-run", "--user", "--scope", "--collect"])
        self.assertTrue(command[5].startswith("--unit=app-ensemble-agent-org.gnome.Calculator-"))
        self.assertEqual(command[6:], ["--", "env", "XDG_RUNTIME_DIR=/run/user/1000/ensemble-agent-0a1b2c3d", "/usr/bin/gio", "launch", "/usr/share/applications/org.gnome.Calculator.desktop"])


class Apps(unittest.TestCase):
    def test_only_the_agent_screens_own_scopes_are_ended_with_it(self):
        command = launch_command("/usr/share/applications/org.gnome.Calculator.desktop", "org.gnome.Calculator", systemd_run="/usr/bin/systemd-run", gio="/usr/bin/gio", unit_prefix=screen.UNIT_PREFIX)
        unit = screen.unit_of(command)
        self.assertRegex(unit, r"^app-ensemble-agent-org\.gnome\.Calculator-[0-9a-f]{8}$")
        self.assertIsNone(screen.unit_of(launch_command("/x/a.desktop", "a", systemd_run="/usr/bin/systemd-run", gio="/usr/bin/gio")), "a scope on the owner's screen")
        self.assertIsNone(screen.unit_of(["gio", "launch", "/x/a.desktop"]), "no scope")
        self.assertEqual(app_id_from_unit(f"{unit}.scope"), "org.gnome.Calculator")
        agent = screen.AgentScreen(tempfile.gettempdir(), (1600, 1000), lambda _m: None, token="0a1b2c3d")
        agent.track(unit)
        agent.track(unit)
        agent.track("app-gnome-org.gnome.Calculator-4242")
        agent.track(None)
        self.assertEqual(agent.units, [unit])

    def test_children_are_found_by_their_parent(self):
        import subprocess

        child = subprocess.Popen(["sleep", "5"])
        try:
            self.assertIn(child.pid, screen.children_of(os.getpid()))
            self.assertNotIn(os.getpid(), screen.children_of(os.getpid()))
        finally:
            child.kill()
            child.wait()


class Services(unittest.TestCase):
    def test_only_allowlisted_services_and_apps_that_start_by_dbus(self):
        with tempfile.TemporaryDirectory() as root:
            apps = os.path.join(root, "applications")
            services = os.path.join(root, "dbus-1", "services")
            os.makedirs(apps)
            os.makedirs(services)
            for name, body in (("org.gnome.TextEditor", "DBusActivatable=true\n"), ("org.gnome.Calculator", "Exec=gnome-calculator\n")):
                with open(os.path.join(apps, f"{name}.desktop"), "w") as handle:
                    handle.write(f"[Desktop Entry]\nName={name}\n{body}")
            for name in ("org.gnome.TextEditor", "ca.desrt.dconf", "org.gtk.vfs.Daemon", "org.freedesktop.secrets", "org.freedesktop.portal.Documents"):
                with open(os.path.join(services, f"{name}.service"), "w") as handle:
                    handle.write(f"[D-BUS Service]\nName={name}\nExec=/bin/true\n")
            ids = screen.activatable_apps(screen.desktop_entries([root]))
            self.assertEqual(ids, ["org.gnome.TextEditor"])
            self.assertEqual(sorted(screen.allowed_service_files([root], ids)), ["ca.desrt.dconf", "org.gnome.TextEditor"])


class Leftovers(unittest.TestCase):
    def test_a_reused_pid_is_never_signalled_and_the_folder_goes(self):
        started = screen.start_time(os.getpid())
        self.assertIsInstance(started, int)
        with tempfile.TemporaryDirectory() as runtime:
            folder = os.path.join(runtime, "ensemble-agent-0a1b2c3d")
            os.makedirs(folder)
            with open(os.path.join(folder, "pids"), "w") as handle:
                handle.write(f"{os.getpid()} {started + 1}\n")
            os.makedirs(os.path.join(runtime, "ensemble-agent-not-ours"))
            self.assertEqual(screen.clean_leftovers(runtime, lambda _m: None), 1)
            self.assertFalse(os.path.exists(folder))
            self.assertTrue(os.path.exists(os.path.join(runtime, "ensemble-agent-not-ours")))


if __name__ == "__main__":
    unittest.main()
