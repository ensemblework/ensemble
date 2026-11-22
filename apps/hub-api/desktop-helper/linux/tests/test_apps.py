import os
import unittest

from desktop_helper import apps, sessionenv


class UnitTests(unittest.TestCase):
    def test_application_ids_from_systemd_units(self):
        cases = {
            "app-gnome-org.gnome.Calculator-12345.scope": "org.gnome.Calculator",
            "app-gnome-org.gnome.Evolution\\x2dalarm\\x2dnotify-2780.scope": "org.gnome.Evolution-alarm-notify",
            "app-cursor-3587639.scope": "cursor",
            "app-ensemble-org.gnome.TextEditor-1a2b3c4d.scope": "org.gnome.TextEditor",
            "snap.firefox.firefox-f079e53f-6ec6-4a82-ac5d-e7f29b987375.scope": "firefox_firefox",
            "app-gnome-org.gnome.Nautilus@12345.service": "org.gnome.Nautilus",
            "app-dbus\\x2d:1.2\\x2dorg.freedesktop.portal.IBus@0.service": None,
            "session-2.scope": None,
        }
        for unit, expected in cases.items():
            with self.subTest(unit=unit):
                self.assertEqual(apps.app_id_from_unit(unit), expected)

    def test_application_id_from_a_cgroup_file(self):
        text = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-org.gnome.Calculator-4242.scope\n"
        self.assertEqual(apps.app_id_from_cgroup(text), "org.gnome.Calculator")
        self.assertIsNone(apps.app_id_from_cgroup("0::/user.slice/user-1000.slice/session-2.scope\n"))

    def test_unit_names_escape_what_systemd_needs(self):
        self.assertEqual(apps.escape_unit("org.gnome.Text-Editor"), "org.gnome.Text\\x2dEditor")
        self.assertEqual(apps.unescape_unit(apps.escape_unit("a-b c")), "a-b c")

    def test_launch_uses_a_scope_of_its_own_when_systemd_can(self):
        command = apps.launch_command("/usr/share/applications/org.gnome.Calculator.desktop", "org.gnome.Calculator", systemd_run="/usr/bin/systemd-run", gio="/usr/bin/gio")
        self.assertEqual(command[:5], ["/usr/bin/systemd-run", "--user", "--scope", "--collect", "--quiet"])
        self.assertTrue(command[5].startswith("--unit=app-ensemble-org.gnome.Calculator-"))
        self.assertEqual(apps.app_id_from_unit(command[5][len("--unit="):] + ".scope"), "org.gnome.Calculator")
        self.assertEqual(command[-3:], ["/usr/bin/gio", "launch", "/usr/share/applications/org.gnome.Calculator.desktop"])
        self.assertEqual(apps.launch_command("/x.desktop", "x", systemd_run="", gio="/usr/bin/gio"), ["/usr/bin/gio", "launch", "/x.desktop"])

    def test_entries_that_start_their_app_in_a_sandbox(self):
        cases = (
            ("/var/lib/snapd/desktop/applications/firefox_firefox.desktop", {"Exec": "env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop /snap/bin/firefox %u"}, "snap"),
            ("/usr/share/applications/firefox.desktop", {"Exec": "/snap/bin/firefox %u"}, "snap"),
            ("/usr/share/applications/snap-handle-link.desktop", {"Exec": "/usr/bin/snap handle-link %U"}, "snap"),
            ("/home/mira/.local/share/applications/notes.desktop", {"Exec": "notes", "X-SnapInstanceName": "notes"}, "snap"),
            ("/var/lib/flatpak/exports/share/applications/org.example.Flat.desktop", {"Exec": "/usr/bin/flatpak run --branch=stable org.example.Flat"}, "Flatpak"),
            ("/usr/share/applications/flat.desktop", {"Exec": "flat", "X-Flatpak": "org.example.Flat"}, "Flatpak"),
            ("/usr/share/applications/org.gnome.Calculator.desktop", {"Exec": "gnome-calculator"}, None),
            ("/usr/share/applications/org.gnome.Ptyxis.desktop", {"Exec": "env GDK_DEBUG=portals ptyxis --new-window"}, None),
        )
        for path, entry, expected in cases:
            with self.subTest(path=path):
                self.assertEqual(apps.sandbox_of(path, entry), expected)

    def test_an_app_that_starts_by_dbus_gets_a_copy_that_starts_it_from_its_command_line(self):
        import tempfile

        text = "[Desktop Entry]\nName=Terminal\nName[de]=Terminal\nExec=ptyxis\nDBusActivatable=true\n\n[Desktop Action new-window]\nName=New Window\nExec=ptyxis --new-window\n"
        entry = apps.desktop_entry(text)
        self.assertTrue(apps.dbus_activatable(entry))
        self.assertEqual(entry["Name"], "Terminal")
        with tempfile.TemporaryDirectory() as folder:
            path = apps.exec_entry(text, "org.gnome.Ptyxis.desktop", os.path.join(folder, "launchers"))
            self.assertEqual(path, os.path.join(folder, "launchers", "org.gnome.Ptyxis.desktop"))
            with open(path, encoding="utf-8") as handle:
                copy = handle.read()
            self.assertFalse(apps.dbus_activatable(apps.desktop_entry(copy)))
            self.assertEqual(apps.desktop_entry(copy)["Exec"], "ptyxis")
            self.assertIn("Exec=ptyxis --new-window", copy)
            self.assertIsNone(apps.exec_entry("[Desktop Entry]\nName=Clocks\nDBusActivatable=true\n", "org.gnome.Clocks.desktop", folder), "nothing to run")
            self.assertIsNone(apps.exec_entry(text, "../evil.desktop", folder))
        self.assertEqual(apps.object_path("org.gnome.font-viewer"), "/org/gnome/font_viewer")

    def test_the_catalogue_says_which_apps_start_in_a_sandbox(self):
        import json
        import subprocess
        import sys
        import tempfile

        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as data:
            folder = os.path.join(data, "applications")
            os.makedirs(folder)
            for name, extra in (("org.example.Plain", ""), ("org.example.Snappy", "X-SnapInstanceName=snappy\n")):
                with open(os.path.join(folder, f"{name}.desktop"), "w") as handle:
                    handle.write(f"[Desktop Entry]\nType=Application\nName={name}\nExec=true\n{extra}")
            probe = "import json; from desktop_helper.apps import catalogue; print(json.dumps({app['id']: app['sandbox'] for app in catalogue()}))"
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "XDG_DATA_HOME": home, "XDG_DATA_DIRS": data, "PYTHONPATH": os.path.dirname(os.path.dirname(os.path.abspath(__file__)))}
            ran = subprocess.run([sys.executable, "-c", probe], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(json.loads(ran.stdout or "{}"), {"org.example.Plain": None, "org.example.Snappy": "snap"}, ran.stderr[-300:])

    def test_queries_match_ids_names_and_programs(self):
        entry = {"id": "org.gnome.Calculator", "name": "Calculator", "exec": "gnome-calculator", "generic": ""}
        self.assertEqual(apps.match_score("org.gnome.Calculator", entry), 3)
        self.assertEqual(apps.match_score("calculator", entry), 3)
        self.assertEqual(apps.match_score("gnome-calculator", entry), 2)
        self.assertEqual(apps.match_score("calc", entry), 1)
        self.assertEqual(apps.match_score("terminal", entry), 0)
        self.assertTrue(apps.matches_running("org.gnome.Calculator", ["gnome-calculator"], "gnome-calculator"))
        self.assertFalse(apps.matches_running("org.gnome.Calculator", ["Firefox"], "gnome-calculator"))


class SessionEnvTests(unittest.TestCase):
    def test_only_missing_session_keys_come_from_the_manager(self):
        manager = lambda: ["WAYLAND_DISPLAY=wayland-0", "DISPLAY=:0", "SECRET_TOKEN=nope", "XDG_CURRENT_DESKTOP=GNOME", "BROKEN"]
        env = sessionenv.complete({"HOME": "/home/x", "XDG_CURRENT_DESKTOP": "ubuntu:GNOME"}, manager)
        self.assertEqual(env["WAYLAND_DISPLAY"], "wayland-0")
        self.assertEqual(env["XDG_CURRENT_DESKTOP"], "ubuntu:GNOME")
        self.assertNotIn("SECRET_TOKEN", env)

    def test_a_failing_manager_changes_nothing(self):
        def broken():
            raise RuntimeError("no bus")
        self.assertEqual(sessionenv.complete({"A": "1"}, broken), {"A": "1"})


if __name__ == "__main__":
    unittest.main()
