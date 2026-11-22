"""Starting apps: an app that starts by D-Bus is started from its command line (its request to open a
window would be dropped otherwise), and the agent screen never starts a snap or Flatpak app."""
import os
import tempfile
import unittest
from unittest import mock

from gi.repository import Gio, GLib

from desktop_helper import apps as appmod
from desktop_helper.rpc import Deadline, RpcError
from desktop_helper.server import Helper

AGENT_RUNTIME = "/run/user/1000/ensemble-agent-0a1b2c3d"


class Agent:
    def __init__(self):
        self.paths = {"runtime": AGENT_RUNTIME}
        self.units: list[str] = []

    def track(self, unit):
        self.units.append(unit)


class Bus:
    def __init__(self):
        self.calls: list[tuple[str, str, str, str]] = []

    def call_sync(self, name, path, interface, method, *_rest):
        self.calls.append((name, path, interface, method))
        if method == "Activate":
            return GLib.Variant("()", ())
        raise GLib.Error("no systemd here")


def launcher(state: str, agent: Agent | None = None, bus: Bus | None = None) -> Helper:
    out = Helper.__new__(Helper)
    out.state_dir = state
    out.agent = agent
    out.bus = bus
    out.env = {}
    out.cancelled = set()
    out._running_for = lambda _app_id, _exec: None
    return out


class Launch(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.folder.name, "state")
        self.started: list[list[str]] = []

    def tearDown(self):
        self.folder.cleanup()

    def entry(self, name: str, body: str) -> str:
        path = os.path.join(self.folder.name, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(body)
        return path

    def launch(self, helper: Helper, path: str, ref: str):
        info = Gio.DesktopAppInfo.new_from_filename(path)
        self.assertIsNotNone(info, path)

        def start(command, _env, timeout_s=15.0):
            self.started.append(command)
            return 0

        with mock.patch.object(appmod, "find_installed", return_value=(info, [])), mock.patch.object(appmod, "start", side_effect=start):
            return helper.apps_launch({"id": ref, "wait_ms": 0}, Deadline(10000), 1)

    def test_an_app_that_starts_by_dbus_starts_from_its_command_line_on_the_agent_screen(self):
        path = self.entry("org.gnome.Ptyxis.desktop", "[Desktop Entry]\nType=Application\nName=Terminal\nExec=true\nDBusActivatable=true\n")
        agent, bus = Agent(), Bus()
        answer = self.launch(launcher(self.state, agent, bus), path, "org.gnome.Ptyxis")
        self.assertTrue(answer["stages"]["accepted"])
        self.assertEqual(len(self.started), 1)
        command = self.started[0]
        copy = os.path.join(self.state, "launchers", "org.gnome.Ptyxis.desktop")
        self.assertEqual(command[-2:], ["launch", copy])
        self.assertIn(f"XDG_RUNTIME_DIR={AGENT_RUNTIME}", command)
        self.assertTrue(agent.units and agent.units[0].startswith("app-ensemble-agent-org.gnome.Ptyxis-"), "in a scope the screen ends")
        self.assertFalse(Gio.DesktopAppInfo.new_from_filename(copy).get_boolean("DBusActivatable"))
        self.assertNotIn("Activate", [call[3] for call in bus.calls], "nothing asks an app on a bus to open a window")

    def test_the_same_on_the_owners_screen(self):
        path = self.entry("org.gnome.Settings.desktop", "[Desktop Entry]\nType=Application\nName=Settings\nExec=true\nDBusActivatable=true\n")
        self.launch(launcher(self.state), path, "org.gnome.Settings")
        self.assertEqual(self.started[0][-2:], ["launch", os.path.join(self.state, "launchers", "org.gnome.Settings.desktop")])

    def test_an_app_without_a_command_line_is_asked_by_dbus_and_waited_for(self):
        path = self.entry("org.gnome.Clocks.desktop", "[Desktop Entry]\nType=Application\nName=Clocks\nDBusActivatable=true\n")
        bus = Bus()
        self.launch(launcher(self.state, Agent(), bus), path, "org.gnome.Clocks")
        self.assertEqual(self.started, [])
        self.assertIn(("org.gnome.Clocks", "/org/gnome/Clocks", "org.freedesktop.Application", "Activate"), bus.calls)

    def test_the_agent_screen_never_starts_a_snap_or_flatpak_app(self):
        for name, body in (
            ("firefox_firefox.desktop", "[Desktop Entry]\nType=Application\nName=Firefox\nExec=env BAMF_DESKTOP_FILE_HINT=/x.desktop /snap/bin/firefox %u\n"),
            ("org.example.Flat.desktop", "[Desktop Entry]\nType=Application\nName=Flat\nExec=true\nX-Flatpak=org.example.Flat\n"),
        ):
            with self.subTest(name=name):
                with self.assertRaises(RpcError) as raised:
                    self.launch(launcher(self.state, Agent(), Bus()), self.entry(name, body), name[: -len(".desktop")])
                self.assertEqual(raised.exception.kind, "unsupported_here")
                self.assertEqual(raised.exception.ran, "no")
                self.assertIn("owner's screen", raised.exception.message)
        self.assertEqual(self.started, [])

    def test_a_plain_app_is_launched_as_it_is(self):
        path = self.entry("org.gnome.Calculator.desktop", "[Desktop Entry]\nType=Application\nName=Calculator\nExec=true\n")
        self.launch(launcher(self.state, Agent(), Bus()), path, "org.gnome.Calculator")
        self.assertEqual(self.started[0][-2:], ["launch", path])
        self.assertFalse(os.path.exists(os.path.join(self.state, "launchers")))


if __name__ == "__main__":
    unittest.main()
